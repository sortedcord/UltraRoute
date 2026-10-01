import { test, describe } from "node:test";
import assert from "node:assert";
import { writeFileSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GeminiRpcDecoder } from "../../src/providers/gemini/rpcDecoder.ts";
import {
  parseGeminiCookie,
  generateSapisidHash,
  StaticCookieSource,
  FileCookieSource,
} from "../../src/providers/gemini/credentials.ts";
import { GeminiWebAdapter, MockGeminiWebTransport } from "../../src/providers/gemini/adapter.ts";
import { parseGeminiModelRows } from "../../src/providers/gemini/models.ts";

describe("Gemini Web: RPC Decoder", () => {
  test("parses length-prefixed wrb.fr response and extracts continuation", () => {
    const decoder = new GeminiRpcDecoder();

    const innerJson = JSON.stringify([
      null,
      "c_conv_123",
      "r_resp_456",
      null,
      [["rc_choice_789", ["Hello world from Gemini!"]]],
    ]);
    const rpcEnvelope = JSON.stringify([["wrb.fr", null, innerJson]]);
    const wire = `)]}'\n${rpcEnvelope.length}\n${rpcEnvelope}\n`;

    const chunks = Array.from(decoder.feed(wire));
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].text, "Hello world from Gemini!");
    assert.strictEqual(chunks[0].continuation?.conversationId, "c_conv_123");
    assert.strictEqual(chunks[0].continuation?.responseId, "r_resp_456");
    assert.strictEqual(chunks[0].continuation?.choiceId, "rc_choice_789");
  });

  test("handles partial frame split across multiple feeds", () => {
    const decoder = new GeminiRpcDecoder();
    const innerJson = JSON.stringify([
      null,
      "c_conv_1",
      "r_resp_1",
      null,
      [["rc_choice_1", ["Split test"]]],
    ]);
    const rpcEnvelope = JSON.stringify([["wrb.fr", null, innerJson]]);
    const wire = `)]}'\n${rpcEnvelope.length}\n${rpcEnvelope}\n`;

    const half = Math.floor(wire.length / 2);
    const part1 = wire.slice(0, half);
    const part2 = wire.slice(half);

    const c1 = Array.from(decoder.feed(part1));
    assert.strictEqual(c1.length, 0);

    const c2 = Array.from(decoder.feed(part2));
    assert.strictEqual(c2.length, 1);
    assert.strictEqual(c2[0].text, "Split test");
  });
});
test("parses Gemini GetUserStatus model metadata by opaque upstream ID", () => {
  const payload = Array(16).fill(null);
  payload[15] = [["opaque-model", "Flash", "Everyday answers", [], 2, null, [], false, "", 1, "Flash", "3.8 Flash", "Everyday answers"]];
  const frame = JSON.stringify([["wrb.fr", "otAQ7b", JSON.stringify(payload)]]);
  const response = `)]}'\n${frame.length}\n${frame}\n`;
  assert.equal(parseGeminiModelRows(response).get("opaque-model")?.name, "3.8 Flash");
  assert.throws(() => parseGeminiModelRows("[]"));
});


describe("Gemini Web: Credentials & Cookie Sources", () => {
  test("parses required Google auth cookies and generates SAPISIDHASH", () => {
    const cookie = "__Secure-1PSID=sid123; SAPISID=sapisid456; 1P_JAR=2026-09";
    const creds = parseGeminiCookie(cookie);
    assert.strictEqual(creds.secure1PSID, "sid123");
    assert.strictEqual(creds.sapisid, "sapisid456");

    const hash = generateSapisidHash(creds.sapisid!);
    assert(hash.startsWith("SAPISIDHASH "));
    assert(hash.includes("_"));
  });

  test("reloads cookie file on mtime modification (AuthoCookie sidecar pattern)", async () => {
    const tempPath = join(tmpdir(), `gemini-cookie-test-${Date.now()}.txt`);
    try {
      writeFileSync(tempPath, "__Secure-1PSID=initial_cookie");
      const fileSource = new FileCookieSource(tempPath);

      const c1 = await fileSource.getCookie();
      assert.strictEqual(c1, "__Secure-1PSID=initial_cookie");

      // Deterministically advance mtime using utimesSync without real timers
      writeFileSync(tempPath, "__Secure-1PSID=rotated_cookie");
      const futureTime = new Date(Date.now() + 5000);
      utimesSync(tempPath, futureTime, futureTime);

      const c2 = await fileSource.getCookie();
      assert.strictEqual(c2, "__Secure-1PSID=rotated_cookie");
    } finally {
      try {
        unlinkSync(tempPath);
      } catch {}
    }
  });
});

describe("Gemini Web: Adapter & Continuation", () => {
  test("executes turn with mock transport and preserves continuation", async () => {
    let capturedPayload: unknown = null;
    const upstreamId = "opaque-flash-id";
    let capturedModelId: string | undefined;
    const catalog = {
      models: [{ id: `gemini-web:${upstreamId}`, upstreamId, name: "3.8 Flash", description: "All-around help", disabled: false, availability: "Available" }],
      defaultModel: `gemini-web:${upstreamId}`,
    };
    const transport = new MockGeminiWebTransport(async (p) => {
      capturedPayload = p;
      const inner = JSON.stringify([null, "c_live_conv", "r_live_resp", null, [["rc_live_choice", ["Paris is the capital of France."]]]]);
      const envelope = JSON.stringify([["wrb.fr", null, inner]]);
      return `)]}'\n${envelope.length}\n${envelope}\n`;
    }, async () => catalog);
    const originalPost = transport.postStreamGenerate.bind(transport);
    transport.postStreamGenerate = async (payload, cookie, hash, modelId, signal) => {
      capturedModelId = modelId;
      return originalPost(payload, cookie, hash, modelId, signal);
    };

    const adapter = new GeminiWebAdapter({ transport });
    const creds = "__Secure-1PSID=cookie_a; SAPISID=sapi_a";

    // Turn 1
    const res1 = (await adapter.execute(
      {
        model: `gemini-web:${upstreamId}`,
        messages: [{ role: "user", content: "What is the capital of France?" }],
      },
      creds
    )) as { choices: Array<{ message: { content: string } }> };

    assert.strictEqual(res1.choices[0].message.content, "Paris is the capital of France.");
    assert.strictEqual(capturedModelId, upstreamId);
    const payloadArr1 = capturedPayload as unknown[];
    // Slot 2 should be empty array on first turn
    assert(Array.isArray(payloadArr1[2]));
    assert.strictEqual((payloadArr1[2] as unknown[])[0], "");
    // Turn 2
    await adapter.execute(
      {
        model: `gemini-web:${upstreamId}`,
        messages: [
          { role: "user", content: "What is the capital of France?" },
          { role: "assistant", content: "Paris is the capital of France." },
          { role: "user", content: "What is its population?" },
        ],
      },
      creds
    );

    // Slot 2 should have continuation token [convId, respId, choiceId, ...]
    const payloadArr2 = capturedPayload as unknown[];
    assert(Array.isArray(payloadArr2[2]));
    const slot2 = payloadArr2[2] as unknown[];
    assert.strictEqual(slot2[0], "c_live_conv");
    assert.strictEqual(slot2[1], "r_live_resp");
    assert.strictEqual(slot2[2], "rc_live_choice");
  });
});
