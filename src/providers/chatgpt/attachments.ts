import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { validateAttachments } from "../../shared/attachmentValidator.ts";
import type { AttachmentSource } from "../../shared/types.ts";
import {
  MAX_CHATGPT_WEB_ATTACHMENTS,
  MAX_CHATGPT_WEB_IMAGE_BYTES,
  MAX_CHATGPT_WEB_FILE_BYTES,
  MAX_CHATGPT_WEB_TOTAL_ATTACHMENT_BYTES,
} from "../../shared/chatgptAttachmentLimits.ts";

export type ChatGptWebAttachmentKind = "image" | "file";
export interface ChatGptWebResolvedAttachment {
  kind: ChatGptWebAttachmentKind;
  name: string;
  mimeType: string;
  size: number;
  data: Buffer;
  width?: number;
  height?: number;
}
const MAX_CURSOR_IMAGE_DECODE_EDGE = 8192;
const MAX_CURSOR_IMAGE_PIXELS = 25_000_000;
const REMOTE_FETCH_TIMEOUT_MS = 20_000;
type Address = { address: string; family: number };
export interface ChatGptWebAttachmentDeps {
  lookup?: (hostname: string) => Promise<Address[]>;
  fetchRemoteMedia?: (
    url: URL,
    options: { address: Address; maxBytes: number; signal: AbortSignal },
  ) => Promise<{ bytes: Buffer; mimeType: string }>;
  request?: typeof httpRequest;
  signal?: AbortSignal | null;
}
export class ChatGptWebAttachmentError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ChatGptWebAttachmentError";
  }
}
const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blockedV4.addSubnet(network, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
blockedV6.addSubnet("2001::", 23, "ipv6");
blockedV6.addSubnet("2001:db8::", 32, "ipv6");
blockedV6.addSubnet("2002::", 16, "ipv6");
export function isPublicAttachmentAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !blockedV4.check(address, "ipv4")
    : family === 6 &&
        globalV6.check(address, "ipv6") &&
        !blockedV6.check(address, "ipv6");
}
function sanitizeFilename(value: string | undefined, fallback: string): string {
  const leaf = (value ?? "")
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return (leaf && leaf !== "." && leaf !== ".." ? leaf : fallback).slice(
    0,
    180,
  );
}
function decodeDataUrl(
  ref: string,
  cap: number,
): { bytes: Buffer; mimeType: string } {
  const match = /^data:([^;,]*);base64,([\s\S]*)$/i.exec(ref);
  if (!match)
    throw new ChatGptWebAttachmentError(
      "Attachment data URL must be base64 encoded",
    );
  if (match[2].length > Math.ceil(cap / 3) * 4 + 1024)
    throw new ChatGptWebAttachmentError("Attachment is too large");
  const normalized = match[2].replace(/\s/g, "");
  if (
    !normalized ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)
  )
    throw new ChatGptWebAttachmentError(
      "Attachment contains invalid base64 data",
    );
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.toString("base64") !== normalized)
    throw new ChatGptWebAttachmentError(
      "Attachment contains invalid base64 data",
    );
  return {
    bytes,
    mimeType: match[1].toLowerCase() || "application/octet-stream",
  };
}
function fetchPinnedRemote(
  url: URL,
  options: { address: Address; maxBytes: number; signal: AbortSignal },
  requestFactory: typeof httpRequest = url.protocol === "https:"
    ? httpsRequest
    : httpRequest,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    bytes: Buffer;
    mimeType: string;
  }>();
  const request = requestFactory(
    url,
    {
      method: "GET",
      signal: options.signal,
      family: options.address.family,
      lookup: (_hostname, _options, callback) =>
        callback(null, options.address.address, options.address.family),
    },
    (response) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        response.destroy();
        reject(
          new ChatGptWebAttachmentError(
            status >= 300 && status < 400
              ? "Attachment redirects are blocked"
              : `Attachment URL returned status ${status}`,
          ),
        );
        return;
      }
      if (Number(response.headers["content-length"] ?? 0) > options.maxBytes) {
        response.destroy();
        reject(new ChatGptWebAttachmentError("Attachment is too large"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxBytes) {
          response.destroy(
            new ChatGptWebAttachmentError("Attachment is too large"),
          );
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () =>
        resolve({
          bytes: Buffer.concat(chunks, size),
          mimeType: (
            response.headers["content-type"] ?? "application/octet-stream"
          )
            .split(";", 1)[0]
            .trim()
            .toLowerCase(),
        }),
      );
    },
  );
  request.on("error", reject);
  request.end();
  return promise;
}
async function fetchRemoteAttachment(
  ref: string,
  maxBytes: number,
  deps: ChatGptWebAttachmentDeps,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const { promise: aborted, reject: rejectAborted } =
    Promise.withResolvers<never>();
  const onAbort = () => rejectAborted(new Error("Aborted"));
  controller.signal.addEventListener("abort", onAbort, { once: true });
  deps.signal?.addEventListener("abort", abort, { once: true });
  if (deps.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, REMOTE_FETCH_TIMEOUT_MS);
  timer.unref?.();
  try {
    const url = new URL(ref);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new ChatGptWebAttachmentError(
        "Attachment URL is invalid or blocked",
      );
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await Promise.race([
          (deps.lookup ?? ((host: string) => dnsLookup(host, { all: true })))(
            hostname,
          ),
          aborted,
        ]);
    if (
      !addresses.length ||
      addresses.some(({ address }) => !isPublicAttachmentAddress(address))
    )
      throw new ChatGptWebAttachmentError(
        "Attachment URL is invalid or blocked",
      );
    controller.signal.throwIfAborted();
    return await Promise.race([
      deps.fetchRemoteMedia
        ? deps.fetchRemoteMedia(url, {
            address: addresses[0],
            maxBytes,
            signal: controller.signal,
          })
        : fetchPinnedRemote(
            url,
            { address: addresses[0], maxBytes, signal: controller.signal },
            deps.request,
          ),
      aborted,
    ]);
  } catch (error) {
    if (error instanceof ChatGptWebAttachmentError) throw error;
    if (deps.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    throw new ChatGptWebAttachmentError("Attachment URL could not be fetched");
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

/** Magic-byte format sniff (independent of declared MIME). */
function sniffImageFormat(
  data: Uint8Array,
): "png" | "jpeg" | "gif" | "webp" | undefined {
  if (
    data.byteLength >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return "png";
  }
  if (
    data.byteLength >= 6 &&
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x38
  ) {
    return "gif";
  }
  if (data.byteLength >= 4 && data[0] === 0xff && data[1] === 0xd8)
    return "jpeg";
  if (
    data.byteLength >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return "webp";
  }
  return undefined;
}

/**
 * Sniff PNG/JPEG/GIF/WebP dimensions from raw bytes when the header is present.
 * Best-effort only — unknown formats return undefined (dimension is optional).
 */
function sniffImageDimensions(
  data: Uint8Array,
): { width: number; height: number } | undefined {
  // PNG: signature + IHDR chunk (width/height at bytes 16..23)
  if (
    data.byteLength >= 24 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    const width =
      ((data[16]! << 24) | (data[17]! << 16) | (data[18]! << 8) | data[19]!) >>>
      0;
    const height =
      ((data[20]! << 24) | (data[21]! << 16) | (data[22]! << 8) | data[23]!) >>>
      0;
    if (width > 0 && height > 0) return { width, height };
  }
  // GIF: "GIF8" + width/height as little-endian u16 at bytes 6..9
  if (
    data.byteLength >= 10 &&
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x38
  ) {
    const width = data[6]! | (data[7]! << 8);
    const height = data[8]! | (data[9]! << 8);
    if (width > 0 && height > 0) return { width, height };
  }
  // WebP: RIFF....WEBP + VP8X / VP8 / VP8L
  if (
    data.byteLength >= 30 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    const fourcc = String.fromCharCode(
      data[12]!,
      data[13]!,
      data[14]!,
      data[15]!,
    );
    if (fourcc === "VP8X") {
      const width = 1 + (data[24]! | (data[25]! << 8) | (data[26]! << 16));
      const height = 1 + (data[27]! | (data[28]! << 8) | (data[29]! << 16));
      if (width > 0 && height > 0) return { width, height };
    } else if (fourcc === "VP8 ") {
      if (data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
        const width = (data[26]! | (data[27]! << 8)) & 0x3fff;
        const height = (data[28]! | (data[29]! << 8)) & 0x3fff;
        if (width > 0 && height > 0) return { width, height };
      }
    } else if (fourcc === "VP8L" && data[20] === 0x2f) {
      const raw =
        data[21]! | (data[22]! << 8) | (data[23]! << 16) | (data[24]! << 24);
      const width = (raw & 0x3fff) + 1;
      const height = ((raw >> 14) & 0x3fff) + 1;
      if (width > 0 && height > 0) return { width, height };
    }
  }
  // JPEG: scan for SOF0/SOF2 marker with dimensions
  if (data.byteLength >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < data.byteLength) {
      if (data[offset] !== 0xff) break;
      const marker = data[offset + 1]!;
      // Standalone markers (TEM, RSTn, SOI, EOI) carry no length payload.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        offset += 2;
        continue;
      }
      const length = (data[offset + 2]! << 8) | data[offset + 3]!;
      if (marker === 0xc0 || marker === 0xc2) {
        const height = (data[offset + 5]! << 8) | data[offset + 6]!;
        const width = (data[offset + 7]! << 8) | data[offset + 8]!;
        if (width > 0 && height > 0) return { width, height };
        break;
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  return undefined;
}
function validateImage(
  bytes: Buffer,
  declaredMimeType: string,
): { mimeType: string; width: number; height: number } {
  const format = sniffImageFormat(bytes);
  const dimensions = sniffImageDimensions(bytes);
  const mimeType =
    format === "jpeg" ? "image/jpeg" : format ? `image/${format}` : undefined;
  if (!mimeType || !dimensions)
    throw new ChatGptWebAttachmentError(
      "Image attachment is undecodable or unsupported",
    );
  if (
    declaredMimeType !== mimeType &&
    !(declaredMimeType === "image/jpg" && mimeType === "image/jpeg")
  )
    throw new ChatGptWebAttachmentError(
      "Image attachment type does not match its data",
    );
  if (
    Math.max(dimensions.width, dimensions.height) >
      MAX_CURSOR_IMAGE_DECODE_EDGE ||
    dimensions.width * dimensions.height > MAX_CURSOR_IMAGE_PIXELS
  )
    throw new ChatGptWebAttachmentError(
      "Image attachment dimensions are too large",
    );
  return { mimeType, ...dimensions };
}
export async function resolveChatGptWebAttachments(
  sources: AttachmentSource[],
  deps: ChatGptWebAttachmentDeps = {},
): Promise<ChatGptWebResolvedAttachment[]> {
  try {
    validateAttachments(sources, {
      maxCount: MAX_CHATGPT_WEB_ATTACHMENTS,
      maxBytes: MAX_CHATGPT_WEB_FILE_BYTES,
      maxDimensions: { width: 8192, height: 8192 },
      allowRemoteUrls: true,
    });
  } catch {
    throw new ChatGptWebAttachmentError(
      "ChatGPT Web attachment validation failed",
    );
  }
  const resolved: ChatGptWebResolvedAttachment[] = [];
  let total = 0;
  for (const source of sources) {
    deps.signal?.throwIfAborted();
    const cap =
      source.type === "image"
        ? MAX_CHATGPT_WEB_IMAGE_BYTES
        : MAX_CHATGPT_WEB_FILE_BYTES;
    if (!source.data && !source.url)
      throw new ChatGptWebAttachmentError("Attachment requires data or a URL");
    const loaded = source.data
      ? {
          bytes: Buffer.isBuffer(source.data)
            ? source.data
            : Buffer.from(
                source.data.buffer,
                source.data.byteOffset,
                source.data.byteLength,
              ),
          mimeType: source.mimeType,
        }
      : source.url!.toLowerCase().startsWith("data:")
        ? decodeDataUrl(source.url!, cap)
        : await fetchRemoteAttachment(source.url!, cap, deps);
    if (!loaded.bytes.length)
      throw new ChatGptWebAttachmentError("Attachment is empty");
    if (loaded.bytes.length > cap)
      throw new ChatGptWebAttachmentError("Attachment is too large");
    total += loaded.bytes.length;
    if (total > MAX_CHATGPT_WEB_TOTAL_ATTACHMENT_BYTES)
      throw new ChatGptWebAttachmentError(
        "Combined ChatGPT Web attachments are too large",
      );
    const image =
      source.type === "image"
        ? validateImage(loaded.bytes, source.mimeType)
        : undefined;
    if (
      source.type === "image" &&
      loaded.mimeType.startsWith("image/") &&
      loaded.mimeType !== image!.mimeType &&
      !(loaded.mimeType === "image/jpg" && image!.mimeType === "image/jpeg")
    )
      throw new ChatGptWebAttachmentError(
        "Image attachment type does not match its data",
      );
    const extension = image
      ? image.mimeType.split("/")[1].replace("jpeg", "jpg")
      : "bin";
    resolved.push({
      kind: source.type,
      name: sanitizeFilename(
        source.fileName,
        `${source.type}-${resolved.length + 1}.${extension}`,
      ),
      mimeType: image?.mimeType ?? source.mimeType,
      size: loaded.bytes.length,
      data: loaded.bytes,
      ...(image ? { width: image.width, height: image.height } : {}),
    });
  }
  return resolved;
}
