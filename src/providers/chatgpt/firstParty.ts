/*
MIT License

Copyright (c) 2026 diegosouzapw

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import type { Page } from "playwright";
import {
  ChallengeRequiredError,
  CredentialError,
  GenericUpstreamError,
  InvalidRequestError,
  ProviderTimeoutError,
  RateLimitError,
  UpstreamDriftError,
  WebProviderError,
} from "../../shared/errors.ts";
import type { ChatGptWebResolvedAttachment } from "./attachments.ts";

type JsonRecord = Record<string, unknown>;
export interface ChatGptWebFirstPartyRequest {
  prompt: string;
  attachments: ChatGptWebResolvedAttachment[];
  selection: ChatGptWebSelection;
}
export interface ChatGptWebSelection {
  model: string;
  thinkingEffort?: string;
}
interface RegisteredAttachment {
  fileId: string;
  uploadUrl: string;
  attachment: ChatGptWebResolvedAttachment;
}
interface BrowserAttachment {
  fileId?: string;
  kind: ChatGptWebResolvedAttachment["kind"];
  mimeType: string;
  name: string;
  size: number;
  width?: number;
  height?: number;
}
type BridgeResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      kind: "drift" | "status" | "challenge" | "timeout" | "abort" | "request";
      status?: number;
      category?: string;
    };
const BRIDGE_KEY = "__ultrarouteChatGptFirstPartyV2";
const OAI_UPLOAD_HOST_RE = /(?:^|\.)oaiusercontent\.com$/i;
const pageInitializations = new WeakMap<Page, Promise<void>>();
const pageRequestTails = new WeakMap<Page, Promise<void>>();
const INITIALIZATION_TIMEOUT_MS = 20_000;
const TURN_TIMEOUT_MS = 240_000;
const RESPONSE_LIMIT = 16 * 1024 * 1024;

function unwrap<T>(result: BridgeResult<T>): T {
  if (result.ok) return result.value;
  const details = {
    category: result.category ?? "native-request",
    ...(result.status ? { status: result.status } : {}),
  };
  if (result.kind === "abort") throw new DOMException("Aborted", "AbortError");
  if (result.kind === "timeout")
    throw new ProviderTimeoutError(
      "ChatGPT Web native request timed out",
      details,
    );
  if (result.kind === "challenge" || result.status === 403)
    throw new ChallengeRequiredError(
      "ChatGPT Web requires operator browser verification",
      details,
    );
  if (result.status === 401)
    throw new CredentialError(
      "ChatGPT Web session is invalid or expired",
      details,
    );
  if (result.status === 429)
    throw new RateLimitError("ChatGPT Web rate limit reached", details);
  if (result.status === 408 || result.status === 504)
    throw new ProviderTimeoutError(
      "ChatGPT Web native request timed out",
      details,
    );
  if (result.kind === "drift")
    throw new UpstreamDriftError(
      "ChatGPT Web native request contract is unavailable or malformed",
      details,
    );
  if (result.status && result.status >= 400 && result.status < 500)
    throw new InvalidRequestError(
      "ChatGPT Web rejected the native request",
      details,
    );
  throw new GenericUpstreamError(
    "ChatGPT Web native request failed",
    502,
    true,
    details,
  );
}

/** Await browser work without exposing page errors, response bodies, or signed URLs. */
async function abortable<T>(
  work: Promise<T>,
  signal?: AbortSignal | null,
): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    void work.catch(() => {});
    throw new DOMException("Aborted", "AbortError");
  }
  const { promise, reject } = Promise.withResolvers<never>();
  const abort = () => reject(new DOMException("Aborted", "AbortError"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([work, promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Import only the current manifest's native runtime, then inspect its cached exports. */
export async function initializeChatGptWebFirstPartyBridge(
  page: Page,
  signal?: AbortSignal | null,
): Promise<void> {
  let initialization = pageInitializations.get(page);
  if (!initialization) {
    initialization = (async () => {
      let timer: NodeJS.Timeout | undefined;
      const { promise: expired, reject } = Promise.withResolvers<never>();
      timer = setTimeout(
        () =>
          reject(
            new ProviderTimeoutError(
              "ChatGPT Web native runtime discovery timed out",
              { category: "runtime-timeout" },
            ),
          ),
        INITIALIZATION_TIMEOUT_MS,
      );
      try {
        const result = await Promise.race([
          page.evaluate(
            async ({ bridgeKey, responseLimit, readinessTimeout }) => {
              type RequestClient = {
                safeGet(path: string, options?: JsonRecord): Promise<unknown>;
                safePost(path: string, options: JsonRecord): Promise<unknown>;
                postResponse(
                  path: string,
                  options: JsonRecord,
                ): Promise<Response>;
              };
              type Integrity = (
                callback: (p: unknown) => Promise<unknown>,
              ) => Promise<{ headers: Record<string, string> }>;
              type Runtime = Function & {
                m: Record<string, Function>;
                c: Record<string, { exports: unknown }>;
              };
              type BrowserBridge = {
                requestClient: RequestClient;
                integrity: Integrity;
                begin(id: string): void;
                abort(id: string): void;
                cleanup(id: string): Promise<void>;
                register(
                  id: string,
                  metadata: BrowserAttachment[],
                ): Promise<unknown>;
                process(
                  id: string,
                  metadata: BrowserAttachment[],
                ): Promise<void>;
                converse(id: string, body: JsonRecord): Promise<string>;
                accountIdentity(): string;
                models(id: string, expectedIdentity?: string): Promise<unknown>;
              };
              const root = globalThis as typeof globalThis &
                Record<string, unknown>;
              const ready = (value: unknown): value is BrowserBridge => {
                const bridge = value as BrowserBridge | undefined;
                return (
                  typeof bridge?.requestClient?.safePost === "function" &&
                  typeof bridge?.requestClient?.postResponse === "function" &&
                  typeof bridge?.requestClient?.safeGet === "function" &&
                  typeof bridge?.integrity === "function" &&
                  [
                    bridge.begin,
                    bridge.abort,
                    bridge.cleanup,
                    bridge.register,
                    bridge.process,
                    bridge.converse,
                    bridge.accountIdentity,
                    bridge.models,
                  ].every((member) => typeof member === "function")
                );
              };
              if (ready(root[bridgeKey]))
                return { ok: true as const, value: undefined };
              const failure = (
                kind:
                  | "drift"
                  | "status"
                  | "challenge"
                  | "timeout"
                  | "abort"
                  | "request",
                category: string,
                status?: number,
              ) => ({
                ok: false as const,
                kind,
                category,
                ...(status ? { status } : {}),
              });
              try {
                const deadline = Date.now() + readinessTimeout;
                let requestClient: RequestClient | undefined;
                let integrity: Integrity | undefined;
                const imported = new Map<string, Runtime>();
                while (
                  (!requestClient || !integrity) &&
                  Date.now() < deadline
                ) {
                  const bootstrapElement =
                    document.getElementById("client-bootstrap");
                  if (!bootstrapElement?.textContent) {
                    await new Promise<void>((resolve) =>
                      setTimeout(
                        resolve,
                        Math.min(250, Math.max(1, deadline - Date.now())),
                      ),
                    );
                    continue;
                  }
                  {
                    let bootstrap: {
                      authStatus?: string;
                      session?: { accessToken?: unknown };
                    };
                    try {
                      bootstrap = JSON.parse(bootstrapElement.textContent);
                    } catch {
                      return failure("drift", "bootstrap-shape");
                    }
                    if (
                      bootstrap.authStatus !== "logged_in" ||
                      typeof bootstrap.session?.accessToken !== "string" ||
                      !bootstrap.session.accessToken
                    )
                      return failure("status", "bootstrap-auth", 401);
                  }
                  const manifest = root.__reactRouterManifest as
                    { entry?: { imports?: unknown[] } } | undefined;
                  const urls = (manifest?.entry?.imports ?? []).filter(
                    (value): value is string => {
                      if (typeof value !== "string") return false;
                      try {
                        const url = new URL(value, "https://chatgpt.com");
                        return (
                          url.origin === "https://chatgpt.com" &&
                          /^\/cdn\/assets\/[A-Za-z0-9_.-]+\.js$/.test(
                            url.pathname,
                          ) &&
                          !url.username &&
                          !url.password &&
                          !url.search &&
                          !url.hash
                        );
                      } catch {
                        return false;
                      }
                    },
                  );
                  for (const url of new Set(urls)) {
                    // The asset URL is deployment-selected by the current page manifest.
                    let runtime = imported.get(url);
                    if (!runtime) {
                      const namespace = await import(
                        new URL(url, "https://chatgpt.com").href
                      );
                      const candidate = namespace.__webpack_require__ as
                        Runtime | undefined;
                      if (
                        typeof candidate !== "function" ||
                        !candidate.m ||
                        !candidate.c
                      )
                        continue;
                      runtime = candidate;
                      imported.set(url, runtime);
                    }
                    const loadedRuntime = runtime;
                    const exportsOf = (id: string): unknown[] => {
                      const value = loadedRuntime.c[id]?.exports;
                      return value &&
                        (typeof value === "object" ||
                          typeof value === "function")
                        ? [value, ...Object.values(value)]
                        : [];
                    };
                    const isClient = (value: unknown): value is RequestClient =>
                      typeof (value as RequestClient)?.safePost ===
                        "function" &&
                      typeof (value as RequestClient)?.postResponse ===
                        "function" &&
                      typeof (value as RequestClient)?.safeGet === "function";
                    // This factory is the current requirements caller. Only dependencies with
                    // cached exports are candidates; no dormant factory is ever executed.
                    for (const factory of Object.values(loadedRuntime.m)) {
                      const source = Function.prototype.toString.call(factory);
                      if (
                        !source.includes("/sentinel/chat-requirements/prepare")
                      )
                        continue;
                      const parameters = source
                        .match(/^[^(]*\(([^)]*)\)/)?.[1]
                        ?.split(",")
                        .map((part) => part.trim());
                      const requireName = parameters?.[2];
                      if (
                        !requireName ||
                        !/^[A-Za-z_$][\w$]*$/.test(requireName)
                      )
                        continue;
                      const escaped = requireName.replace(
                        /[.*+?^${}()|[\]\\]/g,
                        "\\$&",
                      );
                      const dependencies = Array.from(
                        source.matchAll(
                          new RegExp(
                            `(?<![\\w$])${escaped}\\(\\s*["'\x60]([^"'\x60]+)["'\x60]\\s*\\)`,
                            "g",
                          ),
                        ),
                        (match) => match[1],
                      );
                      const clients = Array.from(
                        new Set(
                          dependencies.flatMap(exportsOf).filter(isClient),
                        ),
                      );
                      if (clients.length !== 1) continue;
                      const candidates = Array.from(
                        new Set(
                          dependencies.flatMap((id) => {
                            const evidence = Function.prototype.toString.call(
                              loadedRuntime.m[id] ?? (() => {}),
                            );
                            if (
                              !evidence.includes(
                                "Chat requirements returned a non-object response.",
                              ) ||
                              !/chat.?requirements/i.test(evidence)
                            )
                              return [];
                            return exportsOf(id).filter(
                              (value): value is Integrity => {
                                if (typeof value !== "function") return false;
                                const body =
                                  Function.prototype.toString.call(value);
                                return (
                                  /headers/.test(body) &&
                                  /chatRequirements|chat.requirements|non-object response/.test(
                                    body,
                                  )
                                );
                              },
                            );
                          }),
                        ),
                      );
                      if (candidates.length === 1) {
                        requestClient = clients[0];
                        integrity = candidates[0];
                        break;
                      }
                    }
                    if (requestClient && integrity) break;
                  }
                  if (!requestClient || !integrity)
                    await new Promise<void>((resolve) =>
                      setTimeout(
                        resolve,
                        Math.min(250, Math.max(1, deadline - Date.now())),
                      ),
                    );
                }
                if (!requestClient || !integrity)
                  return failure(
                    imported.size ? "drift" : "timeout",
                    imported.size ? "runtime-contract" : "runtime-readiness",
                  );
                const client = requestClient;
                const nativeIntegrity = integrity;
                const controllers = new Map<string, AbortController>();
                const readers = new Map<
                  string,
                  ReadableStreamDefaultReader<Uint8Array>
                >();
                const scope = (id: string) => {
                  const controller = controllers.get(id);
                  if (!controller)
                    throw { bridgeKind: "drift", category: "request-scope" };
                  controller.signal.throwIfAborted();
                  return controller;
                };
                const read = async (
                  id: string,
                  response: Response,
                ): Promise<string> => {
                  if (!(response instanceof Response))
                    throw { bridgeKind: "drift", category: "response-shape" };
                  if (!response.ok) {
                    await response.body?.cancel().catch(() => {});
                    throw { bridgeKind: "status", status: response.status };
                  }
                  if (
                    /text\/html/i.test(
                      response.headers.get("content-type") ?? "",
                    )
                  ) {
                    await response.body?.cancel().catch(() => {});
                    throw { bridgeKind: "challenge" };
                  }
                  const reader = response.body?.getReader();
                  if (!reader)
                    throw { bridgeKind: "drift", category: "response-body" };
                  let controller: AbortController;
                  try {
                    controller = scope(id);
                  } catch (error) {
                    await reader.cancel().catch(() => {});
                    reader.releaseLock();
                    throw error;
                  }
                  const abort = () => {
                    void reader.cancel().catch(() => {});
                  };
                  readers.set(id, reader);
                  controller.signal.addEventListener("abort", abort, {
                    once: true,
                  });
                  const decoder = new TextDecoder("utf-8", { fatal: true });
                  const chunks: string[] = [];
                  let bytes = 0;
                  try {
                    for (;;) {
                      const { value, done } = await reader.read();
                      controller.signal.throwIfAborted();
                      if (done) break;
                      bytes += value.byteLength;
                      if (bytes > responseLimit)
                        throw {
                          bridgeKind: "drift",
                          category: "response-size",
                        };
                      try {
                        chunks.push(decoder.decode(value, { stream: true }));
                      } catch {
                        throw {
                          bridgeKind: "drift",
                          category: "response-utf8",
                        };
                      }
                    }
                    try {
                      chunks.push(decoder.decode());
                    } catch {
                      throw { bridgeKind: "drift", category: "response-utf8" };
                    }
                    return chunks.join("");
                  } finally {
                    controller.signal.removeEventListener("abort", abort);
                    await reader.cancel().catch(() => {});
                    readers.delete(id);
                    reader.releaseLock();
                  }
                };
                const bridge: BrowserBridge = {
                  requestClient: client,
                  integrity: nativeIntegrity,
                  accountIdentity() {
                    const source =
                      document.getElementById("client-bootstrap")?.textContent;
                    let bootstrap: {
                      authStatus?: string;
                      session?: {
                        user?: { id?: unknown };
                        account?: { id?: unknown };
                      };
                    };
                    try {
                      bootstrap = JSON.parse(source ?? "{}");
                    } catch {
                      throw {
                        bridgeKind: "drift",
                        category: "bootstrap-shape",
                      };
                    }
                    const user = bootstrap.session?.user?.id;
                    const account = bootstrap.session?.account?.id;
                    if (
                      bootstrap.authStatus !== "logged_in" ||
                      typeof user !== "string" ||
                      !user ||
                      typeof account !== "string" ||
                      !account
                    )
                      throw { bridgeKind: "status", status: 401 };
                    return JSON.stringify([user, account]);
                  },
                  async models(id, expectedIdentity) {
                    const controller = scope(id);
                    const identity = this.accountIdentity();
                    if (
                      expectedIdentity !== undefined &&
                      expectedIdentity !== identity
                    )
                      throw { bridgeKind: "status", status: 401 };
                    const catalog = await client.safeGet("/models", {
                      signal: controller.signal,
                    });
                    controller.signal.throwIfAborted();
                    if (this.accountIdentity() !== identity)
                      throw { bridgeKind: "status", status: 401 };
                    return catalog;
                  },
                  begin(id) {
                    controllers.set(id, new AbortController());
                  },
                  abort(id) {
                    controllers.get(id)?.abort();
                  },
                  async cleanup(id) {
                    controllers.get(id)?.abort();
                    await readers
                      .get(id)
                      ?.cancel()
                      .catch(() => {});
                    controllers.delete(id);
                    readers.delete(id);
                  },
                  async register(id, metadata) {
                    const controller = scope(id);
                    const registrations = [];
                    for (const attachment of metadata) {
                      const payload = (await client.safePost("/files", {
                        requestBody: {
                          file_name: attachment.name,
                          file_size: attachment.size,
                          use_case:
                            attachment.kind === "image"
                              ? "multimodal"
                              : "my_files",
                          timezone_offset_min: new Date().getTimezoneOffset(),
                          reset_rate_limits: false,
                          supports_direct_azure_multipart: true,
                          mime_type: attachment.mimeType,
                          entry_surface: "chat_composer",
                          selection_method: "file_picker",
                          client_resolved_mime_type: attachment.mimeType,
                          mime_resolution_source: "filename_extension",
                          store_in_library: false,
                        },
                        signal: controller.signal,
                      })) as JsonRecord;
                      controller.signal.throwIfAborted();
                      if (
                        !payload ||
                        typeof payload.file_id !== "string" ||
                        !payload.file_id ||
                        typeof payload.upload_url !== "string" ||
                        !payload.upload_url
                      )
                        throw {
                          bridgeKind: "drift",
                          category: "registration-shape",
                        };
                      registrations.push({
                        fileId: payload.file_id,
                        uploadUrl: payload.upload_url,
                      });
                    }
                    return registrations;
                  },
                  async process(id, metadata) {
                    const controller = scope(id);
                    for (const item of metadata) {
                      await read(
                        id,
                        await client.postResponse(
                          "/files/process_upload_stream",
                          {
                            requestBody: {
                              file_id: item.fileId,
                              use_case:
                                item.kind === "image"
                                  ? "multimodal"
                                  : "my_files",
                              index_for_retrieval: item.kind !== "image",
                              file_name: item.name,
                              entry_surface: "chat_composer",
                              metadata: {
                                store_in_library: false,
                                is_temporary_chat: true,
                                library_eligibility_reason: "eligible",
                                is_project_thread: false,
                              },
                            },
                            signal: controller.signal,
                          },
                        ),
                      );
                    }
                  },
                  async converse(id, body) {
                    const controller = scope(id);
                    const integrityResult = await nativeIntegrity((p) =>
                      client.safePost("/sentinel/chat-requirements/prepare", {
                        requestBody: { p },
                        signal: controller.signal,
                      }),
                    );
                    controller.signal.throwIfAborted();
                    if (
                      !integrityResult ||
                      typeof integrityResult.headers !== "object" ||
                      !integrityResult.headers
                    )
                      throw {
                        bridgeKind: "drift",
                        category: "integrity-shape",
                      };
                    return read(
                      id,
                      await client.postResponse("/f/conversation", {
                        requestBody: body,
                        additionalHeaders: integrityResult.headers,
                        signal: controller.signal,
                      }),
                    );
                  },
                };
                root[bridgeKey] = bridge;
                return { ok: true as const, value: undefined };
              } catch {
                return failure("drift", "runtime-discovery");
              }
            },
            {
              bridgeKey: BRIDGE_KEY,
              responseLimit: RESPONSE_LIMIT,
              readinessTimeout: INITIALIZATION_TIMEOUT_MS - 1_000,
            },
          ),
          expired,
        ]);
        unwrap(result);
      } catch (error) {
        if (error instanceof WebProviderError) throw error;
        throw new UpstreamDriftError(
          "ChatGPT Web native runtime discovery failed",
          { category: "runtime-evaluation" },
        );
      } finally {
        clearTimeout(timer);
      }
    })();
    pageInitializations.set(page, initialization);
    void initialization.catch(() => {
      if (pageInitializations.get(page) === initialization)
        pageInitializations.delete(page);
    });
  }
  await abortable(initialization, signal);
}

async function callBridge<T>(
  page: Page,
  method: string,
  requestId: string,
  value?: unknown,
): Promise<T> {
  const result = await page.evaluate(
    async ({ bridgeKey, method, requestId, value }) => {
      const root = globalThis as typeof globalThis & Record<string, unknown>;
      const bridge = root[bridgeKey] as Record<string, Function> | undefined;
      try {
        if (typeof bridge?.[method] !== "function")
          throw { bridgeKind: "drift", category: "bridge-contract" };
        return {
          ok: true as const,
          value: await bridge[method](requestId, value),
        };
      } catch (error) {
        const problem = error as {
          bridgeKind?: string;
          category?: string;
          status?: unknown;
          statusCode?: unknown;
          response?: { status?: unknown };
          name?: string;
          message?: string;
        };
        const candidate =
          problem?.status ?? problem?.statusCode ?? problem?.response?.status;
        const status =
          typeof candidate === "number" &&
          Number.isInteger(candidate) &&
          candidate >= 100 &&
          candidate <= 599
            ? candidate
            : undefined;
        const known = [
          "drift",
          "status",
          "challenge",
          "timeout",
          "abort",
          "request",
        ];
        const kind =
          problem?.name === "AbortError"
            ? "abort"
            : problem?.name === "TimeoutError"
              ? "timeout"
              : known.includes(problem?.bridgeKind ?? "")
                ? problem.bridgeKind
                : /challenge|turnstile|captcha/i.test(problem?.message ?? "")
                  ? "challenge"
                  : status
                    ? "status"
                    : "request";
        const categories = [
          "request-scope",
          "response-shape",
          "response-body",
          "response-size",
          "response-utf8",
          "registration-shape",
          "integrity-shape",
          "bridge-contract",
        ];
        return {
          ok: false as const,
          kind: kind as
            "drift" | "status" | "challenge" | "timeout" | "abort" | "request",
          status,
          category: categories.includes(problem?.category ?? "")
            ? problem.category
            : "native-request",
        };
      }
    },
    { bridgeKey: BRIDGE_KEY, method, requestId, value },
  );
  return unwrap(result) as T;
}

export function requireChatGptWebUploadUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UpstreamDriftError(
      "ChatGPT Web returned an invalid upload destination",
      { category: "upload-url" },
    );
  }
  if (
    url.protocol !== "https:" ||
    !OAI_UPLOAD_HOST_RE.test(url.hostname) ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.hash
  )
    throw new UpstreamDriftError(
      "ChatGPT Web returned an invalid upload destination",
      { category: "upload-url" },
    );
  return url.toString();
}

async function uploadRegisteredAttachments(
  registered: RegisteredAttachment[],
  signal: AbortSignal,
): Promise<void> {
  for (const item of registered) {
    signal.throwIfAborted();
    const response = await fetch(requireChatGptWebUploadUrl(item.uploadUrl), {
      method: "PUT",
      redirect: "error",
      credentials: "omit",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": item.attachment.mimeType,
        "x-ms-blob-type": "BlockBlob",
        "x-ms-version": "2020-04-08",
      },
      body: new Uint8Array(
        item.attachment.data.buffer,
        item.attachment.data.byteOffset,
        item.attachment.data.byteLength,
      ) as Uint8Array<ArrayBuffer>,
      signal,
    });
    await response.body?.cancel().catch(() => {});
    if (!response.ok)
      unwrap({
        ok: false,
        kind: "status",
        status: response.status,
        category: "upload-status",
      });
  }
}

function conversationBody(
  input: ChatGptWebFirstPartyRequest,
  registered: RegisteredAttachment[],
): JsonRecord {
  const { model, thinkingEffort } = input.selection;
  const images = registered.filter(
    ({ attachment }) => attachment.kind === "image",
  );
  const attachments = registered.map(({ fileId, attachment }) => ({
    id: fileId,
    size: attachment.size,
    name: attachment.name,
    mime_type: attachment.mimeType,
    ...(attachment.kind === "image"
      ? { width: attachment.width, height: attachment.height }
      : { non_library_my_files_injest_upload: true }),
    source: "local",
    is_big_paste: false,
  }));
  return {
    action: "next",
    messages: [
      {
        id: crypto.randomUUID(),
        author: { role: "user" },
        create_time: Date.now() / 1000,
        content: images.length
          ? {
              content_type: "multimodal_text",
              parts: [
                ...images.map(({ fileId, attachment }) => ({
                  content_type: "image_asset_pointer",
                  asset_pointer: `sediment://${fileId}`,
                  size_bytes: attachment.size,
                  width: attachment.width,
                  height: attachment.height,
                })),
                input.prompt,
              ],
            }
          : { content_type: "text", parts: [input.prompt] },
        metadata: {
          ...(attachments.length ? { attachments } : {}),
          serialization_metadata: { custom_symbol_offsets: [] },
        },
      },
    ],
    parent_message_id: "client-created-root",
    model,
    ...(thinkingEffort ? { thinking_effort: thinkingEffort } : {}),
    timezone_offset_min: new Date().getTimezoneOffset(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    history_and_training_disabled: true,
    is_do_not_remember: true,
    temporary_chat_requests_personalization: false,
    conversation_mode: { kind: "primary_assistant" },
    system_hints: [],
    supports_buffering: true,
    supported_encodings: ["v1"],
    client_prepare_state: "none",
  };
}

export async function abortChatGptWebFirstPartyTurn(
  page: Page,
  requestId: string,
): Promise<void> {
  await callBridge(page, "abort", requestId).catch(() => {});
}

async function runSerialized<T>(
  page: Page,
  signal: AbortSignal | null | undefined,
  task: () => Promise<T>,
): Promise<T> {
  const previous = pageRequestTails.get(page) ?? Promise.resolve();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const tail = previous.catch(() => {}).then(() => gate);
  pageRequestTails.set(page, tail);
  try {
    await abortable(
      previous.catch(() => {}),
      signal,
    );
    return await task();
  } finally {
    release();
    void tail.then(() => {
      if (pageRequestTails.get(page) === tail) pageRequestTails.delete(page);
    });
  }
}

export async function getChatGptWebAccountIdentity(
  page: Page,
  signal?: AbortSignal,
): Promise<string> {
  await initializeChatGptWebFirstPartyBridge(page, signal);
  return abortable(callBridge<string>(page, "accountIdentity", ""), signal);
}

export async function fetchChatGptWebModels(
  page: Page,
  signal?: AbortSignal,
  expectedIdentity?: string,
): Promise<unknown> {
  return runSerialized(page, signal, async () => {
    await initializeChatGptWebFirstPartyBridge(page, signal);
    const id = crypto.randomUUID();
    const abort = () => {
      void abortChatGptWebFirstPartyTurn(page, id);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      await abortable(callBridge(page, "begin", id), signal);
      return await abortable(
        callBridge(page, "models", id, expectedIdentity),
        signal,
      );
    } finally {
      signal?.removeEventListener("abort", abort);
      await callBridge(page, "cleanup", id).catch(() => {});
    }
  });
}

export async function executeChatGptWebFirstPartyTurn(
  page: Page,
  input: ChatGptWebFirstPartyRequest,
  options: { signal?: AbortSignal | null } = {},
): Promise<string> {
  return runSerialized(page, options.signal, async () => {
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => {
      controller.abort();
      void abortChatGptWebFirstPartyTurn(page, requestId);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, TURN_TIMEOUT_MS);
    try {
      options.signal?.throwIfAborted();
      await initializeChatGptWebFirstPartyBridge(page, controller.signal);
      await abortable(callBridge(page, "begin", requestId), controller.signal);
      controller.signal.throwIfAborted();
      const metadata = input.attachments.map(
        ({ kind, mimeType, name, size, width, height }) => ({
          kind,
          mimeType,
          name,
          size,
          width,
          height,
        }),
      );
      const registrations = await abortable(
        callBridge<{ fileId: string; uploadUrl: string }[]>(
          page,
          "register",
          requestId,
          metadata,
        ),
        controller.signal,
      );
      if (
        !Array.isArray(registrations) ||
        registrations.length !== input.attachments.length
      )
        throw new UpstreamDriftError(
          "ChatGPT Web file registration count changed",
          { category: "registration-count" },
        );
      const registered = registrations.map((item, index) => ({
        ...item,
        attachment: input.attachments[index],
      }));
      await uploadRegisteredAttachments(registered, controller.signal);
      const browserMetadata = registered.map(
        ({
          fileId,
          attachment: { kind, mimeType, name, size, width, height },
        }) => ({ fileId, kind, mimeType, name, size, width, height }),
      );
      await abortable(
        callBridge(page, "process", requestId, browserMetadata),
        controller.signal,
      );
      return await abortable(
        callBridge<string>(
          page,
          "converse",
          requestId,
          conversationBody(input, registered),
        ),
        controller.signal,
      );
    } catch (error) {
      if (timedOut)
        throw new ProviderTimeoutError("ChatGPT Web native turn timed out", {
          category: "turn-timeout",
        });
      if (options.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
      if (error instanceof WebProviderError) throw error;
      throw new GenericUpstreamError(
        "ChatGPT Web native turn failed",
        502,
        true,
        { category: "turn-evaluation" },
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      await callBridge(page, "cleanup", requestId).catch(() => {});
    }
  });
}
