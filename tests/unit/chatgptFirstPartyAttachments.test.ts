import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { executeChatGptWebFirstPartyTurn } from "../../src/providers/chatgpt/firstParty.ts";

test("first-party attachment turn registers, uploads, processes and submits image/file metadata", async () => {
  const root = globalThis as typeof globalThis & Record<string, unknown>;
  const bridgeKey = "__ultrarouteChatGptFirstPartyV1";
  const abortKey = "__ultrarouteChatGptAbortV1";
  const requestKey = "__ultrarouteChatGptRequestV1";
  const originalFetch = globalThis.fetch;
  const uploads: string[] = [];
  const processed: string[] = [];
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
    "base64",
  );
  const text = Buffer.from("fixture document");
  let registered = 0;
  root[bridgeKey] = {
    finalizeRequirements: async () => ({ token: "fixture-requirements" }),
    proofManager: { getEnforcementToken: async () => "fixture-proof" },
    turnstileManager: { getEnforcementToken: async () => "fixture-token" },
    buildSentinelHeaders: () => ({
      "OpenAI-Sentinel-Chat-Requirements-Token": "fixture-requirements",
    }),
    requestClient: {
      safePost: async (
        path: string,
        options: { requestBody: Record<string, unknown>; signal: AbortSignal },
      ) => {
        assert.equal(options.signal.aborted, false);
        if (path === "/files") {
          const id = `fixture-file-${++registered}`;
          assert.equal(options.requestBody.store_in_library, false);
          assert.equal(
            options.requestBody.use_case,
            registered === 1 ? "multimodal" : "my_files",
          );
          return {
            file_id: id,
            upload_url: `https://files.oaiusercontent.com/${id}?signature=fixture`,
          };
        }
        if (path === "/files/process_upload_stream") {
          const id = options.requestBody.file_id;
          assert.equal(typeof id, "string");
          processed.push(id as string);
          assert.equal(
            options.requestBody.index_for_retrieval,
            processed.length === 2,
          );
          return new Response('data: {"status":"ready"}\n\n');
        }
        assert.equal(path, "/f/conversation");
        assert.deepEqual(processed, ["fixture-file-1", "fixture-file-2"]);
        assert.equal(options.requestBody.model, "gpt-5-5");
        assert.deepEqual(options.requestBody.system_hints, ["reason"]);
        const messages = options.requestBody.messages;
        assert(Array.isArray(messages));
        assert.deepEqual(messages[0].content, {
          content_type: "multimodal_text",
          parts: [
            {
              content_type: "image_asset_pointer",
              asset_pointer: "sediment://fixture-file-1",
              size_bytes: png.length,
              width: 1,
              height: 1,
            },
            "describe",
          ],
        });
        assert.deepEqual(messages[0].metadata.attachments, [
          {
            id: "fixture-file-1",
            size: png.length,
            name: "picture.png",
            mime_type: "image/png",
            width: 1,
            height: 1,
            source: "local",
            is_big_paste: false,
          },
          {
            id: "fixture-file-2",
            size: text.length,
            name: "document.txt",
            mime_type: "text/plain",
            non_library_my_files_injest_upload: true,
            source: "local",
            is_big_paste: false,
          },
        ]);
        return new Response("data: [DONE]\n\n");
      },
    },
  };
  globalThis.fetch = async (url, init) => {
    const destination = String(url);
    uploads.push(destination);
    assert.equal(init?.method, "PUT");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    assert(init?.body instanceof ArrayBuffer);
    assert.deepEqual(Buffer.from(init.body), uploads.length === 1 ? png : text);
    assert.equal(new Headers(init.headers).get("cookie"), null);
    assert.equal(new Headers(init.headers).get("authorization"), null);
    return new Response(null, { status: 201 });
  };
  const page = {
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
  } as unknown as Page;
  try {
    const result = await executeChatGptWebFirstPartyTurn(page, {
      prompt: "describe",
      selection: { kind: "picker", modelLabel: "GPT-5.5", effortIndex: 2 },
      attachments: [
        {
          kind: "image",
          name: "picture.png",
          mimeType: "image/png",
          size: png.length,
          data: png,
          width: 1,
          height: 1,
        },
        {
          kind: "file",
          name: "document.txt",
          mimeType: "text/plain",
          size: text.length,
          data: text,
        },
      ],
    });
    assert.equal(result, "data: [DONE]\n\n");
    assert.deepEqual(uploads, [
      "https://files.oaiusercontent.com/fixture-file-1?signature=fixture",
      "https://files.oaiusercontent.com/fixture-file-2?signature=fixture",
    ]);
    assert.deepEqual(root[abortKey], {});
    assert.deepEqual(root[requestKey], {});
  } finally {
    globalThis.fetch = originalFetch;
    delete root[bridgeKey];
    delete root[abortKey];
    delete root[requestKey];
  }
});
