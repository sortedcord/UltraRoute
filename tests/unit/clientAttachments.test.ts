import { test } from "node:test";
import assert from "node:assert/strict";
import type { Attachment, PendingAttachment } from "@assistant-ui/react";
import { createAttachmentAdapter } from "../../src/client/attachments.ts";
import {
  MAX_CHATGPT_WEB_ATTACHMENTS,
  MAX_CHATGPT_WEB_IMAGE_BYTES,
  MAX_CHATGPT_WEB_TOTAL_ATTACHMENT_BYTES,
} from "../../src/shared/chatgptAttachmentLimits.ts";

function setup() {
  const draft: Attachment[] = [];
  let provider = "chatgpt-web";
  const errors: string[] = [];
  const adapter = createAttachmentAdapter({
    getProvider: () => provider,
    getAttachments: () => draft,
    onError: (message) => errors.push(message),
  });
  return {
    adapter,
    draft,
    errors,
    setProvider: (value: string) => {
      provider = value;
    },
  };
}

function sizedFile(size: number, type: string): File {
  const file = new File(["bytes"], "upload", { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

test("concurrent selection cannot exceed attachment count and removal frees a slot", async () => {
  const { adapter } = setup();
  const results = await Promise.allSettled(
    Array.from({ length: MAX_CHATGPT_WEB_ATTACHMENTS + 1 }, (_, index) =>
      adapter.add({
        file: new File(["x"], `${index}.txt`, { type: "text/plain" }),
      }),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    MAX_CHATGPT_WEB_ATTACHMENTS,
  );
  const failure = results.find((result) => result.status === "rejected");
  assert.match(
    (failure as PromiseRejectedResult).reason.message,
    /Too many attachments/,
  );
  const first = results[0] as PromiseFulfilledResult<PendingAttachment>;
  await adapter.remove(first.value);
  const replacement = (await adapter.add({
    file: new File(["x"], "replacement.txt", { type: "text/plain" }),
  })) as PendingAttachment;
  assert.equal(replacement.name, "replacement.txt");
});

test("image and total byte caps reject excess while exact limits remain selectable", async () => {
  const { adapter, errors } = setup();
  await assert.rejects(
    async () =>
      adapter.add({
        file: sizedFile(MAX_CHATGPT_WEB_IMAGE_BYTES + 1, "image/png"),
      }),
    /20 MiB/,
  );
  const image = (await adapter.add({
    file: sizedFile(MAX_CHATGPT_WEB_IMAGE_BYTES, "image/png"),
  })) as PendingAttachment;
  assert.equal(image.contentType, "image/png");
  await adapter.remove(image);
  await adapter.add({
    file: sizedFile(MAX_CHATGPT_WEB_TOTAL_ATTACHMENT_BYTES, "application/pdf"),
  });
  await assert.rejects(
    async () =>
      adapter.add({
        file: new File(["x"], "extra.txt", { type: "text/plain" }),
      }),
    /Combined/,
  );
  assert.match(errors.at(-1)!, /Combined/);
});

test("file bytes and metadata survive send, and changing provider prevents sending", async () => {
  const { adapter, draft, setProvider } = setup();
  const pdf = (await adapter.add({
    file: new File(["%PDF-1.7\n"], "document.pdf", { type: "application/pdf" }),
  })) as PendingAttachment;
  draft.push(pdf);
  setProvider("gemini-web");
  await assert.rejects(adapter.send(pdf), /only supported by ChatGPT Web/);
  setProvider("chatgpt-web");
  const result = await adapter.send(pdf);
  assert.deepEqual(result.content, [
    {
      type: "file",
      mimeType: "application/pdf",
      filename: "document.pdf",
      data: "data:application/pdf;base64,JVBERi0xLjcK",
    },
  ]);
});

test("unsupported MIME and empty files are rejected rather than sent as names", async () => {
  const { adapter, errors } = setup();
  await assert.rejects(
    async () =>
      adapter.add({
        file: new File(["x"], "script.txt", { type: "application/javascript" }),
      }),
    /Unsupported attachment type/,
  );
  await assert.rejects(
    async () =>
      adapter.add({ file: new File([], "empty.txt", { type: "text/plain" }) }),
    /empty/,
  );
  assert.match(errors[0], /application\/javascript/);
});

test("missing browser MIME uses the inferred type in both metadata and data URL", async () => {
  const { adapter, draft } = setup();
  const text = (await adapter.add({
    file: new File(["hello"], "note.txt"),
  })) as PendingAttachment;
  draft.push(text);
  const result = await adapter.send(text);
  assert.deepEqual(result.content, [
    {
      type: "file",
      mimeType: "text/plain",
      filename: "note.txt",
      data: "data:text/plain;base64,aGVsbG8=",
    },
  ]);
});
