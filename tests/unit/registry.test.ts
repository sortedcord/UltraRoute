import { test, describe } from "node:test";
import assert from "node:assert";
import {
  globalModelRegistry,
  globalProviderRegistry,
  initializeWebProviders,
} from "../../src/index.ts";
import { ChatGptWebAdapter } from "../../src/providers/chatgpt/adapter.ts";
import { resolveChatRoute } from "../../src/server/routing.ts";

describe("Registry: Providers and Models", () => {
  test("initializes all web providers without a static model catalog", () => {
    initializeWebProviders();

    // Check providers
    const chatgpt = globalProviderRegistry.get("chatgpt-web");
    const claude = globalProviderRegistry.get("claude-web");
    const gemini = globalProviderRegistry.get("gemini-web");

    assert(chatgpt, "ChatGPT Web provider should be registered");
    assert(claude, "Claude Web provider should be registered");
    assert(gemini, "Gemini Web provider should be registered");

    assert.equal(globalModelRegistry.resolve("chatgpt-web:5.6"), undefined);
    assert.throws(() =>
      resolveChatRoute(globalModelRegistry, "gpt-5-6-sol", "chatgpt-web"),
    );
  });

  test("catalog initialization preserves configured ChatGPT adapters", () => {
    const previous = globalProviderRegistry.get("chatgpt-web");
    const configured = new ChatGptWebAdapter();
    globalProviderRegistry.register(configured);
    try {
      initializeWebProviders();
      assert.strictEqual(globalProviderRegistry.get("chatgpt-web"), configured);
      const route = resolveChatRoute(
        globalModelRegistry,
        "chatgpt-web:upstream-version",
        "chatgpt-web",
      );
      assert.deepEqual(route, {
        providerId: "chatgpt-web",
        model: "chatgpt-web:upstream-version",
      });
    } finally {
      if (previous) globalProviderRegistry.register(previous);
      initializeWebProviders();
    }
  });
});
