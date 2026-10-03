import { test } from "node:test";
import assert from "node:assert/strict";
import { extractChromiumCredentials } from "../../src/server/autoAuth.ts";
import { ChatGptWebAdapter } from "../../src/providers/chatgpt/adapter.ts";
import { WarmChatGptBrowserManager } from "../../src/providers/chatgpt/browser.ts";
import type { ChatCompletionResponse } from "../../src/shared/types.ts";

// No profile access or upstream traffic until both explicit flags are set.
test(
  "ChatGPT supplied Chromium profile generates a real temporary-chat answer",
  {
    skip:
      process.env.RUN_LIVE_TESTS !== "1" ||
      process.env.RUN_PROFILE_TESTS !== "1",
    timeout: 210_000,
  },
  async () => {
    const credentials = extractChromiumCredentials("chatgpt-web")?.chatgpt;
    const credential = credentials?.browserProfile
      ? { browserProfile: credentials.browserProfile }
      : credentials?.storageState;
    assert(
      credential,
      "Profile has no ChatGPT session; authenticate manually first",
    );
    const manager = new WarmChatGptBrowserManager();
    const adapter = new ChatGptWebAdapter({
      transportFactory: (state, signal) => manager.createSession(state, signal),
      modelCatalogSource: manager,
    });
    try {
      const catalog = await adapter.discoverModels(credential);
      assert(
        catalog.defaultModel,
        "Upstream must offer an enabled ChatGPT model",
      );
      const model = catalog.models.find(
        (item) => item.id === catalog.defaultModel,
      );
      assert(model, "Default ChatGPT model must appear in the catalog");
      const result = (await adapter.execute(
        {
          model: catalog.defaultModel,
          reasoning_effort: model.defaultReasoningLevel,
          messages: [
            {
              role: "user",
              content: "What is two plus two? Answer with the digit only.",
            },
          ],
        },
        credential,
      )) as ChatCompletionResponse;
      assert.equal(result.choices[0].message.content?.trim(), "4");
      assert.equal(result.choices[0].finish_reason, "stop");
    } finally {
      await manager.close();
    }
  },
);
