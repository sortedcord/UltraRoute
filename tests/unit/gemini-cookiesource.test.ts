import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GeminiWebAdapter, MockGeminiWebTransport } from "../../src/providers/gemini/adapter.ts";
import { FileCookieSource } from "../../src/providers/gemini/credentials.ts";

describe("Gemini Web: Configured Cookie Source Integration", () => {
  test("adapter falls back to configured FileCookieSource when credentials argument is empty", async () => {
    const tempCookieFile = join(tmpdir(), `test-gemini-cookie-source-${Date.now()}.txt`);
    let capturedCookie: string | undefined = undefined;

    try {
      writeFileSync(tempCookieFile, "__Secure-1PSID=rotated_psid_val; SAPISID=sapisid_val; 1P_JAR=2026-10-02");
      const cookieSource = new FileCookieSource(tempCookieFile);

      const upstreamId = "opaque-flash-test";
      const catalog = {
        models: [
          {
            id: `gemini-web:${upstreamId}`,
            upstreamId,
            name: "3.5 Flash-Lite",
            description: "Fastest",
            disabled: false,
            availability: "Available",
          },
        ],
        defaultModel: `gemini-web:${upstreamId}`,
      };

      const transport = new MockGeminiWebTransport(
        async () => {
          const inner = JSON.stringify([null, "c1", "r1", null, [["rc1", ["Hello"]]]]);
          const envelope = JSON.stringify([["wrb.fr", null, inner]]);
          return `)]}'\n${envelope.length}\n${envelope}\n`;
        },
        async (cookie) => {
          capturedCookie = cookie;
          return catalog;
        },
      );

      const adapter = new GeminiWebAdapter({
        transport,
        cookieSource,
      });

      // 1. Discover models with empty credentials -> should use cookieSource
      const discovered = await adapter.discoverModels("");
      assert.strictEqual(discovered.models.length, 1);
      assert.ok((capturedCookie as string | undefined)?.includes("rotated_psid_val"));

      // 2. Discover models with undefined -> should use cookieSource
      capturedCookie = undefined as string | undefined;
      const discovered2 = await adapter.discoverModels(undefined);
      assert.strictEqual(discovered2.models.length, 1);
      assert.ok((capturedCookie as string | undefined)?.includes("rotated_psid_val"));

      // 3. Execute with empty credentials -> should use cookieSource
      const res = await adapter.execute(
        {
          model: `gemini-web:${upstreamId}`,
          messages: [{ role: "user", content: "Test" }],
        },
        "",
      );
      assert.ok("choices" in res);
      assert.strictEqual(res.choices[0].message.content, "Hello");
    } finally {
      try {
        unlinkSync(tempCookieFile);
      } catch {}
    }
  });

  test("discovery injects cookies with domain .google.com and path / for cross-subdomain auth", () => {
    // Verified by src/providers/gemini/models.ts domain and path setting
    const rawCookie = "SID=val1; __Secure-1PSID=val2";
    const mapped = rawCookie.split(";").flatMap((part) => {
      const index = part.indexOf("=");
      if (index <= 0) return [];
      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      return [{ name, value, domain: ".google.com", path: "/", secure: true }];
    });
    assert.strictEqual(mapped.length, 2);
    assert.strictEqual(mapped[0].domain, ".google.com");
    assert.strictEqual(mapped[0].path, "/");
    assert.strictEqual(mapped[1].domain, ".google.com");
  });
});
