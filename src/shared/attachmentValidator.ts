import { InvalidRequestError } from "./errors.ts";
import type { AttachmentSource } from "./types.ts";

export interface AttachmentValidationOptions {
  maxCount?: number;
  maxBytes?: number;
  allowedMimeTypes?: readonly string[];
  maxDimensions?: { width: number; height: number };
  allowRemoteUrls?: boolean;
}

export const DEFAULT_ATTACHMENT_OPTIONS: AttachmentValidationOptions = {
  maxCount: 10,
  maxBytes: 20 * 1024 * 1024, // 20 MB
  allowedMimeTypes: [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "text/plain",
    "text/markdown",
    "application/pdf",
    "application/json",
  ],
  maxDimensions: { width: 8192, height: 8192 },
  allowRemoteUrls: true,
};

export function validateAttachments(
  attachments: AttachmentSource[] | undefined,
  opts: AttachmentValidationOptions = DEFAULT_ATTACHMENT_OPTIONS
): void {
  if (!attachments || attachments.length === 0) return;

  const maxCount = opts.maxCount ?? DEFAULT_ATTACHMENT_OPTIONS.maxCount!;
  if (attachments.length > maxCount) {
    throw new InvalidRequestError(
      `Too many attachments: received ${attachments.length}, maximum allowed is ${maxCount}`
    );
  }

  const maxBytes = opts.maxBytes ?? DEFAULT_ATTACHMENT_OPTIONS.maxBytes!;
  const allowedMimes = opts.allowedMimeTypes ?? DEFAULT_ATTACHMENT_OPTIONS.allowedMimeTypes!;

  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    if (!att.mimeType || !allowedMimes.includes(att.mimeType)) {
      throw new InvalidRequestError(
        `Attachment [${i}] has unsupported MIME type "${att.mimeType}". Allowed: ${allowedMimes.join(", ")}`
      );
    }

    if (att.data) {
      const byteLength = att.data.byteLength;
      if (byteLength > maxBytes) {
        throw new InvalidRequestError(
          `Attachment [${i}] size (${byteLength} bytes) exceeds limit (${maxBytes} bytes)`
        );
      }
    }

    if (att.url) {
      if (!opts.allowRemoteUrls && !att.url.startsWith("data:")) {
        throw new InvalidRequestError(`Attachment [${i}] remote URLs are disallowed`);
      }
      if (att.url.startsWith("http://") || att.url.startsWith("https://")) {
        try {
          const parsed = new URL(att.url);
          // Block link-local, loopback, private ranges for SSRF prevention
          const host = parsed.hostname.toLowerCase();
          if (
            host === "localhost" ||
            host === "127.0.0.1" ||
            host === "::1" ||
            host.startsWith("10.") ||
            host.startsWith("192.168.") ||
            host.startsWith("169.254.") ||
            (host.startsWith("172.") &&
              parseInt(host.split(".")[1] ?? "0", 10) >= 16 &&
              parseInt(host.split(".")[1] ?? "0", 10) <= 31)
          ) {
            throw new InvalidRequestError(
              `Attachment [${i}] URL points to a forbidden private/local host`
            );
          }
        } catch (e) {
          if (e instanceof InvalidRequestError) throw e;
          throw new InvalidRequestError(`Attachment [${i}] has invalid URL "${att.url}"`);
        }
      }
    }

    if (att.dimensions && opts.maxDimensions) {
      if (
        att.dimensions.width > opts.maxDimensions.width ||
        att.dimensions.height > opts.maxDimensions.height
      ) {
        throw new InvalidRequestError(
          `Attachment [${i}] dimensions (${att.dimensions.width}x${att.dimensions.height}) exceed maximum allowed (${opts.maxDimensions.width}x${opts.maxDimensions.height})`
        );
      }
    }
  }
}
