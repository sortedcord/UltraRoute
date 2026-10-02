import { test } from "node:test";
import assert from "node:assert/strict";
import { extractChromiumCredentials } from "../../src/server/autoAuth.ts";
import { ChatGptWebAdapter } from "../../src/providers/chatgpt/adapter.ts";
import { createChatGptBrowserSession } from "../../src/providers/chatgpt/browser.ts";
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
    const credentials = extractChromiumCredentials()?.chatgpt;
    assert(
      credentials?.storageState,
      "Profile has no ChatGPT session; authenticate manually first",
    );
    const adapter = new ChatGptWebAdapter({
      browserBridgeFactory: createChatGptBrowserSession,
    });
    const result = (await adapter.execute(
      {
        model: process.env.CHATGPT_TEST_MODEL || "gpt-5.6-luna-free",
        messages: [
          {
            role: "user",
            content: "What is two plus two? Answer with the digit only.",
          },
        ],
      },
      credentials.storageState,
    )) as ChatCompletionResponse;
    assert.equal(result.choices[0].message.content?.trim(), "4");
    assert.equal(result.choices[0].finish_reason, "stop");
  },
);
