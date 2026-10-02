import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readUIMessageStream } from "ai";
import type { UIMessage, UIMessageChunk } from "ai";
import type {
  ChatCompletionResponse,
  ChatCompletionChunk,
} from "../../src/shared/types.ts";
import {
  ChallengeRequiredError,
  GenericUpstreamError,
  ProviderTimeoutError,
} from "../../src/shared/errors.ts";
import {
  createProviderUIMessageStreamResponse,
  publicChatError,
  awaitWithAbort,
} from "../../src/server/uiStream.ts";

function completion(
  overrides: Partial<ChatCompletionResponse["choices"][number]> = {},
): ChatCompletionResponse {
  return {
    id: "response",
    object: "chat.completion",
    created: 0,
    model: "test",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello" },
        finish_reason: "stop",
        ...overrides,
      },
    ],
    usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
  };
}

function chunk(
  delta: ChatCompletionChunk["choices"][number]["delta"],
  reason: ChatCompletionChunk["choices"][number]["finish_reason"] = null,
): ChatCompletionChunk {
  return {
    id: "response",
    object: "chat.completion.chunk",
    created: 0,
    model: "test",
    choices: [{ index: 0, delta, finish_reason: reason }],
  };
}

// Decode the actual HTTP SSE body, then exercise the installed AI SDK consumer.
async function consume(response: Response) {
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("x-vercel-ai-ui-message-stream"), "v1");
  const raw = await response.text();
  assert.ok(raw.endsWith("data: [DONE]\n\n"));
  const chunks: UIMessageChunk[] = raw.split("\n\n").flatMap((frame) => {
    if (!frame.startsWith("data: ") || frame === "data: [DONE]") return [];
    return [JSON.parse(frame.slice(6)) as UIMessageChunk];
  });
  const errors: unknown[] = [];
  let message: UIMessage | undefined;
  for await (const update of readUIMessageStream({
    stream: new ReadableStream<UIMessageChunk>({
      start(controller) {
        chunks.forEach((value) => controller.enqueue(value));
        controller.close();
      },
    }),
    onError: (error) => errors.push(error),
  }))
    message = structuredClone(update);
  return { message, errors, chunks, raw };
}

describe("Chat server AI SDK UI SSE conversion", () => {
  test("buffered text, reasoning, finish reason, and usage survive the SDK reader", async () => {
    const { message, chunks, errors } = await consume(
      createProviderUIMessageStreamResponse(
        completion({
          message: {
            role: "assistant",
            content: "Final answer",
            reasoning_content: "Consider the constraints",
          },
          finish_reason: "length",
        }),
      ),
    );
    assert.deepEqual(
      message?.parts.flatMap((part) =>
        part.type === "text" || part.type === "reasoning"
          ? [{ type: part.type, text: part.text, state: part.state }]
          : [],
      ),
      [
        { type: "reasoning", text: "Consider the constraints", state: "done" },
        { type: "text", text: "Final answer", state: "done" },
      ],
    );
    assert.deepEqual(message?.metadata, {
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    });
    assert.equal(
      chunks.find((value) => value.type === "finish")?.finishReason,
      "length",
    );
    assert.deepEqual(errors, []);
  });
  test("streamed deltas preserve reasoning and assemble dynamic tool inputs", async () => {
    async function* source() {
      yield chunk({ reasoning_content: "Think " });
      yield chunk({ reasoning_content: "carefully", content: "Looking " });
      yield chunk({
        content: "up",
        tool_calls: [
          {
            index: 0,
            id: "call-1",
            type: "function",
            function: { name: "weather", arguments: '{"city":' },
          },
        ],
      });
      yield chunk(
        { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] },
        "tool_calls",
      );
    }
    const { message, chunks, errors } = await consume(
      createProviderUIMessageStreamResponse(source()),
    );
    assert.deepEqual(
      message?.parts.flatMap((part) =>
        part.type === "text" || part.type === "reasoning"
          ? [{ type: part.type, text: part.text, state: part.state }]
          : [],
      ),
      [
        { type: "reasoning", text: "Think carefully", state: "done" },
        { type: "text", text: "Looking up", state: "done" },
      ],
    );
    const tool = message?.parts.find((part) => part.type === "dynamic-tool");
    assert.equal(tool?.toolName, "weather");
    assert.equal(tool?.toolCallId, "call-1");
    assert.equal(tool?.state, "input-available");
    assert.deepEqual(tool?.input, { city: "Paris" });
    assert.equal(
      chunks.find((value) => value.type === "finish")?.finishReason,
      "tool-calls",
    );
    assert.deepEqual(errors, []);
  });
  test("buffered tool calls and invalid arguments have visible SDK tool states", async () => {
    const result = completion({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "good",
            type: "function",
            function: { name: "search", arguments: '{"query":"news"}' },
          },
          {
            id: "bad",
            type: "function",
            function: { name: "search", arguments: "not json" },
          },
        ],
      },
      finish_reason: "tool_calls",
    });
    const { message } = await consume(
      createProviderUIMessageStreamResponse(result),
    );
    const tools = message?.parts.filter((part) => part.type === "dynamic-tool");
    assert.equal(tools?.[0]?.toolCallId, "good");
    assert.equal(tools?.[0]?.toolName, "search");
    assert.equal(tools?.[0]?.state, "input-available");
    assert.deepEqual(tools?.[0]?.input, { query: "news" });
    assert.equal(tools?.[1]?.toolCallId, "bad");
    assert.equal(tools?.[1]?.state, "output-error");
    assert.equal(tools?.[1]?.input, "not json");
    assert.equal(
      tools?.[1]?.state === "output-error" && tools[1].errorText,
      "The provider returned invalid tool arguments.",
    );
  });
  test("mid-stream failures preserve partial output and emit only sanitized public errors", async () => {
    async function* source() {
      yield chunk({ content: "Partial answer" });
      throw new GenericUpstreamError("secret-cookie=never-return-this");
    }
    const { message, errors, chunks, raw } = await consume(
      createProviderUIMessageStreamResponse(source()),
    );
    const text = message?.parts.find((part) => part.type === "text");
    assert.equal(text?.text, "Partial answer");
    assert.equal(text?.state, "done");
    assert.equal(errors.length, 1);
    assert.equal(
      chunks.find((value) => value.type === "error")?.errorText,
      "The provider request failed. Check the browser bridge and try again.",
    );
    assert.equal(
      chunks.find((value) => value.type === "finish")?.finishReason,
      "error",
    );
    assert.equal(raw.includes("secret-cookie"), false);
  });
  test("a truncated provider iterator cannot masquerade as a successful answer", async () => {
    async function* source() {
      yield chunk({ content: "Incomplete" });
    }
    const { chunks, errors } = await consume(
      createProviderUIMessageStreamResponse(source()),
    );
    assert.equal(errors.length, 1);
    assert.equal(
      chunks.find((value) => value.type === "finish")?.finishReason,
      "error",
    );
  });
  test("content filtering is mapped to the SDK finish reason without leaking alternate candidates", async () => {
    const response = completion({ finish_reason: "content_filter" });
    response.choices.push({
      index: 1,
      message: { role: "assistant", content: "Alternate candidate" },
      finish_reason: "stop",
    });
    const { message, chunks } = await consume(
      createProviderUIMessageStreamResponse(response),
    );
    assert.equal(
      message?.parts.find((part) => part.type === "text")?.text,
      "Hello",
    );
    assert.equal(
      chunks.find((value) => value.type === "finish")?.finishReason,
      "content-filter",
    );
  });
  test("timeouts interrupt pending iterators and return a clean, sanitized UI failure", async () => {
    const controller = new AbortController();
    let notifyWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => {
      notifyWaiting = resolve;
    });
    async function* source() {
      yield chunk({ content: "Before timeout" });
      notifyWaiting();
      await new Promise<void>(() => {});
    }
    const response = createProviderUIMessageStreamResponse(
      source(),
      controller.signal,
    );
    const consumed = consume(response);
    await waiting;
    controller.abort(new ProviderTimeoutError("sensitive timeout context"));
    const { errors, chunks, raw } = await consumed;
    assert.equal(errors.length, 1);
    assert.equal(
      chunks.find((value) => value.type === "error")?.errorText,
      "The provider request timed out. Please try again.",
    );
    assert.equal(raw.includes("sensitive timeout"), false);
  });
  test("authentication classification never treats ordinary browser failures as expired credentials", () => {
    assert.equal(
      publicChatError(new Error("Browser navigation failed with secret URL"))
        .code,
      "GENERIC_UPSTREAM_FAILURE",
    );
    assert.equal(
      publicChatError(new ChallengeRequiredError("sensitive challenge HTML"))
        .status,
      403,
    );
    assert.equal(
      publicChatError(new ProviderTimeoutError("sensitive context")).status,
      504,
    );
  });
  test("aborting before provider completion rejects a pending operation", async () => {
    const controller = new AbortController();
    const pending = awaitWithAbort(
      new Promise<void>(() => {}),
      controller.signal,
    );
    controller.abort(new DOMException("Disconnected", "AbortError"));
    await assert.rejects(pending, { name: "AbortError" });
  });
});
