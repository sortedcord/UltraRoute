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
import { UpstreamDriftError } from "../../shared/errors.ts";

import type { ChatGptWebResolvedAttachment } from "./attachments.ts";

type JsonRecord = Record<string, unknown>;

export interface ChatGptWebFirstPartyModuleContract {
  finalizeRequirements: string;
  proofManager: string;
  turnstileManager: string;
  requestClient: string;
  buildSentinelHeaders: string;
}

export interface ChatGptWebFirstPartyRequest {
  prompt: string;
  attachments: ChatGptWebResolvedAttachment[];
  selection: ChatGptWebUiSelection;
}

export type ChatGptWebUiSelection =
  | {
      kind: "picker";
      modelLabel: "GPT-5.6 Sol" | "GPT-5.5";
      effortIndex: 0 | 1 | 2 | 3 | 4;
    }
  | {
      kind: "free";
      thinkEnabled: boolean;
    };

interface RegisteredAttachment {
  fileId: string;
  uploadUrl: string;
  attachment: ChatGptWebResolvedAttachment;
}

interface BrowserRegisteredAttachment {
  fileId: string;
  uploadUrl: string;
}

interface BrowserConversationAttachment {
  fileId: string;
  kind: ChatGptWebResolvedAttachment["kind"];
  mimeType: string;
  name: string;
  size: number;
  width?: number;
  height?: number;
}

const CHATGPT_ORIGIN = "https://chatgpt.com";
const CHATGPT_ASSET_PATH_RE = /^\/cdn\/assets\/[A-Za-z0-9_-]+\.js$/;
const OAI_UPLOAD_HOST_RE = /(?:^|\.)oaiusercontent\.com$/i;
const FIRST_PARTY_BRIDGE_KEY = "__ultrarouteChatGptFirstPartyV1";
const FIRST_PARTY_ABORT_KEY = "__ultrarouteChatGptAbortV1";
const FIRST_PARTY_REQUEST_KEY = "__ultrarouteChatGptRequestV1";
const MAX_ASSET_SOURCE_BYTES = 24 * 1024 * 1024;
const MAX_CONVERSATION_RESPONSE_BYTES = 16 * 1024 * 1024;
const ASSET_FETCH_TIMEOUT_MS = 20_000;
const MAX_DISCOVERY_ASSETS = 512;
const MODULE_DISCOVERY_TIMEOUT_MS = 15_000;
const MODULE_DISCOVERY_POLL_MS = 250;

const contractCache = new Map<
  string,
  Promise<ChatGptWebFirstPartyModuleContract>
>();
const pageRequestTails = new WeakMap<Page, Promise<void>>();
let lastKnownModuleAssetUrl: string | null = null;

function exportedName(source: string, localName: string): string | null {
  for (const block of source.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const entry of block[1].split(",")) {
      const match =
        /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(entry);
      if (match?.[1] === localName) return match[2] ?? match[1];
    }
  }
  return null;
}

/**
 * Discover the public exports used by ChatGPT's own request path from semantic markers.
 * Minified local/export names are deliberately not pinned and may change on every deployment.
 */
export function parseChatGptWebFirstPartyModuleContract(
  source: string,
): ChatGptWebFirstPartyModuleContract {
  const finalizeLocal = source.match(
    /function ([A-Za-z_$][\w$]*)\(e=!1,t=`none`(?:,n=[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)?\)\{return [A-Za-z_$][\w$]*\(`finalized`,e,t(?:,n)?\)\}/,
  )?.[1];
  const enforcement = source.match(
    /Promise\.all\(\[([A-Za-z_$][\w$]*)\.getEnforcementToken\(t,\{forceSync:!0\}\),([A-Za-z_$][\w$]*)\.getEnforcementToken\(t\)\]\)/,
  );
  const requestClientLocal = source.match(
    /([A-Za-z_$][\w$]*)\.safePost\(`\/sentinel\/chat-requirements\/prepare`/,
  )?.[1];
  const headerBuilderLocal = source.match(
    /function ([A-Za-z_$][\w$]*)\(e,t,n,r,i,a\)\{let o=\{\};return e\?\.token\?o\[`OpenAI-Sentinel-Chat-Requirements-Token`\]/,
  )?.[1];
  const proofLocal = enforcement?.[1];
  const turnstileLocal = enforcement?.[2];
  if (
    !finalizeLocal ||
    !proofLocal ||
    !turnstileLocal ||
    !requestClientLocal ||
    !headerBuilderLocal
  ) {
    throw new UpstreamDriftError(
      "ChatGPT Web first-party module contract was not found",
      { category: "module-contract" },
    );
  }

  const contract = {
    finalizeRequirements: exportedName(source, finalizeLocal),
    proofManager: exportedName(source, proofLocal),
    turnstileManager: exportedName(source, turnstileLocal),
    requestClient: exportedName(source, requestClientLocal),
    buildSentinelHeaders: exportedName(source, headerBuilderLocal),
  };
  if (Object.values(contract).some((value) => value === null)) {
    throw new UpstreamDriftError(
      "ChatGPT Web first-party module contract exports were not found",
      { category: "module-exports" },
    );
  }
  return contract as ChatGptWebFirstPartyModuleContract;
}

function requireChatGptAssetUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UpstreamDriftError(
      "ChatGPT Web exposed an invalid first-party asset URL",
      { category: "asset-url" },
    );
  }
  if (
    url.origin !== CHATGPT_ORIGIN ||
    !CHATGPT_ASSET_PATH_RE.test(url.pathname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new UpstreamDriftError(
      "ChatGPT Web exposed an invalid first-party asset URL",
      { category: "asset-url" },
    );
  }
  return url.toString();
}

export function collectChatGptWebFirstPartyAssetCandidates(
  resourceUrls: readonly string[],
  modulePreloadUrls: readonly string[],
): string[] {
  return Array.from(new Set([...resourceUrls, ...modulePreloadUrls])).filter(
    (url) => {
      try {
        requireChatGptAssetUrl(url);
        return true;
      } catch {
        return false;
      }
    },
  );
}

/** Find first-party chunks referenced by an already-loaded ChatGPT module. */
export function extractChatGptWebFirstPartyAssetReferences(
  source: string,
  parentAssetUrl: string,
): string[] {
  const references: string[] = [];
  const seen = new Set<string>();
  const pattern = /["']\.\/([A-Za-z0-9_-]+\.js)["']/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    let assetUrl: string;
    try {
      assetUrl = requireChatGptAssetUrl(
        new URL(`./${match[1]}`, parentAssetUrl).toString(),
      );
    } catch {
      continue;
    }
    if (!seen.has(assetUrl)) {
      seen.add(assetUrl);
      references.push(assetUrl);
    }
  }
  return references;
}

export async function readChatGptWebFirstPartyAssetSource(
  url: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = ASSET_FETCH_TIMEOUT_MS,
): Promise<string> {
  const controller = new AbortController();
  const { promise: timedOut, reject: rejectTimeout } =
    Promise.withResolvers<never>();
  const timeout = setTimeout(() => {
    controller.abort();
    rejectTimeout(new Error("Timeout"));
  }, timeoutMs);
  try {
    const response = await Promise.race([
      fetcher(requireChatGptAssetUrl(url), {
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
      }),
      timedOut,
    ]);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new UpstreamDriftError(
        "ChatGPT Web first-party asset could not be loaded",
        { category: "asset-status", status: response.status },
      );
    }
    if (
      Number(response.headers.get("content-length") ?? 0) >
      MAX_ASSET_SOURCE_BYTES
    ) {
      await response.body?.cancel().catch(() => {});
      throw new UpstreamDriftError(
        "ChatGPT Web first-party asset exceeded the size limit",
        { category: "asset-size" },
      );
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new UpstreamDriftError("ChatGPT Web first-party asset was empty", {
        category: "asset-body",
      });
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), timedOut]);
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ASSET_SOURCE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new UpstreamDriftError(
            "ChatGPT Web first-party asset exceeded the size limit",
            { category: "asset-size" },
          );
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
      return chunks.join("");
    } finally {
      if (controller.signal.aborted) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof UpstreamDriftError) throw error;
    throw new UpstreamDriftError(
      "ChatGPT Web first-party asset could not be loaded",
      {
        category: controller.signal.aborted ? "asset-timeout" : "asset-request",
      },
    );
  } finally {
    clearTimeout(timeout);
  }
}

interface FirstPartyModuleResult {
  assetUrl: string;
  contract: ChatGptWebFirstPartyModuleContract;
}

interface FirstPartyDiscoveryState {
  queue: string[];
  visited: Set<string>;
  index: number;
  deadline: number;
}

function clearDiscoveryHint(assetUrl?: string): void {
  if (assetUrl) contractCache.delete(assetUrl);
  if (!assetUrl || lastKnownModuleAssetUrl === assetUrl)
    lastKnownModuleAssetUrl = null;
}

async function collectPageAssetCandidates(page: Page): Promise<string[]> {
  const sources = await page.evaluate(() => ({
    modulePreloadUrls: Array.from(
      document.querySelectorAll<HTMLLinkElement>(
        'link[rel="modulepreload"][href]',
      ),
      (link) => link.href,
    ),
    resourceUrls: performance
      .getEntriesByType("resource")
      .map((entry) => entry.name),
  }));
  return collectChatGptWebFirstPartyAssetCandidates(
    sources.resourceUrls,
    sources.modulePreloadUrls,
  );
}

async function inspectFirstPartyAsset(
  candidate: string,
  state: FirstPartyDiscoveryState,
): Promise<FirstPartyModuleResult | null> {
  let assetUrl: string;
  try {
    assetUrl = requireChatGptAssetUrl(candidate);
  } catch {
    return null;
  }
  if (state.visited.has(assetUrl)) return null;
  state.visited.add(assetUrl);

  const cached = contractCache.get(assetUrl);
  if (cached) {
    try {
      return { assetUrl, contract: await cached };
    } catch {
      contractCache.delete(assetUrl);
    }
  }

  let source: string;
  try {
    source = await readChatGptWebFirstPartyAssetSource(
      assetUrl,
      fetch,
      Math.max(1, state.deadline - Date.now()),
    );
  } catch {
    clearDiscoveryHint(assetUrl);
    return null;
  }
  try {
    const contract = parseChatGptWebFirstPartyModuleContract(source);
    contractCache.set(assetUrl, Promise.resolve(contract));
    lastKnownModuleAssetUrl = assetUrl;
    return { assetUrl, contract };
  } catch {
    clearDiscoveryHint(assetUrl);
    const references = extractChatGptWebFirstPartyAssetReferences(
      source,
      assetUrl,
    );
    state.queue.push(
      ...references.filter((reference) => !state.visited.has(reference)),
    );
    return null;
  }
}

async function scanQueuedFirstPartyAssets(
  state: FirstPartyDiscoveryState,
): Promise<FirstPartyModuleResult | null> {
  while (
    state.index < state.queue.length &&
    state.visited.size < MAX_DISCOVERY_ASSETS &&
    Date.now() < state.deadline
  ) {
    const candidate = state.queue[state.index];
    state.index += 1;
    const result = await inspectFirstPartyAsset(candidate, state);
    if (result) return result;
  }
  return null;
}

async function discoverFirstPartyModule(
  page: Page,
): Promise<FirstPartyModuleResult> {
  const state: FirstPartyDiscoveryState = {
    queue: [...(lastKnownModuleAssetUrl ? [lastKnownModuleAssetUrl] : [])],
    visited: new Set<string>(),
    index: 0,
    deadline: Date.now() + MODULE_DISCOVERY_TIMEOUT_MS,
  };
  while (
    Date.now() < state.deadline &&
    state.visited.size < MAX_DISCOVERY_ASSETS
  ) {
    state.queue.push(...(await collectPageAssetCandidates(page)));
    const result = await scanQueuedFirstPartyAssets(state);
    if (result) return result;
    if (Date.now() < state.deadline) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(
        resolve,
        Math.min(MODULE_DISCOVERY_POLL_MS, state.deadline - Date.now()),
      );
      await promise;
    }
  }
  clearDiscoveryHint();
  throw new UpstreamDriftError(
    "ChatGPT Web first-party request module was not loaded",
    { category: "module-discovery" },
  );
}

function buildBridgeModuleSource(
  assetUrl: string,
  contract: ChatGptWebFirstPartyModuleContract,
): string {
  const urlLiteral = JSON.stringify(requireChatGptAssetUrl(assetUrl));
  const contractLiteral = JSON.stringify(contract);
  const keyLiteral = JSON.stringify(FIRST_PARTY_BRIDGE_KEY);
  return [
    `import * as upstream from ${urlLiteral};`,
    `const names = ${contractLiteral};`,
    `window[${keyLiteral}] = {`,
    `finalizeRequirements: upstream[names.finalizeRequirements],`,
    `proofManager: upstream[names.proofManager],`,
    `turnstileManager: upstream[names.turnstileManager],`,
    `requestClient: upstream[names.requestClient],`,
    `buildSentinelHeaders: upstream[names.buildSentinelHeaders]`,
    `};`,
  ].join("");
}

/** Fixed diagnostics only; page messages, URLs and CSP blockedURI never cross the boundary. */
export interface ChatGptWebBridgeFailureSignal {
  kind: "csp" | "requestfailed" | "asset-status" | "evaluation" | "timeout";
  detail?: string;
  status?: number;
}
const CSP_DIRECTIVES: Record<string, true> = {
  "script-src": true,
  "script-src-elem": true,
  "script-src-attr": true,
  "default-src": true,
  "worker-src": true,
  "connect-src": true,
};
export function collectBridgeFailureSignals(
  page: Pick<Page, "on" | "off">,
  assetUrl: string,
): { signals: ChatGptWebBridgeFailureSignal[]; dispose: () => void } {
  const signals: ChatGptWebBridgeFailureSignal[] = [];
  const onRequestFailed = (request: { url: () => string }) => {
    if (request.url() === assetUrl || request.url().startsWith("blob:"))
      signals.push({ kind: "requestfailed" });
  };
  const onPageError = () => {
    signals.push({ kind: "evaluation" });
  };
  const onResponse = (response: {
    url: () => string;
    status: () => number;
  }) => {
    if (response.url() === assetUrl && response.status() >= 400)
      signals.push({ kind: "asset-status", status: response.status() });
  };
  page.on("requestfailed", onRequestFailed as never);
  page.on("pageerror", onPageError as never);
  page.on("response", onResponse as never);
  return {
    signals,
    dispose: () => {
      page.off("requestfailed", onRequestFailed as never);
      page.off("pageerror", onPageError as never);
      page.off("response", onResponse as never);
    },
  };
}
export function describeBridgeLoadFailure(
  signals: ChatGptWebBridgeFailureSignal[],
): string {
  const base = "ChatGPT Web first-party bridge module failed to load";
  const csp = signals.find((signal) => signal.kind === "csp");
  if (csp)
    return `${base} (CSP: ${csp.detail && Object.hasOwn(CSP_DIRECTIVES, csp.detail) ? csp.detail : "script policy"})`;
  const status = signals.find((signal) => signal.kind === "asset-status");
  if (status)
    return `${base} (asset status: ${Number.isInteger(status.status) && status.status! >= 100 && status.status! <= 599 ? status.status : "failed"})`;
  if (signals.some((signal) => signal.kind === "requestfailed"))
    return `${base} (request failed)`;
  if (signals.some((signal) => signal.kind === "timeout"))
    return `${base} (module load timeout)`;
  return `${base} (evaluation)`;
}
export function chatGptWebBridgeFailureDetails(
  signals: ChatGptWebBridgeFailureSignal[],
): Record<string, unknown> {
  const details: Record<string, unknown> = { category: "bridge-load" };
  const csp = signals.find((signal) => signal.kind === "csp");
  const asset = signals.find((signal) => signal.kind === "asset-status");
  if (csp) {
    details.reason = "csp";
    if (csp.detail && Object.hasOwn(CSP_DIRECTIVES, csp.detail))
      details.directive = csp.detail;
  } else if (asset) {
    details.reason = "asset-status";
    if (
      Number.isInteger(asset.status) &&
      asset.status! >= 100 &&
      asset.status! <= 599
    )
      details.status = asset.status;
  } else if (signals.some((signal) => signal.kind === "requestfailed"))
    details.reason = "requestfailed";
  else if (signals.some((signal) => signal.kind === "timeout"))
    details.reason = "timeout";
  else details.reason = "evaluation";
  return details;
}
async function ensureFirstPartyBridge(page: Page): Promise<void> {
  const ready = await page.evaluate((key) => {
    const root = globalThis as typeof globalThis & Record<string, unknown>;
    return typeof root[key] === "object" && root[key] !== null;
  }, FIRST_PARTY_BRIDGE_KEY);
  if (ready) return;
  const { assetUrl, contract } = await discoverFirstPartyModule(page);
  const moduleSource = buildBridgeModuleSource(assetUrl, contract);
  const collected = collectBridgeFailureSignals(page, assetUrl);
  try {
    const result = await page.evaluate(
      ({ bridgeKey, moduleSource: source, assetUrl, timeoutMs }) => {
        const { promise, resolve } = Promise.withResolvers<{
          ok: boolean;
          csp: string;
          timeout: boolean;
        }>();
        const root = globalThis as typeof globalThis & Record<string, unknown>;
        let csp = "";
        let timer: number;
        let settled = false;
        const blobUrl = URL.createObjectURL(
          new Blob([source], { type: "text/javascript" }),
        );
        const script = document.createElement("script");
        const onViolation = (event: SecurityPolicyViolationEvent) => {
          if (
            event.blockedURI !== blobUrl &&
            event.blockedURI !== "blob" &&
            event.blockedURI !== assetUrl
          )
            return;
          const directive = event.effectiveDirective;
          csp = [
            "script-src",
            "script-src-elem",
            "script-src-attr",
            "default-src",
            "worker-src",
            "connect-src",
          ].includes(directive)
            ? directive
            : "script policy";
        };
        const done = (ok: boolean, timeout = false) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          script.onload = null;
          script.onerror = null;
          script.remove();
          URL.revokeObjectURL(blobUrl);
          document.removeEventListener("securitypolicyviolation", onViolation);
          if (!ok) delete root[bridgeKey];
          resolve({ ok, csp, timeout });
        };
        script.type = "module";
        script.src = blobUrl;
        script.onload = () =>
          done(typeof root[bridgeKey] === "object" && root[bridgeKey] !== null);
        script.onerror = () => {
          setTimeout(() => done(false), 0);
        };
        timer = window.setTimeout(() => done(false, true), timeoutMs);
        document.addEventListener("securitypolicyviolation", onViolation);
        try {
          document.head.appendChild(script);
        } catch {
          done(false);
        }
        return promise;
      },
      {
        bridgeKey: FIRST_PARTY_BRIDGE_KEY,
        moduleSource,
        assetUrl,
        timeoutMs: MODULE_DISCOVERY_TIMEOUT_MS,
      },
    );
    if (!result.ok) {
      if (result.csp)
        collected.signals.push({ kind: "csp", detail: result.csp });
      if (result.timeout) collected.signals.push({ kind: "timeout" });
      throw new UpstreamDriftError(
        describeBridgeLoadFailure(collected.signals),
        chatGptWebBridgeFailureDetails(collected.signals),
      );
    }
  } catch (error) {
    clearDiscoveryHint(assetUrl);
    if (error instanceof UpstreamDriftError) throw error;
    throw new UpstreamDriftError(
      describeBridgeLoadFailure(collected.signals),
      chatGptWebBridgeFailureDetails(collected.signals),
    );
  } finally {
    collected.dispose();
  }
}

function directModel(selection: ChatGptWebUiSelection): {
  model: string;
  reason: boolean;
} {
  if (selection.kind === "free")
    return { model: "auto", reason: selection.thinkEnabled };
  const base = selection.modelLabel === "GPT-5.6 Sol" ? "gpt-5-6" : "gpt-5-5";
  if (selection.effortIndex === 4)
    return { model: `${base}-pro`, reason: false };
  return { model: base, reason: selection.effortIndex > 0 };
}

async function registerAttachments(
  page: Page,
  requestId: string,
  attachments: ChatGptWebResolvedAttachment[],
): Promise<BrowserRegisteredAttachment[]> {
  return page.evaluate(
    async ({ abortKey, attachments: metadata, bridgeKey, requestId }) => {
      const root = globalThis as typeof globalThis & Record<string, unknown>;
      const bridge = root[bridgeKey] as {
        requestClient?: {
          safePost(path: string, options: JsonRecord): Promise<unknown>;
        };
      };
      if (typeof bridge?.requestClient?.safePost !== "function") {
        throw new Error(
          "ChatGPT Web first-party request client is unavailable",
        );
      }
      const abortStore = (root[abortKey] ??= {}) as Record<
        string,
        AbortController
      >;
      const controller = new AbortController();
      abortStore[requestId] = controller;
      const registered: BrowserRegisteredAttachment[] = [];
      for (const attachment of metadata) {
        const useCase = attachment.kind === "image" ? "multimodal" : "my_files";
        const response = await bridge.requestClient.safePost("/files", {
          requestBody: {
            file_name: attachment.name,
            file_size: attachment.size,
            use_case: useCase,
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
        });
        let payload: unknown = response;
        if (response instanceof Response) {
          if (!response.ok) {
            const status = response.status;
            await response.body?.cancel().catch(() => {});
            throw new Error(
              `ChatGPT Web file registration failed with status ${status}`,
            );
          }
          payload = await response.json();
        }
        if (
          !payload ||
          typeof payload !== "object" ||
          typeof (payload as JsonRecord).file_id !== "string" ||
          typeof (payload as JsonRecord).upload_url !== "string"
        ) {
          throw new Error(
            "ChatGPT Web file registration returned an invalid response",
          );
        }
        registered.push({
          fileId: (payload as JsonRecord).file_id as string,
          uploadUrl: (payload as JsonRecord).upload_url as string,
        });
      }
      return registered;
    },
    {
      abortKey: FIRST_PARTY_ABORT_KEY,
      attachments: attachments.map(({ kind, mimeType, name, size }) => ({
        kind,
        mimeType,
        name,
        size,
      })),
      bridgeKey: FIRST_PARTY_BRIDGE_KEY,
      requestId,
    },
  );
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
  ) {
    throw new UpstreamDriftError(
      "ChatGPT Web returned an invalid upload destination",
      { category: "upload-url" },
    );
  }
  return url.toString();
}

async function uploadRegisteredAttachments(
  registered: RegisteredAttachment[],
  signal?: AbortSignal | null,
): Promise<void> {
  for (const item of registered) {
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
      body: new Uint8Array(item.attachment.data).buffer,
      signal: signal ?? undefined,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new UpstreamDriftError(
        `ChatGPT Web attachment upload failed with status ${response.status}`,
        { category: "upload-status", status: response.status },
      );
    }
    await response.body?.cancel().catch(() => {});
  }
}

function browserConversationAttachments(
  registered: RegisteredAttachment[],
): BrowserConversationAttachment[] {
  return registered.map(({ attachment, fileId }) => ({
    fileId,
    kind: attachment.kind,
    mimeType: attachment.mimeType,
    name: attachment.name,
    size: attachment.size,
    width: attachment.width,
    height: attachment.height,
  }));
}

async function processRegisteredAttachments(
  page: Page,
  requestId: string,
  registered: BrowserConversationAttachment[],
): Promise<void> {
  await page.evaluate(
    async ({ abortKey, bridgeKey, registered, requestId }) => {
      const root = globalThis as typeof globalThis & Record<string, unknown>;
      const bridge = root[bridgeKey] as {
        requestClient?: {
          safePost(path: string, options: JsonRecord): Promise<unknown>;
        };
      };
      if (typeof bridge?.requestClient?.safePost !== "function") {
        throw new Error(
          "ChatGPT Web first-party request client is unavailable",
        );
      }
      const abortStore = root[abortKey] as
        Record<string, AbortController> | undefined;
      const controller = abortStore?.[requestId];
      if (!controller)
        throw new Error(
          "ChatGPT Web request cancellation scope is unavailable",
        );

      for (const item of registered) {
        const useCase = item.kind === "image" ? "multimodal" : "my_files";
        const processResponse = await bridge.requestClient.safePost(
          "/files/process_upload_stream",
          {
            requestBody: {
              file_id: item.fileId,
              use_case: useCase,
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
            skipJsonTransform: true,
          },
        );
        if (processResponse instanceof Response) {
          const status = processResponse.status;
          const ok = processResponse.ok;
          await processResponse.text();
          if (!ok) {
            throw new Error(
              `ChatGPT Web file processing failed with status ${status}`,
            );
          }
        }
      }
    },
    {
      abortKey: FIRST_PARTY_ABORT_KEY,
      bridgeKey: FIRST_PARTY_BRIDGE_KEY,
      registered,
      requestId,
    },
  );
}

async function storeConversationDraft(
  page: Page,
  input: ChatGptWebFirstPartyRequest,
  requestId: string,
  registered: BrowserConversationAttachment[],
): Promise<void> {
  const mode = directModel(input.selection);
  await page.evaluate(
    ({ mode, prompt, registered, requestId, requestKey }) => {
      const root = globalThis as typeof globalThis & Record<string, unknown>;
      const images = registered.filter((item) => item.kind === "image");
      const attachments = registered.map((item) => ({
        id: item.fileId,
        size: item.size,
        name: item.name,
        mime_type: item.mimeType,
        ...(item.kind === "image"
          ? { width: item.width, height: item.height }
          : { non_library_my_files_injest_upload: true }),
        source: "local",
        is_big_paste: false,
      }));
      const metadata: JsonRecord = {
        ...(mode.reason ? { system_hints: ["reason"] } : {}),
        ...(attachments.length ? { attachments } : {}),
        serialization_metadata: { custom_symbol_offsets: [] },
      };
      const content = images.length
        ? {
            content_type: "multimodal_text",
            parts: [
              ...images.map((item) => ({
                content_type: "image_asset_pointer",
                asset_pointer: `sediment://${item.fileId}`,
                size_bytes: item.size,
                width: item.width,
                height: item.height,
              })),
              prompt,
            ],
          }
        : { content_type: "text", parts: [prompt] };
      const requestStore = (root[requestKey] ??= {}) as Record<
        string,
        JsonRecord
      >;
      requestStore[requestId] = {
        body: {
          action: "next",
          messages: [
            {
              id: crypto.randomUUID(),
              author: { role: "user" },
              create_time: Date.now() / 1000,
              content,
              metadata,
            },
          ],
          parent_message_id: "client-created-root",
          model: mode.model,
          timezone_offset_min: new Date().getTimezoneOffset(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          history_and_training_disabled: true,
          conversation_mode: { kind: "primary_assistant" },
          system_hints: mode.reason ? ["reason"] : [],
          supports_buffering: true,
          supported_encodings: ["v1"],
        },
      };
    },
    {
      mode,
      prompt: input.prompt,
      registered,
      requestId,
      requestKey: FIRST_PARTY_REQUEST_KEY,
    },
  );
}

async function storeConversationHeaders(
  page: Page,
  requestId: string,
): Promise<void> {
  await page.evaluate(
    async ({ abortKey, bridgeKey, requestId, requestKey }) => {
      const root = globalThis as typeof globalThis & Record<string, unknown>;
      const bridge = root[bridgeKey] as {
        finalizeRequirements?: (
          cache?: boolean,
          source?: string,
        ) => Promise<JsonRecord>;
        proofManager?: {
          getEnforcementToken(
            value: JsonRecord,
            options: JsonRecord,
          ): Promise<string>;
        };
        turnstileManager?: {
          getEnforcementToken(value: JsonRecord): Promise<string>;
        };
        buildSentinelHeaders?: (
          requirements: JsonRecord,
          turnstile: string,
          proof: string,
          sentinel: null,
          observer: null,
          telemetry: null,
        ) => Record<string, string>;
      };
      const bridgeReady = [
        bridge?.finalizeRequirements,
        bridge?.proofManager?.getEnforcementToken,
        bridge?.turnstileManager?.getEnforcementToken,
        bridge?.buildSentinelHeaders,
      ].every((member) => typeof member === "function");
      if (!bridgeReady) {
        throw new Error(
          "ChatGPT Web first-party challenge bridge is incomplete",
        );
      }
      const controller = (root[abortKey] as Record<string, AbortController>)?.[
        requestId
      ];
      const draft = (root[requestKey] as Record<string, JsonRecord>)?.[
        requestId
      ];
      if (!controller || !draft)
        throw new Error("ChatGPT Web request scope is unavailable");

      const requirements = await bridge.finalizeRequirements!(false, "none");
      if (controller.signal.aborted)
        throw new DOMException("Aborted", "AbortError");
      const [proof, turnstile] = await Promise.all([
        bridge.proofManager!.getEnforcementToken(requirements, {
          forceSync: true,
        }),
        bridge.turnstileManager!.getEnforcementToken(requirements),
      ]);
      const additionalHeaders = bridge.buildSentinelHeaders!(
        requirements,
        turnstile,
        proof,
        null,
        null,
        null,
      );
      draft.additionalHeaders = additionalHeaders;
    },
    {
      abortKey: FIRST_PARTY_ABORT_KEY,
      bridgeKey: FIRST_PARTY_BRIDGE_KEY,
      requestId,
      requestKey: FIRST_PARTY_REQUEST_KEY,
    },
  );
}

async function submitConversationRequest(
  page: Page,
  requestId: string,
): Promise<void> {
  await page.evaluate(
    async ({ abortKey, bridgeKey, requestId, requestKey }) => {
      const root = globalThis as typeof globalThis & Record<string, unknown>;
      const requestClient = (
        root[bridgeKey] as {
          requestClient?: {
            safePost(path: string, options: JsonRecord): Promise<unknown>;
          };
        }
      )?.requestClient;
      const controller = (root[abortKey] as Record<string, AbortController>)?.[
        requestId
      ];
      const draft = (root[requestKey] as Record<string, JsonRecord>)?.[
        requestId
      ];
      if (
        typeof requestClient?.safePost !== "function" ||
        !controller ||
        !draft
      ) {
        throw new Error(
          "ChatGPT Web conversation request scope is unavailable",
        );
      }
      const response = await requestClient.safePost("/f/conversation", {
        requestBody: draft.body,
        additionalHeaders: draft.additionalHeaders,
        signal: controller.signal,
        skipJsonTransform: true,
      });
      if (!(response instanceof Response)) {
        throw new Error(
          "ChatGPT Web conversation returned an invalid response",
        );
      }
      if (!response.ok) {
        const status = response.status;
        await response.body?.cancel().catch(() => {});
        throw new Error(
          `ChatGPT Web conversation failed with status ${status}`,
        );
      }
      draft.response = response;
    },
    {
      abortKey: FIRST_PARTY_ABORT_KEY,
      bridgeKey: FIRST_PARTY_BRIDGE_KEY,
      requestId,
      requestKey: FIRST_PARTY_REQUEST_KEY,
    },
  );
}

async function readConversationResponse(
  page: Page,
  requestId: string,
): Promise<string> {
  return page.evaluate(
    async ({ requestId, requestKey, responseLimit }) => {
      const root = globalThis as typeof globalThis & Record<string, unknown>;
      const draft = (root[requestKey] as Record<string, JsonRecord>)?.[
        requestId
      ];
      const response = draft?.response;
      if (!(response instanceof Response)) {
        throw new Error("ChatGPT Web conversation response is unavailable");
      }
      const reader = response.body?.getReader();
      if (!reader)
        throw new Error("ChatGPT Web conversation returned an empty stream");
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > responseLimit) {
            await reader.cancel().catch(() => {});
            throw new Error(
              "ChatGPT Web conversation response exceeded the size limit",
            );
          }
          chunks.push(decoder.decode(value, { stream: true }));
        }
        chunks.push(decoder.decode());
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // The stream can already be released after cancellation.
        }
      }
      return chunks.join("");
    },
    {
      requestId,
      requestKey: FIRST_PARTY_REQUEST_KEY,
      responseLimit: MAX_CONVERSATION_RESPONSE_BYTES,
    },
  );
}

async function processAndSubmit(
  page: Page,
  input: ChatGptWebFirstPartyRequest,
  requestId: string,
  registered: RegisteredAttachment[],
): Promise<string> {
  const browserRegistered = browserConversationAttachments(registered);
  await processRegisteredAttachments(page, requestId, browserRegistered);
  await storeConversationDraft(page, input, requestId, browserRegistered);
  await storeConversationHeaders(page, requestId);
  await submitConversationRequest(page, requestId);
  return readConversationResponse(page, requestId);
}

async function cleanupRequest(page: Page, requestId: string): Promise<void> {
  await page
    .evaluate(
      ({ abortKey, requestId, requestKey }) => {
        const root = globalThis as typeof globalThis & Record<string, unknown>;
        const abortStore = root[abortKey] as
          Record<string, AbortController> | undefined;
        const requestStore = root[requestKey] as
          Record<string, JsonRecord> | undefined;
        delete abortStore?.[requestId];
        delete requestStore?.[requestId];
      },
      {
        abortKey: FIRST_PARTY_ABORT_KEY,
        requestId,
        requestKey: FIRST_PARTY_REQUEST_KEY,
      },
    )
    .catch(() => {});
}

export async function abortChatGptWebFirstPartyTurn(
  page: Page,
  requestId: string,
): Promise<void> {
  await page
    .evaluate(
      ({ abortKey, requestId }) => {
        const root = globalThis as typeof globalThis & Record<string, unknown>;
        const store = root[abortKey] as
          Record<string, AbortController> | undefined;
        store?.[requestId]?.abort();
      },
      { abortKey: FIRST_PARTY_ABORT_KEY, requestId },
    )
    .catch(() => {});
}

async function runSerialized<T>(
  page: Page,
  task: () => Promise<T>,
): Promise<T> {
  const previous = pageRequestTails.get(page) ?? Promise.resolve();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const tail = previous.catch(() => {}).then(() => gate);
  pageRequestTails.set(page, tail);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (pageRequestTails.get(page) === tail) pageRequestTails.delete(page);
  }
}

export async function executeChatGptWebFirstPartyTurn(
  page: Page,
  input: ChatGptWebFirstPartyRequest,
  options: { signal?: AbortSignal | null } = {},
): Promise<string> {
  const requestId = crypto.randomUUID();
  return runSerialized(page, async () => {
    if (options.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
    const abort = (): void => {
      void abortChatGptWebFirstPartyTurn(page, requestId);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      await ensureFirstPartyBridge(page);
      const registrations = await registerAttachments(
        page,
        requestId,
        input.attachments,
      );
      if (options.signal?.aborted) {
        await abortChatGptWebFirstPartyTurn(page, requestId);
        throw new DOMException("Aborted", "AbortError");
      }
      const registered = registrations.map((registration, index) => ({
        ...registration,
        attachment: input.attachments[index],
      }));
      await uploadRegisteredAttachments(registered, options.signal);
      return await processAndSubmit(page, input, requestId, registered);
    } catch (error) {
      if (options.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
      if (error instanceof UpstreamDriftError) throw error;
      throw new UpstreamDriftError("ChatGPT Web first-party turn failed", {
        category: "turn-evaluation",
      });
    } finally {
      options.signal?.removeEventListener("abort", abort);
      await cleanupRequest(page, requestId);
    }
  });
}
