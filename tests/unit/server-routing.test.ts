import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ModelRegistry } from "../../src/registry/models.ts";
import { InvalidRequestError } from "../../src/shared/errors.ts";
import {
  resolveChatRoute,
  getCredentialsForProvider,
} from "../../src/server/routing.ts";
import type { WebProviderCapabilities } from "../../src/shared/types.ts";
import { convertHttpChatMessages } from "../../src/server/messages.ts";
import { resolveChatGptWebAttachments } from "../../src/providers/chatgpt/attachments.ts";

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
  id: "custom-model",
  name: "Custom model",
  providerId: "custom-web",
  aliases: ["custom-alias"],
  capabilities,
});

describe("Chat server model routing", () => {
  test("canonicalizes registered aliases before calling the matching web adapter", () => {
    assert.deepEqual(resolveChatRoute(registry, "CUSTOM-ALIAS"), {
      providerId: "custom-web",
      model: "custom-model",
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
  test("routes discovered ChatGPT families unchanged and rejects obsolete slugs", () => {
    assert.deepEqual(
      resolveChatRoute(registry, "chatgpt-web:future%2Fversion", "chatgpt-web"),
      { providerId: "chatgpt-web", model: "chatgpt-web:future%2Fversion" },
    );
    for (const model of ["gpt-5-6", "gpt-5-6-thinking", "gpt-5-6-sol"])
      assert.throws(
        () => resolveChatRoute(registry, model, "chatgpt-web"),
        InvalidRequestError,
      );
  });
  test("keeps the Google SDK separate and routes opaque Gemini Web IDs", () => {
    assert.deepEqual(
      resolveChatRoute(registry, "gemini-web:opaque-id", "gemini-web"),
      {
        providerId: "gemini-web",
        model: "gemini-web:opaque-id",
      },
    );
    assert.deepEqual(
      resolveChatRoute(registry, "gemini-3.5-flash-lite", "google"),
      {
        providerId: "google",
        model: "gemini-3.5-flash-lite",
      },
    );
    assert.deepEqual(
      resolveChatRoute(registry, "gemini-new-sdk-model", "google"),
      {
        providerId: "google",
        model: "gemini-new-sdk-model",
      },
    );
  });
  test("only the SDK default routes without a provider", () => {
    assert.deepEqual(resolveChatRoute(registry), {
      providerId: "google",
      model: "gemini-3.5-flash-lite",
    });
    assert.throws(
      () => resolveChatRoute(registry, "gemini-web:unknown"),
      InvalidRequestError,
    );
    assert.throws(
      () => resolveChatRoute(registry, "chatgpt-web:unknown"),
      InvalidRequestError,
    );
    assert.throws(
      () => resolveChatRoute(registry, "gemini-upstream-unknown", "gemini-web"),
      InvalidRequestError,
    );
  });
  test("rejects explicit provider/model mismatches", () => {
    for (const [model, provider] of [
      ["custom-alias", "claude-web"],
      ["gemini-3.5-flash-lite", "gemini-web"],
      ["gemini-web:opaque-id", "google"],
      ["custom-model", "unknown"],
      ["chatgpt-web:5.6", "gemini-web"],
      ["chatgpt-web:5.6", "google"],
    ])
      assert.throws(
        () => resolveChatRoute(registry, model, provider),
        InvalidRequestError,
      );
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

describe("Chat server rich message conversion", () => {
  test("projects assistant UI history to final answer text without promoting reasoning or provenance", () => {
    const { messages } = convertHttpChatMessages(
      [
        {
          role: "assistant",
          parts: [
            { type: "step-start" },
            {
              type: "reasoning",
              text: "Private reasoning must not be prompted",
            },
            {
              type: "source-url",
              sourceId: "url-1",
              url: "https://example.com",
              title: "Source",
            },
            {
              type: "source-document",
              sourceId: "doc-1",
              mediaType: "text/plain",
              title: "Document",
            },
            { type: "text", text: "The final answer" },
          ],
        },
        { role: "user", parts: [{ type: "text", text: "Follow up" }] },
      ],
      "chatgpt-web",
    );
    assert.deepEqual(messages, [
      { role: "assistant", content: "The final answer" },
      { role: "user", content: "Follow up" },
    ]);
    for (const type of [
      "reasoning",
      "step-start",
      "source-url",
      "source-document",
      "unknown-part",
    ]) {
      assert.throws(
        () =>
          convertHttpChatMessages(
            [{ role: "user", parts: [{ type }] }],
            "chatgpt-web",
          ),
        InvalidRequestError,
      );
    }
    assert.throws(
      () =>
        convertHttpChatMessages(
          [{ role: "assistant", parts: [{ type: "unknown-part" }] }],
          "chatgpt-web",
        ),
      InvalidRequestError,
    );
  });

  test("preserves AI SDK file MIME, filename, and bytes through the ChatGPT resolver", async () => {
    const converted = convertHttpChatMessages(
      [
        { role: "system", content: "Read the document" },
        {
          role: "user",
          parts: [
            { type: "text", text: "Summarize " },
            {
              type: "file",
              url: "data:application/pdf;base64,JVBERi0xLjQK",
              mediaType: "application/pdf",
              filename: "report.pdf",
            },
            { type: "text", text: "this." },
          ],
        },
      ],
      "chatgpt-web",
    );
    assert.deepEqual(converted.messages, [
      { role: "system", content: "Read the document" },
      { role: "user", content: "Summarize this." },
    ]);
    const [file] = await resolveChatGptWebAttachments(converted.attachments);
    assert.equal(file.kind, "file");
    assert.equal(file.name, "report.pdf");
    assert.equal(file.mimeType, "application/pdf");
    assert.equal(file.data.toString(), "%PDF-1.4\n");
  });

  test("retains explicit remote image metadata and infers base64 image MIME", () => {
    const { attachments } = convertHttpChatMessages(
      [
        {
          role: "user",
          content: [
            {
              type: "image",
              image: "https://example.com/photo.png",
              mediaType: "image/png",
              filename: "photo.png",
            },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,aW1hZ2U=" },
            },
            {
              type: "file",
              data: "data:text/plain;base64,aGVsbG8=",
              mediaType: "text/plain",
              filename: "notes.txt",
            },
          ],
        },
      ],
      "chatgpt-web",
    );
    assert.deepEqual(attachments, [
      {
        type: "image",
        url: "https://example.com/photo.png",
        mimeType: "image/png",
        fileName: "photo.png",
      },
      {
        type: "image",
        url: "data:image/png;base64,aW1hZ2U=",
        mimeType: "image/png",
      },
      {
        type: "file",
        url: "data:text/plain;base64,aGVsbG8=",
        mimeType: "text/plain",
        fileName: "notes.txt",
      },
    ]);
  });

  test("rejects rich content for providers whose HTTP path does not support it", () => {
    for (const provider of ["google", "claude-web", "gemini-web"]) {
      assert.throws(
        () =>
          convertHttpChatMessages(
            [
              {
                role: "user",
                parts: [
                  { type: "text", text: "Do not lose this file" },
                  {
                    type: "file",
                    url: "data:text/plain;base64,aGVsbG8=",
                    mediaType: "text/plain",
                  },
                ],
              },
            ],
            provider,
          ),
        InvalidRequestError,
      );
    }
  });

  test("rejects malformed and unsupported content instead of dropping it", async () => {
    for (const part of [
      null,
      { type: "text", text: 42 },
      { type: "input_audio", data: "audio" },
      { type: "file", filename: "missing.pdf", mediaType: "application/pdf" },
      { type: "file", url: "https://example.com/file" },
      { type: "file", url: "blob:local", mediaType: "text/plain" },
      {
        type: "file",
        url: "https://secret@example.com/file",
        mediaType: "text/plain",
      },
      {
        type: "file",
        url: "data:text/plain;base64,aGVsbG8=",
        mediaType: "text/plain",
        filename: 42,
      },
      {
        type: "image",
        image: "https://example.com/image",
        mediaType: "application/pdf",
      },
    ]) {
      assert.throws(
        () =>
          convertHttpChatMessages(
            [{ role: "user", parts: [part] }],
            "chatgpt-web",
          ),
        InvalidRequestError,
      );
    }
    const { attachments } = convertHttpChatMessages(
      [
        {
          role: "user",
          parts: [
            {
              type: "file",
              url: "data:text/plain;base64,!!!!",
              mediaType: "text/plain",
            },
          ],
        },
      ],
      "chatgpt-web",
    );
    await assert.rejects(
      resolveChatGptWebAttachments(attachments),
      /invalid base64/i,
    );
  });
});
