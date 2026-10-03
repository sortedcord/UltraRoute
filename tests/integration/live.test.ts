import { test, describe } from "node:test";
import assert from "node:assert";
import { ChatGptWebAdapter } from "../../src/providers/chatgpt/index.ts";
import { ClaudeWebAdapter } from "../../src/providers/claude/index.ts";
import { GeminiWebAdapter } from "../../src/providers/gemini/index.ts";
import { WarmChatGptBrowserManager } from "../../src/providers/chatgpt/browser.ts";
import type { ChatCompletionResponse } from "../../src/shared/types.ts";

const RUN_LIVE_TESTS = process.env.RUN_LIVE_TESTS === "1";

describe("Live Integration Tests (Opt-In)", { skip: !RUN_LIVE_TESTS }, () => {
  test(
    "Live ChatGPT Web execution",
    { skip: !process.env.CHATGPT_COOKIE_HEADER, timeout: 210_000 },
    async () => {
      const manager = new WarmChatGptBrowserManager();
      const adapter = new ChatGptWebAdapter({
        transportFactory: (state, signal) =>
          manager.createSession(state, signal),
        modelCatalogSource: manager,
      });
      try {
        const catalog = await adapter.discoverModels(
          process.env.CHATGPT_COOKIE_HEADER,
        );
        assert(
          catalog.defaultModel,
          "Upstream must offer an enabled ChatGPT model",
        );
        const model = catalog.models.find(
          (item) => item.id === catalog.defaultModel,
        );
        assert(model, "Default ChatGPT model must appear in the catalog");
        const response = (await adapter.execute(
          {
            model: catalog.defaultModel,
            reasoning_effort: model.defaultReasoningLevel,
            messages: [
              {
                role: "user",
                content: "What is two plus two? Reply with the digit only.",
              },
            ],
          },
          process.env.CHATGPT_COOKIE_HEADER,
        )) as ChatCompletionResponse;
        assert.strictEqual(response.choices[0].message.content?.trim(), "4");
        assert.strictEqual(response.choices[0].finish_reason, "stop");
      } finally {
        await manager.close();
      }
    },
  );

  test("Live Claude Web execution", async () => {
    const creds = process.env.CLAUDE_SESSION_KEY;
    if (!creds) {
      console.log("Skipping live Claude test: CLAUDE_SESSION_KEY not set");
      return;
    }
    const adapter = new ClaudeWebAdapter();
    const catalog = await adapter.discoverModels(creds);
    assert(catalog.defaultModel, "Upstream must offer an enabled model");
    const res = await adapter.execute(
      {
        model: catalog.defaultModel,
        messages: [{ role: "user", content: "Reply with the word 'PONG'" }],
      },
      creds,
    );
    assert(res);
  });

  test("Live Gemini Web execution", async () => {
    const cookie = process.env.GEMINI_COOKIE;
    if (!cookie) {
      console.log("Skipping live Gemini test: GEMINI_COOKIE not set");
      return;
    }
    const adapter = new GeminiWebAdapter();
    const catalog = await adapter.discoverModels(cookie);
    assert(
      catalog.defaultModel,
      "Gemini picker must expose an available model",
    );
    const res = await adapter.execute(
      {
        model: catalog.defaultModel,
        messages: [{ role: "user", content: "Reply with the word 'PONG'" }],
      },
      cookie,
    );
    assert(res);
  });
});
