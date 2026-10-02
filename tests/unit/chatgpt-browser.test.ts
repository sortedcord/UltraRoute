import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatGptBrowserSession } from "../../src/providers/chatgpt/browser.ts";
import { ChatGptWebAdapter } from "../../src/providers/chatgpt/adapter.ts";
import {
  ChallengeRequiredError,
  UpstreamDriftError,
} from "../../src/shared/errors.ts";

const state = {
  cookies: [
    {
      name: "session",
      value: "fabricated",
      domain: ".chatgpt.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const,
    },
  ],
  origins: [],
};

function launchFixture(status: number, executionError?: Error) {
  let contextClosed = 0;
  let browserClosed = 0;
  let executionCalled = false;
  const page = {
    addInitScript: async () => {},
    on: () => {},
    goto: async () => ({ status: () => status }),
    url: () => "https://chatgpt.com/?temporary-chat=true",
    waitForFunction: async () => {},
    waitForLoadState: async () => {},
    evaluate: async () => false,
  };
  const context = {
    newPage: async () => page,
    close: async () => {
      contextClosed++;
    },
  };
  return {
    launch: async () => ({
      newContext: async () => context,
      close: async () => {
        browserClosed++;
      },
    }),
    execute: async () => {
      executionCalled = true;
      throw executionError ?? new Error("Unexpected request");
    },
    inspect: () => ({ contextClosed, browserClosed, executionCalled }),
  };
}

test("HTTP 403 browser challenge is actionable and factory session closes", async () => {
  const fixture = launchFixture(403);
  const adapter = new ChatGptWebAdapter({
    browserBridgeFactory: (state) =>
      createChatGptBrowserSession(state, fixture as any),
  });
  await assert.rejects(
    adapter.execute(
      {
        model: "gpt-5.6-luna-free",
        messages: [{ role: "user", content: "hello" }],
      },
      state,
    ),
    (error) =>
      error instanceof ChallengeRequiredError &&
      !error.message.includes("fabricated"),
  );
  assert.deepEqual(fixture.inspect(), {
    contextClosed: 1,
    browserClosed: 1,
    executionCalled: false,
  });
});

test("page errors cannot leak secrets and owned session closes after execution failure", async () => {
  const fixture = launchFixture(
    200,
    new Error(
      "module error token=private-fixture-value https://chatgpt.com/?secret=private",
    ),
  );
  const adapter = new ChatGptWebAdapter({
    browserBridgeFactory: (state) =>
      createChatGptBrowserSession(state, fixture as any),
  });
  await assert.rejects(
    adapter.execute(
      { model: "gpt-5-6", messages: [{ role: "user", content: "hello" }] },
      state,
    ),
    (error) =>
      error instanceof UpstreamDriftError && !error.message.includes("private"),
  );
  assert.deepEqual(fixture.inspect(), {
    contextClosed: 1,
    browserClosed: 1,
    executionCalled: true,
  });
});
