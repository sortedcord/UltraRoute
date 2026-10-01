import { test, describe } from "node:test";
import assert from "node:assert";
import {
  globalModelRegistry,
  globalProviderRegistry,
  initializeWebProviders,
} from "../../src/index.ts";

describe("Registry: Providers and Models", () => {
  test("initializes all three providers and registers standard models", () => {
    initializeWebProviders();

    // Check providers
    const chatgpt = globalProviderRegistry.get("chatgpt-web");
    const claude = globalProviderRegistry.get("claude-web");
    const gemini = globalProviderRegistry.get("gemini-web");

    assert(chatgpt, "ChatGPT Web provider should be registered");
    assert(claude, "Claude Web provider should be registered");
    assert(gemini, "Gemini Web provider should be registered");

    // Check model resolution & aliases
    const gptThinking = globalModelRegistry.resolve("gpt-5-6-sol");
    assert(gptThinking, "gpt-5-6-sol alias should resolve");
    assert.strictEqual(gptThinking?.id, "gpt-5-6-thinking");
    assert.strictEqual(gptThinking?.providerId, "chatgpt-web");

  });
});
