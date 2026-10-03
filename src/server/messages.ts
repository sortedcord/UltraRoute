import { InvalidRequestError } from "../shared/errors.ts";
import type { AttachmentSource, ChatMessage } from "../shared/types.ts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidRequestError("Invalid message content part");
  }
  return value as Record<string, unknown>;
}

function attachment(part: Record<string, unknown>): AttachmentSource {
  const nativeFile =
    part.type === "file" && part.file !== undefined
      ? record(part.file)
      : undefined;
  const nativeImage =
    part.type === "image_url" ? record(part.image_url) : undefined;
  const url =
    nativeFile?.url ??
    nativeImage?.url ??
    (part.type === "image"
      ? (part.image ?? part.url)
      : (part.url ?? part.data));
  if (typeof url !== "string" || !url) {
    throw new InvalidRequestError(
      "File and image parts require a URL or data URL",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidRequestError("Invalid attachment URL");
  }
  if (!["data:", "https:", "http:"].includes(parsed.protocol)) {
    throw new InvalidRequestError("Unsupported attachment URL scheme");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new InvalidRequestError(
      "Attachment URLs cannot contain credentials or fragments",
    );
  }
  const declaredMime = nativeFile?.mimeType ?? part.mediaType ?? part.mimeType;
  const inferredMime = /^data:([^;,]+);base64,/i.exec(url)?.[1];
  const mimeType = declaredMime ?? inferredMime;
  if (typeof mimeType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) {
    throw new InvalidRequestError(
      "Attachment mediaType is required and must be a MIME type",
    );
  }
  const fileName = nativeFile?.fileName ?? part.filename ?? part.fileName;
  if (
    fileName !== undefined &&
    (typeof fileName !== "string" || !fileName.trim())
  ) {
    throw new InvalidRequestError(
      "Attachment filename must be a non-empty string",
    );
  }
  const image =
    part.type === "image" ||
    part.type === "image_url" ||
    mimeType.toLowerCase().startsWith("image/");
  if (image && !mimeType.toLowerCase().startsWith("image/")) {
    throw new InvalidRequestError("Image parts require an image mediaType");
  }
  return {
    type: image ? "image" : "file",
    url,
    mimeType: mimeType.toLowerCase(),
    ...(fileName === undefined ? {} : { fileName: fileName as string }),
  };
}
// Assistant UI history includes provenance and private reasoning alongside the final answer.
// These known display-only parts are not new prompt content; user parts remain strict.
const ASSISTANT_HISTORY_METADATA: Record<string, true> = {
  reasoning: true,
  "step-start": true,
  "source-url": true,
  "source-document": true,
};

/** Preserve AI SDK file metadata; the ChatGPT resolver owns decoding, limits, and remote URL safety. */
export function convertHttpChatMessages(
  rawMessages: unknown,
  providerId: string,
): {
  messages: ChatMessage[];
  attachments: AttachmentSource[];
} {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new InvalidRequestError("Messages cannot be empty");
  }
  const attachments: AttachmentSource[] = [];
  const messages = rawMessages.map((raw): ChatMessage => {
    const message = record(raw);
    const role = message.role;
    if (role !== "user" && role !== "assistant" && role !== "system") {
      throw new InvalidRequestError("Unsupported message role");
    }
    if (message.parts !== undefined && !Array.isArray(message.parts)) {
      throw new InvalidRequestError("Message parts must be an array");
    }
    const parts = message.parts ?? message.content;
    if (typeof parts === "string") return { role, content: parts };
    if (!Array.isArray(parts))
      throw new InvalidRequestError("Message content must be text or parts");
    const text: string[] = [];
    for (const rawPart of parts) {
      const part = record(rawPart);
      if (part.type === "text" && typeof part.text === "string") {
        text.push(part.text);
      } else if (
        part.type === "file" ||
        part.type === "image" ||
        part.type === "image_url"
      ) {
        if (providerId !== "chatgpt-web") {
          throw new InvalidRequestError(
            "File and image HTTP parts are only supported by ChatGPT Web",
          );
        }
        attachments.push(attachment(part));
      } else if (
        role === "assistant" &&
        typeof part.type === "string" &&
        Object.hasOwn(ASSISTANT_HISTORY_METADATA, part.type)
      ) {
        continue;
      } else {
        throw new InvalidRequestError("Unsupported message content part");
      }
    }
    return { role, content: text.join("") };
  });
  return { messages, attachments };
}
