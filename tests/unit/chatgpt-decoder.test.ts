import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ChatGptDeltaV1Decoder,
  parseEncodedItem,
} from "../../src/providers/chatgpt/deltaV1.ts";
import { UpstreamDriftError } from "../../src/shared/errors.ts";

function frame(payload: unknown, event?: string): string {
  return `${event ? `event: ${event}\n` : ""}data: ${payload === "[DONE]" ? payload : JSON.stringify(payload)}\n\n`;
}

function message(
  text: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "fixture-assistant",
    author: { role: "assistant" },
    channel: "final",
    recipient: "all",
    content: { content_type: "text", parts: [text] },
    status: "in_progress",
    end_turn: false,
    ...overrides,
  };
}

function initial(text = ""): string {
  return (
    frame("v1", "delta_encoding") +
    frame({ p: "", o: "add", v: { message: message(text) } }, "delta")
  );
}

function terminal(): string {
  return frame(
    {
      p: "",
      o: "patch",
      v: [
        { p: "/message/status", o: "replace", v: "finished_successfully" },
        { p: "/message/end_turn", o: "replace", v: true },
      ],
    },
    "delta",
  );
}

describe("ChatGPT decoder consumer-visible fixtures", () => {
  test("reconstructs compact data-only path and operation inheritance", () => {
    const decoder = new ChatGptDeltaV1Decoder();
    const result = decoder.ingest(
      initial("The") +
        frame({ p: "/message/content/parts/0", o: "append", v: " answer" }) +
        frame({ v: " is 42." }) +
        terminal() +
        frame("[DONE]"),
    );
    assert.equal(result.assistantText, "The answer is 42.");
    assert.equal(result.status, "finished_successfully");
    assert.equal(result.done, true);
  });

  test("inherits path and operation independently without patch entries changing them", () => {
    const decoder = new ChatGptDeltaV1Decoder();
    decoder.ingest(
      initial("First") +
        frame({ p: "/message/content/parts/0", o: "append", v: " draft" }),
    );
    decoder.ingest(frame({ o: "replace", v: "Revised" }));
    const replaced = decoder.ingest(
      frame({ p: "/message/status", v: "finished_successfully" }),
    );
    assert.equal(replaced.assistantText, "Revised");
    assert.equal(replaced.status, "finished_successfully");
    assert.equal(replaced.done, false);
    decoder.ingest(
      frame({
        p: "",
        o: "patch",
        v: [{ p: "/message/content/parts/0", o: "append", v: " answer" }],
      }),
    );
    const final = decoder.ingest(
      frame({ v: [{ p: "/message/end_turn", o: "replace", v: true }] }),
    );
    assert.equal(final.assistantText, "Revised answer");
    assert.equal(final.done, true);
  });

  test("an incomplete UTF-8 tail cannot certify an already finished turn", () => {
    const decoder = new ChatGptDeltaV1Decoder();
    const bytes = new TextEncoder().encode(initial("Ready") + terminal());
    const incomplete = new Uint8Array(bytes.length + 1);
    incomplete.set(bytes);
    incomplete[bytes.length] = 0xf0;
    assert.equal(decoder.ingest(incomplete).assistantText, "Ready");
    assert.equal(decoder.isTurnFinished(), false);
    assert.throws(() => decoder.ingest(""), {
      name: "UpstreamDriftError",
      message: "Malformed UTF-8 in ChatGPT SSE",
    });
  });

  test("requires both successful status and boolean end_turn on the assistant", () => {
    for (const overrides of [
      { status: "in_progress", end_turn: true },
      { status: "finished_successfully", end_turn: false },
      { status: "finished_successfully", end_turn: "true" },
      { status: "failed", end_turn: true },
    ]) {
      const decoder = new ChatGptDeltaV1Decoder();
      const result = decoder.ingest(
        frame({ message: message("partial", overrides) }) + frame("[DONE]"),
      );
      assert.equal(result.done, false);
      assert.equal(result.assistantText, "partial");
    }
    const decoder = new ChatGptDeltaV1Decoder();
    assert.equal(decoder.ingest(frame("[DONE]")).done, false);
    assert.equal(
      decoder.ingest(
        frame({
          message: message("answer", {
            status: "finished_successfully",
            end_turn: true,
          }),
        }),
      ).done,
      true,
    );
  });

  test("does not expose user, tool, reasoning, or tool-directed assistant messages", () => {
    for (const overrides of [
      { author: { role: "user" } },
      { author: { role: "tool" } },
      { author: undefined },
      { channel: "analysis" },
      { channel: "commentary" },
      { channel: undefined, metadata: { channel: "analysis" } },
      { recipient: "python" },
    ]) {
      const decoder = new ChatGptDeltaV1Decoder();
      const result = decoder.ingest(
        frame({
          message: message("private fixture", {
            status: "finished_successfully",
            end_turn: true,
            ...overrides,
          }),
        }) + frame("[DONE]"),
      );
      assert.equal(result.assistantText, "");
      assert.equal(result.status, undefined);
      assert.equal(result.done, false);
    }
  });

  test("collects only the final answer following a finished reasoning message", () => {
    const decoder = new ChatGptDeltaV1Decoder();
    const reasoning = frame({
      message: message("hidden reasoning", {
        channel: "analysis",
        status: "finished_successfully",
        end_turn: false,
      }),
    });
    decoder.ingest(reasoning);
    assert.equal(decoder.getAssistantText(), "");
    const result = decoder.ingest(
      frame({
        message: message("Public answer", {
          status: "finished_successfully",
          end_turn: true,
        }),
      }) + frame("[DONE]"),
    );
    assert.equal(result.assistantText, "Public answer");
    assert.equal(result.done, true);
  });

  test("later non-assistant frames cannot overwrite a collected terminal answer", () => {
    const decoder = new ChatGptDeltaV1Decoder();
    const result = decoder.ingest(
      initial("Preserved answer") +
        terminal() +
        frame({ message: message("user echo", { author: { role: "user" } }) }) +
        frame({
          p: "",
          o: "replace",
          v: { message: message("tool output", { author: { role: "tool" } }) },
        }) +
        frame("[DONE]"),
    );
    assert.equal(result.assistantText, "Preserved answer");
    assert.equal(result.status, "finished_successfully");
    assert.equal(result.done, true);
  });

  test("accepts final messages without a channel and excludes nontext parts", () => {
    const decoder = new ChatGptDeltaV1Decoder();
    const result = decoder.ingest(
      frame({
        message: message("", {
          channel: undefined,
          content: {
            content_type: "multimodal_text",
            parts: ["First", { asset_pointer: "fixture-image" }, " last"],
          },
          status: "finished_successfully",
          end_turn: true,
        }),
      }),
    );
    assert.equal(result.assistantText, "First last");
    assert.equal(result.done, true);
  });

  test("ordered root patches may contain recursively nested root patches", () => {
    const decoder = new ChatGptDeltaV1Decoder();
    const result = decoder.ingest(
      initial("A") +
        frame({
          p: "",
          o: "patch",
          v: [
            { p: "/message/content/parts/0", o: "append", v: "B" },
            {
              p: "",
              o: "patch",
              v: [
                { p: "/message/content/parts/0", o: "replace", v: "Revised" },
                { p: "/message/content/parts/0", o: "append", v: " answer" },
              ],
            },
            { p: "/message/status", o: "replace", v: "finished_successfully" },
            { p: "/message/end_turn", o: "replace", v: true },
          ],
        }),
    );
    assert.equal(result.assistantText, "Revised answer");
    assert.equal(result.done, true);
  });

  test("root replacement replaces stale content rather than appending to it", () => {
    const decoder = new ChatGptDeltaV1Decoder();
    decoder.ingest(initial("Old"));
    const result = decoder.ingest(
      frame({
        p: "",
        o: "replace",
        v: {
          message: message("New", {
            status: "finished_successfully",
            end_turn: true,
          }),
        },
      }),
    );
    assert.equal(result.assistantText, "New");
    assert.equal(result.done, true);
  });

  test("new encoding resets the answer, completion, and inherited operation", () => {
    const decoder = new ChatGptDeltaV1Decoder();
    decoder.ingest(initial("Old answer") + terminal());
    const reset = decoder.ingest(frame("v1", "delta_encoding"));
    assert.equal(reset.assistantText, "");
    assert.equal(reset.status, undefined);
    assert.equal(reset.done, false);
    assert.throws(
      () => decoder.ingest(frame({ v: "orphan" })),
      UpstreamDriftError,
    );
  });

  test("handles escaped pointers, ordered array insertion, and append boundaries", () => {
    const decoder = new ChatGptDeltaV1Decoder();
    decoder.ingest(
      frame({
        p: "",
        o: "add",
        v: { "a/b": { "c~d": ["first", "last"] }, metadata: { old: true } },
      }),
    );
    decoder.ingest(
      frame({ p: "/a~1b/c~0d/1", o: "add", v: "middle" }) +
        frame({ p: "/a~1b/c~0d/-", o: "add", v: "end" }) +
        frame({ p: "/a~1b/c~0d", o: "append", v: ["extra"] }) +
        frame({ p: "/metadata", o: "append", v: { newer: true } }),
    );
    assert.deepEqual(decoder.getDocument(), {
      "a/b": { "c~d": ["first", "middle", "last", "end", "extra"] },
      metadata: { old: true, newer: true },
    });
    const snapshot = decoder.getDocument() as { metadata: { old: boolean } };
    snapshot.metadata.old = false;
    assert.deepEqual(decoder.getDocument(), {
      "a/b": { "c~d": ["first", "middle", "last", "end", "extra"] },
      metadata: { old: true, newer: true },
    });
  });

  test("retains partial frames instead of completing a truncated response", () => {
    const decoder = new ChatGptDeltaV1Decoder();
    const start = frame({
      message: message("Ready", {
        status: "finished_successfully",
        end_turn: true,
      }),
    });
    const incomplete = frame({
      p: "/message/content/parts/0",
      o: "append",
      v: "!",
    });
    const result = decoder.ingest(start + incomplete.slice(0, -1));
    assert.equal(result.assistantText, "Ready");
    assert.equal(result.done, false);
    const finished = decoder.ingest("\n");
    assert.equal(finished.assistantText, "Ready!");
    assert.equal(finished.done, true);
  });

  test("preserves Unicode and line endings across single-character string chunks", () => {
    const decoder = new ChatGptDeltaV1Decoder();
    const source = (
      initial("첫째 🙂\n") +
      frame({
        p: "/message/content/parts/0",
        o: "append",
        v: "alpha\\beta[gamma]",
      }) +
      terminal()
    ).replace(/\n/g, "\r\n");
    for (let i = 0; i < source.length; i++)
      decoder.ingest(source.slice(i, i + 1));
    assert.equal(decoder.getAssistantText(), "첫째 🙂\nalpha\\beta[gamma]");
    assert.equal(decoder.isTurnFinished(), true);
  });

  test("decodes UTF-8 safely across every possible byte boundary", () => {
    const source = new TextEncoder().encode(
      initial("한글 🙂 café") + terminal(),
    );
    for (let split = 0; split <= source.length; split++) {
      const decoder = new ChatGptDeltaV1Decoder();
      decoder.ingest(source.subarray(0, split));
      const result = decoder.ingest(source.subarray(split));
      assert.equal(result.assistantText, "한글 🙂 café");
      assert.equal(result.done, true);
    }
  });

  test("rejects invalid UTF-8 without returning replacement-character answers", () => {
    const decoder = new ChatGptDeltaV1Decoder();
    assert.throws(() => decoder.ingest(new Uint8Array([0xff])), {
      name: "UpstreamDriftError",
      message: "Malformed UTF-8 in ChatGPT SSE",
    });
  });

  test("parses SSE comments, multiline data, and unterminated complete encoded items", () => {
    const events = parseEncodedItem(
      ': heartbeat\r\nevent: delta\r\ndata: {"p":"",\r\ndata: "o":"add","v":{}}\r\n\r\ndata: [DONE]',
    );
    assert.equal(events[0]?.event, "delta");
    assert.deepEqual(events[0]?.json, { p: "", o: "add", v: {} });
    assert.equal(events[1]?.done, true);
    const decoder = new ChatGptDeltaV1Decoder();
    assert.equal(
      decoder.ingest(
        ": heartbeat\nevent: note\ndata: non-json note\n\n" +
          initial("Answer") +
          terminal(),
      ).assistantText,
      "Answer",
    );
  });

  test("rejects malformed and unsupported frames with sanitized fixed errors", () => {
    const sensitive = "fixture-private-value";
    const malformed = [
      `event: delta\ndata: {${sensitive}\n\n`,
      `data: {${sensitive}\n\n`,
      frame([sensitive], "delta"),
      frame({ p: "", o: sensitive, v: null }),
      frame({ p: sensitive, o: "add", v: sensitive }),
      frame({ p: "/missing/private", o: "replace", v: sensitive }),
      frame({
        p: "/message/content/parts/999999999999999999999",
        o: "replace",
        v: sensitive,
      }),
      frame({ p: "/message/content/parts/-", o: "replace", v: sensitive }),
      frame({ p: "/message/content/parts/0~2", o: "replace", v: sensitive }),
      frame({ p: "/message/content/parts/0", o: "append", v: {} }),
      frame({
        p: "",
        o: "patch",
        v: [{ p: "/message/status", o: sensitive, v: sensitive }],
      }),
      frame({ p: "", o: "patch", v: [{ p: "/message/status", v: sensitive }] }),
      frame({ p: "", o: "patch", v: sensitive }),
      frame({ p: "/message", o: "patch", v: [] }),
      frame({ p: "", o: "replace" }),
      frame({ message: sensitive }),
      frame(sensitive, "delta_encoding"),
    ];
    for (const source of malformed) {
      const decoder = new ChatGptDeltaV1Decoder();
      decoder.ingest(initial("Answer"));
      assert.throws(
        () => decoder.ingest(source),
        (error: unknown) => {
          assert.ok(error instanceof UpstreamDriftError);
          assert.equal(error.code, "UPSTREAM_DRIFT");
          assert.equal(error.message.includes(sensitive), false);
          assert.equal(error.message.includes("/message"), false);
          return true;
        },
      );
    }
  });

  test("rejects pollution keys both in pointers and nested incoming values", () => {
    const unsafe = [
      'data: {"p":"/__proto__/polluted","o":"add","v":true}\n\n',
      'data: {"p":"/message/constructor","o":"add","v":true}\n\n',
      'data: {"p":"","o":"replace","v":{"message":{"__proto__":{"polluted":true}}}}\n\n',
      'data: {"p":"/message/content/parts","o":"append","v":[{"prototype":{"polluted":true}}]}\n\n',
      'data: {"message":{"constructor":{"polluted":true}}}\n\n',
    ];
    for (const source of unsafe) {
      const decoder = new ChatGptDeltaV1Decoder();
      decoder.ingest(initial("Answer"));
      assert.throws(() => decoder.ingest(source), UpstreamDriftError);
    }
    assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
  });
});
