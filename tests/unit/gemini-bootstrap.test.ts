import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGeminiBootstrap } from "../../src/providers/gemini/transport.ts";
import { UpstreamDriftError } from "../../src/shared/errors.ts";

test("Gemini accepts current thykhd bootstrap and session routing", () => {
  const html = '<script>window.WIZ_global_data={"thykhd": "current-token", "cfb2h": "current-build", "FdrFJe": "session-route"};</script>';
  assert.deepEqual(parseGeminiBootstrap(html), {
    at: "current-token", build: "current-build", sessionId: "session-route",
  });
});

test("Gemini legacy token takes precedence and JSON escapes are decoded", () => {
  const html = String.raw`{"SNlM0e":"legacy\u003atoken","thykhd":"alternate-token","cfb2h":"build\u002fversion"}`;
  assert.deepEqual(parseGeminiBootstrap(html), {
    at: "legacy:token", build: "build/version", sessionId: undefined,
  });
});

test("Gemini does not submit a request without a usable token and build", () => {
  for (const html of ['{"cfb2h":"build"}', '{"thykhd":"token"}', '{"thykhd":"","cfb2h":"build"}']) {
    assert.throws(() => parseGeminiBootstrap(html), UpstreamDriftError);
  }
});
