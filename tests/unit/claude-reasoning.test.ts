import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { transformToClaudePayload } from "../../src/providers/claude/payload.ts";

describe("Claude Web: Reasoning Effort Payload Transformation", () => {
  test("transforms low effort to low adaptive thinking", () => {
    const payload = transformToClaudePayload(
      {
        model: "claude-3-7-sonnet-20250219",
        reasoning_effort: "low",
        messages: [{ role: "user", content: "Fast query" }],
      },
      "claude-3-7-sonnet-20250219",
    );
    assert.strictEqual(payload.effort, "low");
    assert.strictEqual(payload.thinking_mode, "adaptive");
  });

  test("transforms high effort to high enabled thinking", () => {
    const payload = transformToClaudePayload(
      {
        model: "claude-3-7-sonnet-20250219",
        reasoning_effort: "high",
        messages: [{ role: "user", content: "Deep query" }],
      },
      "claude-3-7-sonnet-20250219",
    );
    assert.strictEqual(payload.effort, "high");
    assert.strictEqual(payload.thinking_mode, "enabled");
  });

  test("transforms max effort to max enabled thinking", () => {
    const payload = transformToClaudePayload(
      {
        model: "claude-3-7-sonnet-20250219",
        reasoning_effort: "max",
        messages: [{ role: "user", content: "Hard query" }],
      },
      "claude-3-7-sonnet-20250219",
    );
    assert.strictEqual(payload.effort, "max");
    assert.strictEqual(payload.thinking_mode, "enabled");
  });
});
