import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { GeminiWebAdapter, MockGeminiWebTransport } from "../../src/providers/gemini/adapter.ts";
import { GEMINI_WEB_CONSTANTS } from "../../src/providers/gemini/constants.ts";

describe("Gemini Web: Reasoning and Extended Thinking", () => {
  const upstreamId = "opaque-pro-id";
  const catalog = {
    models: [
      {
        id: `gemini-web:${upstreamId}`,
        upstreamId,
        name: "3.1 Pro",
        description: "Complex reasoning",
        disabled: false,
        availability: "Available",
      },
    ],
    defaultModel: `gemini-web:${upstreamId}`,
  };

  test("passes extendedThinking=1 (normal) when reasoning_effort is low", async () => {
    let capturedPayload: unknown = null;
    const transport = new MockGeminiWebTransport(
      async (p) => {
        capturedPayload = p;
        const inner = JSON.stringify([
          null,
          "c_conv",
          "r_resp",
          null,
          [["rc_choice", ["Result with normal thinking"]]],
        ]);
        const envelope = JSON.stringify([["wrb.fr", null, inner]]);
        return `)]}'\n${envelope.length}\n${envelope}\n`;
      },
      async () => catalog,
    );

    const adapter = new GeminiWebAdapter({ transport });
    const creds = "__Secure-1PSID=sid; SAPISID=sapi";

    await adapter.execute(
      {
        model: `gemini-web:${upstreamId}`,
        messages: [{ role: "user", content: "Hello" }],
        reasoning_effort: "low",
      },
      creds,
    );

    const payload = capturedPayload as unknown[];
    assert.strictEqual(
      payload[GEMINI_WEB_CONSTANTS.PAYLOAD_SLOT_EXTENDED_THINKING],
      1,
      "Extended thinking slot 80 must be 1 for low effort",
    );
    assert.deepStrictEqual(
      payload[GEMINI_WEB_CONSTANTS.PAYLOAD_SLOT_THINK_SETTING],
      [[1]],
      "Think setting slot 17 must be [[1]] for low effort",
    );
  });

  test("passes extendedThinking=2 (extended) when reasoning_effort is high", async () => {
    let capturedPayload: unknown = null;
    const transport = new MockGeminiWebTransport(
      async (p) => {
        capturedPayload = p;
        const inner = JSON.stringify([
          null,
          "c_conv",
          "r_resp",
          null,
          [["rc_choice", ["Result with extended thinking"]]],
        ]);
        const envelope = JSON.stringify([["wrb.fr", null, inner]]);
        return `)]}'\n${envelope.length}\n${envelope}\n`;
      },
      async () => catalog,
    );

    const adapter = new GeminiWebAdapter({ transport });
    const creds = "__Secure-1PSID=sid; SAPISID=sapi";

    await adapter.execute(
      {
        model: `gemini-web:${upstreamId}`,
        messages: [{ role: "user", content: "Deep question" }],
        reasoning_effort: "high",
      },
      creds,
    );

    const payload = capturedPayload as unknown[];
    assert.strictEqual(
      payload[GEMINI_WEB_CONSTANTS.PAYLOAD_SLOT_EXTENDED_THINKING],
      2,
      "Extended thinking slot 80 must be 2 for high effort",
    );
    assert.deepStrictEqual(
      payload[GEMINI_WEB_CONSTANTS.PAYLOAD_SLOT_THINK_SETTING],
      [[3]],
      "Think setting slot 17 must be [[3]] for high effort",
    );
  });
});
