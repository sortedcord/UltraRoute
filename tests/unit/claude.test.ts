import { test, describe } from "node:test";
import assert from "node:assert";
import { ClaudeSseDecoder } from "../../src/providers/claude/stream.ts";
import {
  normalizeClaudeSessionCookie,
  buildClaudeCookieHeader,
} from "../../src/providers/claude/credentials.ts";
import { transformToClaudePayload } from "../../src/providers/claude/payload.ts";
import {
  ClaudeWebAdapter,
  MockClaudeWebTransport,
} from "../../src/providers/claude/adapter.ts";
import { SseStreamDecoder } from "../../src/shared/sseDecoder.ts";
import { CredentialError } from "../../src/shared/errors.ts";

describe("Claude Web: SSE Decoder", () => {
  test("decodes text and thinking deltas", () => {
    const sse = new SseStreamDecoder();
    const decoder = new ClaudeSseDecoder();

    const raw = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_456"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me ponder..."}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"The answer is 42."}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    for (const evt of sse.feed(raw)) {
      decoder.processEvent(evt);
    }

    const res = decoder.getResult();
    assert.strictEqual(res.isComplete, true);
    assert.strictEqual(res.assistantText, "The answer is 42.");
    assert.strictEqual(res.reasoningText, "Let me ponder...");
    assert.strictEqual(res.stopReason, "stop");
    assert.strictEqual(res.messageUuid, "msg_456");
  });

  test("decodes partial tool JSON and completes tool call", () => {
    const sse = new SseStreamDecoder();
    const decoder = new ClaudeSseDecoder();

    const raw = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_abc","name":"get_weather"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"location\\": "}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"Paris\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    for (const evt of sse.feed(raw)) {
      decoder.processEvent(evt);
    }

    const res = decoder.getResult();
    assert.strictEqual(res.toolCalls.length, 1);
    assert.strictEqual(res.toolCalls[0].id, "call_abc");
    assert.strictEqual(res.toolCalls[0].function.name, "get_weather");
    assert.strictEqual(
      res.toolCalls[0].function.arguments,
      '{"location": "Paris"}',
    );
    assert.strictEqual(res.stopReason, "tool_calls");
  });

  test("synthesizes idle finish when web turn hangs open after tool_use", () => {
    const sse = new SseStreamDecoder();
    const decoder = new ClaudeSseDecoder({ toolUseIdleFinishMs: 100 });

    const raw = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_123","name":"exec_code"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    ].join("");

    for (const evt of sse.feed(raw)) {
      decoder.processEvent(evt);
    }

    // Immediately, idle finish shouldn't trigger
    assert.strictEqual(decoder.checkIdleFinish(Date.now()), false);

    // After idle window expires
    const futureTime = Date.now() + 200;
    assert.strictEqual(decoder.checkIdleFinish(futureTime), true);

    const res = decoder.getResult();
    assert.strictEqual(res.isComplete, true);
    assert.strictEqual(res.stopReason, "tool_calls");
    assert.strictEqual(res.toolCalls.length, 1);
  });
});

describe("Claude Web: Credentials and Payload", () => {
  test("extracts sessionKey from cookie header", () => {
    const creds = normalizeClaudeSessionCookie(
      "sessionKey=sk-ant-sid-12345; device-id=dev-999",
    );
    assert.strictEqual(creds.sessionKey, "sk-ant-sid-12345");
    assert.strictEqual(creds.deviceId, "dev-999");

    const header = buildClaudeCookieHeader(creds);
    assert.strictEqual(
      header,
      "sessionKey=sk-ant-sid-12345; device-id=dev-999",
    );
  });

  test("transforms reasoning effort into thinking mode", () => {
    const payload = transformToClaudePayload(
      {
        model: "claude-3-7-sonnet",
        reasoning_effort: "high",
        messages: [{ role: "user", content: "Solve this riddle" }],
      },
      "claude-3-7-sonnet",
    );

    assert.strictEqual(payload.effort, "high");
    assert.strictEqual(payload.thinking_mode, "enabled");
    assert.strictEqual(payload.prompt, "Solve this riddle");
  });
});

describe("Claude Web: Adapter & Multi-Turn Continuation", () => {
  test("maintains state across multi-turn requests with account isolation", async () => {
    let capturedPayload: any = null;
    let bootstrapLoads = 0;
    const transport = new MockClaudeWebTransport(
      async () => [{ id: "org-1", name: "Main Org" }],
      async (p) => {
        capturedPayload = p;
        return [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_turn_1"}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Nice to meet you!"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join("");
      },
      async () => {
        bootstrapLoads++;
        return {
          model_selector_config: [
            {
              id: "chat",
              models: [
                { id: "claude-3-7-sonnet", name: "Test Sonnet", section: "main" },
              ],
            },
          ],
        };
      },
    );

    const adapter = new ClaudeWebAdapter({ transport });
    let organizationLoads = 0;
    const originalOrganizations = transport.fetchOrganizations.bind(transport);
    transport.fetchOrganizations = async (...args) => { organizationLoads++; return originalOrganizations(...args); };
    const creds = "sessionKey=sk-ant-accountA";

    // Turn 1
    const r1 = (await adapter.execute(
      {
        model: "claude-3-7-sonnet",
        messages: [{ role: "user", content: "Hi, I am Bob." }],
      },
      creds,
    )) as any;
    assert.strictEqual(capturedPayload.parent_message_uuid, undefined);

    // Turn 2 with same account
    await adapter.execute(
      {
        model: "claude-3-7-sonnet",
        messages: [
          { role: "user", content: "Hi, I am Bob." },
          { role: "assistant", content: "Nice to meet you!" },
          { role: "user", content: "What is my name?" },
        ],
      },
      creds,
    );
    assert.strictEqual(capturedPayload.parent_message_uuid, "msg_turn_1");

    // Turn 2 with DIFFERENT account (accountB) MUST NOT reuse accountA's parent_message_uuid
    const credsB = "sessionKey=sk-ant-accountB";
    await adapter.execute(
      {
        model: "claude-3-7-sonnet",
        messages: [
          { role: "user", content: "Hi, I am Bob." },
          { role: "assistant", content: "Nice to meet you!" },
          { role: "user", content: "What is my name?" },
        ],
      },
      credsB,
    );
    assert.equal(organizationLoads, 2);
    assert.equal(bootstrapLoads, 2);
  });
});
