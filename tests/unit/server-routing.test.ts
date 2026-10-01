import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ModelRegistry } from "../../src/registry/models.ts";
import { InvalidRequestError } from "../../src/shared/errors.ts";
import {
  resolveChatRoute,
  getCredentialsForProvider,
} from "../../src/server/routing.ts";
import type { WebProviderCapabilities } from "../../src/shared/types.ts";

const capabilities: WebProviderCapabilities = {
  supportsStreaming: true,
  supportsReasoning: true,
  supportedThinkingEfforts: [],
  supportsToolCalling: true,
  supportsVision: false,
  supportsFiles: false,
  supportsContinuation: false,
};
const registry = new ModelRegistry();
registry.register({
  id: "gpt-5-6-thinking",
  name: "ChatGPT",
  providerId: "chatgpt-web",
  aliases: ["gpt-5-6-sol"],
  capabilities,
});

describe("Chat server model routing", () => {
  test("canonicalizes registered aliases before calling the matching web adapter", () => {
    assert.deepEqual(resolveChatRoute(registry, "GPT-5-6-SOL"), {
      providerId: "chatgpt-web",
      model: "gpt-5-6-thinking",
    });
  });
  test("routes discovered Claude IDs without a static registry entry", () => {
    assert.deepEqual(
      resolveChatRoute(registry, "claude-upstream-new", "claude-web"),
      {
        providerId: "claude-web",
        model: "claude-upstream-new",
      },
    );
  });
  test("keeps the Google SDK separate and routes opaque Gemini Web IDs", () => {
    assert.deepEqual(resolveChatRoute(registry, "gemini-web:opaque-id", "gemini-web"), {
      providerId: "gemini-web",
      model: "gemini-web:opaque-id",
    });
    assert.deepEqual(resolveChatRoute(registry, "gemini-3.5-flash-lite", "google"), {
      providerId: "google",
      model: "gemini-3.5-flash-lite",
    });
    assert.deepEqual(resolveChatRoute(registry, "gemini-new-sdk-model", "google"), {
      providerId: "google",
      model: "gemini-new-sdk-model",
    });
  });
  test("only the SDK default routes without a provider", () => {
    assert.deepEqual(resolveChatRoute(registry), {
      providerId: "google",
      model: "gemini-3.5-flash-lite",
    });
    assert.throws(() => resolveChatRoute(registry, "gemini-web:unknown"), InvalidRequestError);
    assert.throws(() => resolveChatRoute(registry, "gemini-upstream-unknown", "gemini-web"), InvalidRequestError);
  });
  test("rejects explicit provider/model mismatches", () => {
    for (const [model, provider] of [
      ["gpt-5-6-sol", "claude-web"],
      ["gemini-3.5-flash-lite", "gemini-web"],
      ["gemini-web:opaque-id", "google"],
      ["gpt-5-6-thinking", "unknown"],
    ]) assert.throws(() => resolveChatRoute(registry, model, provider), InvalidRequestError);
  });
  test("dispatches native credentials and prefers ChatGPT browser state over cookie conversion", () => {
    const state = { cookies: [], origins: [] };
    const credentials = {
      chatgpt: { cookieHeader: "chat=cookie", storageState: state },
      claude: {
        cookieHeader: "sessionKey=claude",
        sessionKey: "claude",
        lastActiveOrg: "org",
      },
      gemini: { cookieHeader: "__Secure-1PSID=gemini" },
    };
    assert.equal(getCredentialsForProvider("chatgpt-web", credentials), state);
    assert.deepEqual(
      getCredentialsForProvider("chatgpt-web", {
        chatgpt: {
          ...credentials.chatgpt,
          browserProfile: "/dedicated/fixture",
        },
      }),
      { browserProfile: "/dedicated/fixture" },
    );
    assert.deepEqual(getCredentialsForProvider("claude-web", credentials), {
      sessionKey: "claude",
      organizationId: "org",
    });
    assert.equal(
      getCredentialsForProvider("gemini-web", credentials),
      "__Secure-1PSID=gemini",
    );
    assert.equal(getCredentialsForProvider("google", credentials), undefined);
    assert.equal(
      getCredentialsForProvider("chatgpt-web", {
        chatgpt: { cookieHeader: "new-session" },
      }),
      "new-session",
    );
    assert.equal(getCredentialsForProvider("chatgpt-web", null), undefined);
  });
});
