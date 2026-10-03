import { test, describe } from "node:test";
import assert from "node:assert";
import {
  ChatGptDeltaV1Decoder,
  parseEncodedItem,
} from "../../src/providers/chatgpt/deltaV1.ts";
import {
  validateAndNormalizeStorageState,
  parseCookieHeaderToStorageState,
} from "../../src/providers/chatgpt/storageState.ts";
import {
  parseHandoffBootstrap,
  ChatGptTopicStream,
} from "../../src/providers/chatgpt/transport.ts";
import { ChatGptWebAdapter } from "../../src/providers/chatgpt/adapter.ts";
import { chatGptCatalogDeps } from "../fixtures/chatgptModels.ts";
import {
  CredentialError,
  UpstreamDriftError,
} from "../../src/shared/errors.ts";

describe("ChatGPT Web: Delta V1 Decoder", () => {
  test("reconstructs assistant message from add and append frames", () => {
    const decoder = new ChatGptDeltaV1Decoder();

    // 1. Initial version
    const r1 = decoder.ingest('event: delta_encoding\ndata: "v1"\n\n');
    assert.strictEqual(r1.done, false);

    // 2. Add message base document
    const frame1 =
      'event: delta\ndata: {"p":"","o":"add","v":{"message":{"id":"msg_1","author":{"role":"assistant"},"content":{"parts":["The answer"]},"status":"in_progress"}}}\n\n';
    const r2 = decoder.ingest(frame1);
    assert.strictEqual(r2.assistantText, "The answer");
    assert.strictEqual(r2.done, false);

    // 3. Append text to parts/0
    const frame2 =
      'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":" is 42."}\n\n';
    const r3 = decoder.ingest(frame2);
    assert.strictEqual(r3.assistantText, "The answer is 42.");
    assert.strictEqual(r3.done, false);

    // 4. End turn status update
    const frame3 =
      'event: delta\ndata: {"p":"/message/status","o":"replace","v":"finished_successfully"}\n\nevent: delta\ndata: {"p":"/message/end_turn","o":"add","v":true}\n\ndata: [DONE]\n\n';
    const r4 = decoder.ingest(frame3);
    assert.strictEqual(r4.assistantText, "The answer is 42.");
    assert.strictEqual(r4.done, true);
  });

  test("handles JSON Pointer escaping (~0, ~1)", () => {
    const decoder = new ChatGptDeltaV1Decoder();
    decoder.ingest('event: delta_encoding\ndata: "v1"\n\n');
    decoder.ingest(
      'event: delta\ndata: {"p":"","o":"add","v":{"a/b":{"c~d":"hello"}}}\n\n',
    );
    decoder.ingest(
      'event: delta\ndata: {"p":"/a~1b/c~0d","o":"append","v":" world"}\n\n',
    );
    const doc = decoder.getDocument() as any;
    assert.strictEqual(doc["a/b"]["c~d"], "hello world");
  });

  test("rejects prototype pollution pointers", () => {
    const decoder = new ChatGptDeltaV1Decoder();
    decoder.ingest('event: delta_encoding\ndata: "v1"\n\n');
    assert.throws(
      () =>
        decoder.ingest(
          'event: delta\ndata: {"p":"/__proto__/admin","o":"add","v":true}\n\n',
        ),
      UpstreamDriftError,
    );
  });
});

describe("ChatGPT Web: Storage State & Credentials", () => {
  test("accepts valid cookie header and normalizes domain", () => {
    const header =
      "__Secure-next-auth.session-token=sess_token_123; cf_clearance=cf_123";
    const state = parseCookieHeaderToStorageState(header);
    assert.strictEqual(state.cookies.length, 2);
    assert.strictEqual(
      state.cookies[0].name,
      "__Secure-next-auth.session-token",
    );
    assert.strictEqual(state.cookies[0].domain, ".chatgpt.com");
    assert.strictEqual(state.cookies[0].secure, true);
  });

  test("rejects storage state with foreign cookie domain (security enclosure)", () => {
    const foreignState = {
      cookies: [
        {
          name: "session",
          value: "val",
          domain: "evil.com",
          path: "/",
        },
      ],
      origins: [{ origin: "https://chatgpt.com", localStorage: [] }],
    };
    assert.throws(
      () => validateAndNormalizeStorageState(foreignState),
      CredentialError,
    );
  });

  test("rejects storage state with foreign origin", () => {
    const foreignState = {
      cookies: [
        {
          name: "session",
          value: "val",
          domain: "chatgpt.com",
          path: "/",
        },
      ],
      origins: [{ origin: "https://attacker.com", localStorage: [] }],
    };
    assert.throws(
      () => validateAndNormalizeStorageState(foreignState),
      CredentialError,
    );
  });
});

describe("ChatGPT Web: Adapter & Transport Handoff", () => {
  const bootstrap =
    'data: {"type":"resume_conversation_token","conversation_id":"fixture-conversation","token":"fixture-resume"}\n\ndata: {"type":"stream_handoff","conversation_id":"fixture-conversation","turn_exchange_id":"fixture-turn","options":[{"type":"subscribe_ws_topic","topic_id":"fixture-topic"},{"type":"resume_sse_endpoint","topic_id":"fixture-topic"}]}\n\n';
  test("detects native handoff and rejects inconsistent topics", () => {
    assert.strictEqual(
      parseHandoffBootstrap(bootstrap)?.websocketTopicId,
      "fixture-topic",
    );
    assert.throws(() =>
      parseHandoffBootstrap(
        bootstrap.replace(
          '"resume_sse_endpoint","topic_id":"fixture-topic"',
          '"resume_sse_endpoint","topic_id":"other-topic"',
        ),
      ),
    );
  });
  test("never returns a canned answer when transport is missing", async () => {
    await assert.rejects(
      new ChatGptWebAdapter(chatGptCatalogDeps()).execute(
        {
          model: "chatgpt-web:5.7",
          messages: [{ role: "user", content: "Hello" }],
        },
        "session=fixture",
      ),
      /transport is not configured/,
    );
  });
  test("translates thinking selection and closes owned session after successful turn", async () => {
    let closed = false;
    const adapter = new ChatGptWebAdapter({
      ...chatGptCatalogDeps(),
      transportFactory: async () => ({
        async executeDirectTurn(payload: unknown) {
          assert.ok(
            payload &&
              typeof payload === "object" &&
              "selection" in payload &&
              "prompt" in payload,
          );
          const input = payload;
          assert.deepStrictEqual(input.selection, {
            model: "native-deliberate-route",
            thinkingEffort: "extended",
          });
          assert.strictEqual(input.prompt, "USER: What is 2+2?");
          return 'event: delta_encoding\ndata: "v1"\n\nevent: delta\ndata: {"p":"","o":"add","v":{"message":{"author":{"role":"assistant"},"content":{"parts":["Four."]},"status":"finished_successfully","end_turn":true}}}\n\ndata: [DONE]\n\n';
        },
        async executeWebSocketTurn() {
          throw new Error("Unexpected handoff");
        },
        async close() {
          closed = true;
        },
      }),
    });
    const response = await adapter.execute(
      {
        model: "chatgpt-web:5.7",
        reasoning_effort: "high",
        messages: [{ role: "user", content: "What is 2+2?" }],
      },
      "session=fixture",
    );
    assert.ok("choices" in response);
    assert.strictEqual(response.choices[0].message.content, "Four.");
    assert.strictEqual(response.choices[0].finish_reason, "stop");
    assert.strictEqual(closed, true);
  });
  test("handoff retains its direct document prefix across an unterminated SSE boundary", async () => {
    const prefix = [
      'event: delta_encoding\ndata: "v1"\n\n',
      'data: {"p":"","o":"add","v":{"message":{"author":{"role":"assistant"},"content":{"parts":["Part"]},"status":"in_progress","end_turn":false}}}\n\n',
      'data: {"type":"resume_conversation_token","token":"fixture-resume","conversation_id":"fixture-conversation"}\n\n',
      'data: {"type":"stream_handoff","conversation_id":"fixture-conversation","turn_exchange_id":"fixture-turn","options":[{"type":"subscribe_ws_topic","topic_id":"fixture-topic"},{"type":"resume_sse_endpoint","topic_id":"fixture-topic"}]}',
    ].join("");
    const adapter = new ChatGptWebAdapter({
      ...chatGptCatalogDeps(),
      transportSession: {
        executeDirectTurn: async () => prefix,
        executeWebSocketTurn: async () =>
          'data: {"p":"/message/content/parts/0","o":"append","v":" two"}\n\ndata: {"p":"","o":"patch","v":[{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/end_turn","o":"replace","v":true}]}\n\ndata: [DONE]\n\n',
      },
    });
    const result = await adapter.execute(
      {
        model: "chatgpt-web:5.7",
        messages: [{ role: "user", content: "fixture" }],
      },
      "session=fixture",
    );
    assert.ok("choices" in result);
    assert.equal(result.choices[0].message.content, "Part two");
    assert.equal(result.choices[0].finish_reason, "stop");
  });

  test("demultiplexes catchups and ignores other topics and duplicate stream items", () => {
    const stream = new ChatGptTopicStream("fixture-topic");
    const item = {
      type: "message",
      topic_id: "fixture-topic",
      payload: {
        type: "conversation-turn-stream",
        payload: {
          type: "stream-item",
          stream_item_id: "one",
          encoded_item: "data: fixture\n\n",
        },
      },
    };
    assert.deepStrictEqual(
      stream.ingestFrame(
        JSON.stringify([
          { ...item, topic_id: "other" },
          { type: "reply", reply: { catchups: [item] } },
          item,
        ]),
      ).encodedItems,
      ["data: fixture\n\n"],
    );
    assert.strictEqual(
      stream.ingestFrame(
        JSON.stringify([
          {
            type: "message",
            topic_id: "fixture-topic",
            payload: {
              type: "conversation-turn-stream",
              payload: { type: "done" },
            },
          },
        ]),
      ).done,
      true,
    );
  });
});
