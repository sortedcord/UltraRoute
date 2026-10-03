import type {
  Attachment,
  AttachmentAdapter,
  PendingAttachment,
} from "@assistant-ui/react";
import { getFileDataURL } from "@assistant-ui/core/internal";
import { DEFAULT_ATTACHMENT_OPTIONS } from "../shared/attachmentValidator.ts";
import {
  MAX_CHATGPT_WEB_ATTACHMENTS,
  MAX_CHATGPT_WEB_IMAGE_BYTES,
  MAX_CHATGPT_WEB_FILE_BYTES,
  MAX_CHATGPT_WEB_TOTAL_ATTACHMENT_BYTES,
} from "../shared/chatgptAttachmentLimits.ts";

const mimeByExtension: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  txt: "text/plain",
  md: "text/markdown",
  pdf: "application/pdf",
  json: "application/json",
};

function mediaType(file: File): string {
  const declared = file.type.toLowerCase();
  return declared === "image/jpg"
    ? "image/jpeg"
    : declared ||
        mimeByExtension[file.name.split(".").pop()?.toLowerCase() ?? ""] ||
        "application/octet-stream";
}

function validateFiles(attachments: readonly Attachment[]): void {
  if (attachments.length > MAX_CHATGPT_WEB_ATTACHMENTS) {
    throw new Error(
      `Too many attachments: maximum allowed is ${MAX_CHATGPT_WEB_ATTACHMENTS}`,
    );
  }
  let totalBytes = 0;
  for (const attachment of attachments) {
    const file = attachment.file;
    if (!file) continue;
    const mime = mediaType(file);
    if (!DEFAULT_ATTACHMENT_OPTIONS.allowedMimeTypes!.includes(mime)) {
      throw new Error(`Unsupported attachment type "${mime}" for ${file.name}`);
    }
    if (file.size === 0) throw new Error(`Attachment is empty: ${file.name}`);
    const cap = mime.startsWith("image/")
      ? MAX_CHATGPT_WEB_IMAGE_BYTES
      : MAX_CHATGPT_WEB_FILE_BYTES;
    if (file.size > cap)
      throw new Error(
        `Attachment ${file.name} exceeds the ${cap / (1024 * 1024)} MiB limit`,
      );
    totalBytes += file.size;
  }
  if (totalBytes > MAX_CHATGPT_WEB_TOTAL_ATTACHMENT_BYTES) {
    throw new Error(
      `Combined ChatGPT Web attachments are too large (maximum ${MAX_CHATGPT_WEB_TOTAL_ATTACHMENT_BYTES / (1024 * 1024)} MiB)`,
    );
  }
}

export function createAttachmentAdapter(options: {
  getProvider: () => string | undefined;
  getAttachments: (submission: boolean) => readonly Attachment[];
  onError: (message: string) => void;
}): AttachmentAdapter {
  // Reserve synchronously: the picker adds multiple files concurrently before
  // assistant-ui publishes their resolved pending attachments to the composer.
  const pending = new Map<string, PendingAttachment>();
  const requireProvider = () => {
    if (options.getProvider() !== "chatgpt-web") {
      throw new Error(
        "File and image attachments are only supported by ChatGPT Web. Select a ChatGPT model first.",
      );
    }
  };
  const report = (error: unknown): never => {
    options.onError(
      error instanceof Error ? error.message : "Unable to read attachment",
    );
    throw error;
  };
  return {
    accept: [
      ...DEFAULT_ATTACHMENT_OPTIONS.allowedMimeTypes!,
      ...Object.keys(mimeByExtension).map((extension) => `.${extension}`),
    ].join(","),
    async add({ file }) {
      try {
        requireProvider();
        const attachment: PendingAttachment = {
          id: crypto.randomUUID(),
          type: mediaType(file).startsWith("image/") ? "image" : "file",
          name: file.name,
          contentType: mediaType(file),
          file,
          status: { type: "requires-action", reason: "composer-send" },
        };
        const current = new Map(
          options.getAttachments(false).map((item) => [item.id, item]),
        );
        // Once published, the runtime owns the count. Do not charge files
        // belonging to an in-flight submission against the next draft.
        const published = [
          ...current.keys(),
          ...options.getAttachments(true).map((item) => item.id),
        ];
        for (const id of published) pending.delete(id);
        for (const [id, item] of pending) current.set(id, item);
        current.set(attachment.id, attachment);
        validateFiles([...current.values()]);
        pending.set(attachment.id, attachment);
        return attachment;
      } catch (error) {
        return report(error);
      }
    },
    async send(attachment, readOptions) {
      try {
        requireProvider();
        const batch = options.getAttachments(true);
        validateFiles(batch.length ? batch : [attachment]);
        const encoded = await getFileDataURL(attachment.file, readOptions);
        // Browser File.type can be empty even for accepted extensions; encode
        // the validated MIME consistently with the metadata sent to the server.
        const data = `data:${attachment.contentType};base64,${encoded.slice(encoded.indexOf(",") + 1)}`;
        // The AI SDK converter maps this to {type:"file", url:data,
        // mediaType:mimeType, filename:name}, including for photos.
        return {
          ...attachment,
          status: { type: "complete" },
          content: [
            {
              type: "file",
              mimeType: attachment.contentType!,
              filename: attachment.name,
              data,
            },
          ],
        };
      } catch (error) {
        return report(error);
      } finally {
        pending.delete(attachment.id);
      }
    },
    async remove(attachment) {
      pending.delete(attachment.id);
    },
  };
}
