import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { executeChatGptWebFirstPartyTurn } from "../../src/providers/chatgpt/firstParty.ts";
import { UpstreamDriftError } from "../../src/shared/errors.ts";

const root = globalThis as typeof globalThis & Record<string, unknown>;
const key = "__ultrarouteChatGptFirstPartyV2";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
  "base64",
);
const text = Buffer.from("fixture document");
const input = {
  prompt: "describe",
  selection: {
    model: "future-opaque-native",
    thinkingEffort: "future-effort",
  },
  attachments: [
    {
      kind: "image" as const,
      name: "picture.png",
      mimeType: "image/png",
      size: png.length,
      data: png,
      width: 1,
      height: 1,
    },
    {
      kind: "file" as const,
      name: "document.txt",
      mimeType: "text/plain",
      size: text.length,
      data: text,
    },
  ],
};
const page = () =>
  ({
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
  }) as unknown as Page;

test("attachment bytes stay on credential-free signed uploads, preserving sequence and conversation metadata", async () => {
  const originalFetch = globalThis.fetch;
  const sequence: string[] = [];
  root[key] = {
    requestClient: { safeGet() {}, safePost() {}, postResponse() {} },
    integrity() {},
    accountIdentity: () =>
      JSON.stringify(["fixture-user", "fixture-workspace"]),
    models: async () => ({ models: [] }),
    begin() {},
    abort() {},
    cleanup() {},
    async register(_id: string, metadata: Record<string, unknown>[]) {
      sequence.push("register");
      assert.deepEqual(
        metadata.map((item) => ({
          name: item.name,
          size: item.size,
          data: item.data,
        })),
        input.attachments.map((item) => ({
          name: item.name,
          size: item.size,
          data: undefined,
        })),
      );
      return [
        {
          fileId: "image-1",
          uploadUrl: "https://files.oaiusercontent.com/image?signature=PRIVATE",
        },
        {
          fileId: "file-2",
          uploadUrl: "https://files.oaiusercontent.com/file?signature=PRIVATE",
        },
      ];
    },
    async process(_id: string, metadata: Record<string, unknown>[]) {
      sequence.push("process");
      assert.deepEqual(
        metadata.map((item) => [item.fileId, item.kind, item.name, item.size]),
        [
          ["image-1", "image", "picture.png", png.length],
          ["file-2", "file", "document.txt", text.length],
        ],
      );
    },
    async converse(_id: string, body: Record<string, any>) {
      sequence.push("conversation");
      assert.equal(body.model, input.selection.model);
      assert.equal(body.thinking_effort, input.selection.thinkingEffort);
      assert.deepEqual(body.messages[0].content, {
        content_type: "multimodal_text",
        parts: [
          {
            content_type: "image_asset_pointer",
            asset_pointer: "sediment://image-1",
            size_bytes: png.length,
            width: 1,
            height: 1,
          },
          "describe",
        ],
      });
      assert.deepEqual(body.messages[0].metadata.attachments, [
        {
          id: "image-1",
          size: png.length,
          name: "picture.png",
          mime_type: "image/png",
          width: 1,
          height: 1,
          source: "local",
          is_big_paste: false,
        },
        {
          id: "file-2",
          size: text.length,
          name: "document.txt",
          mime_type: "text/plain",
          non_library_my_files_injest_upload: true,
          source: "local",
          is_big_paste: false,
        },
      ]);
      return "data: complete\n\n";
    },
  };
  globalThis.fetch = async (url, init) => {
    sequence.push(
      String(url).includes("/image?") ? "upload-image" : "upload-file",
    );
    assert.equal(init?.method, "PUT");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    assert(init?.signal instanceof AbortSignal);
    assert(init?.body instanceof Uint8Array);
    assert.deepEqual(
      Buffer.from(init.body),
      sequence.at(-1) === "upload-image" ? png : text,
    );
    const headers = new Headers(init.headers);
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("openai-sentinel-chat-requirements-token"), null);
    assert.equal(headers.get("x-ms-blob-type"), "BlockBlob");
    return new Response(null, { status: 201 });
  };
  try {
    assert.equal(
      await executeChatGptWebFirstPartyTurn(page(), input),
      "data: complete\n\n",
    );
    assert.deepEqual(sequence, [
      "register",
      "upload-image",
      "upload-file",
      "process",
      "conversation",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    delete root[key];
  }
});

test("registration count and invalid signed destinations fail before upload or conversation", async () => {
  const originalFetch = globalThis.fetch;
  let uploads = 0;
  let conversations = 0;
  globalThis.fetch = async () => {
    uploads++;
    throw new Error("unexpected upload");
  };
  try {
    for (const registrations of [
      [],
      [
        { fileId: "image-1", uploadUrl: "https://evil.test/PRIVATE" },
        {
          fileId: "file-2",
          uploadUrl: "https://files.oaiusercontent.com/file",
        },
      ],
    ]) {
      root[key] = {
        requestClient: { safeGet() {}, safePost() {}, postResponse() {} },
        integrity() {},
        accountIdentity: () =>
          JSON.stringify(["fixture-user", "fixture-workspace"]),
        models: async () => ({ models: [] }),
        begin() {},
        abort() {},
        cleanup() {},
        register: async () => registrations,
        process: async () => {},
        converse: async () => {
          conversations++;
          return "unexpected";
        },
      };
      await assert.rejects(
        executeChatGptWebFirstPartyTurn(page(), input),
        (error: unknown) =>
          error instanceof UpstreamDriftError &&
          !JSON.stringify(error).includes("PRIVATE"),
      );
    }
    assert.equal(uploads, 0);
    assert.equal(conversations, 0);
  } finally {
    globalThis.fetch = originalFetch;
    delete root[key];
  }
});

test("signed upload cancellation uses the same request-local signal and stops processing", async () => {
  const originalFetch = globalThis.fetch;
  const started = Promise.withResolvers<void>();
  const caller = new AbortController();
  let processed = false;
  let cleaned = false;
  root[key] = {
    requestClient: { safeGet() {}, safePost() {}, postResponse() {} },
    integrity() {},
    accountIdentity: () =>
      JSON.stringify(["fixture-user", "fixture-workspace"]),
    models: async () => ({ models: [] }),
    begin() {},
    abort() {},
    cleanup() {
      cleaned = true;
    },
    register: async () => [
      { fileId: "image", uploadUrl: "https://files.oaiusercontent.com/image" },
      { fileId: "file", uploadUrl: "https://files.oaiusercontent.com/file" },
    ],
    process: async () => {
      processed = true;
    },
    converse: async () => "unexpected",
  };
  globalThis.fetch = async (_url, init) => {
    const signal = init?.signal;
    assert(signal);
    started.resolve();
    return new Promise<Response>((_resolve, reject) =>
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      ),
    );
  };
  try {
    const pending = executeChatGptWebFirstPartyTurn(page(), input, {
      signal: caller.signal,
    });
    await started.promise;
    caller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(processed, false);
    assert.equal(cleaned, true);
  } finally {
    globalThis.fetch = originalFetch;
    delete root[key];
  }
});
