import { getDefaultModelCatalogCache, ModelCatalogCache } from "../../shared/modelCatalogCache.ts";
import { randomUUID } from "node:crypto";
import {
  BaseWebProviderAdapter,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type CitationSource,
  type WebProviderCapabilities,
} from "../../shared/index.ts";
import {
  AccountScopedContinuationCache,
} from "../../shared/continuationCache.ts";
import {
  CredentialError,
  InvalidRequestError,
  RateLimitError,
  WebProviderError,
} from "../../shared/errors.ts";
import { validateAttachments } from "../../shared/attachmentValidator.ts";
import { GEMINI_WEB_CONSTANTS, GEMINI_REASONING_MAP } from "./constants.ts";
import type { GeminiModelCatalog } from "./models.ts";
import { LiveGeminiWebTransport } from "./transport.ts";
import {
  generateSapisidHash,
  parseGeminiCookie,
} from "./credentials.ts";
import type { ICookieSource } from "./credentials.ts";
import { GeminiRpcDecoder, type GeminiContinuationToken } from "./rpcDecoder.ts";

export interface IGeminiWebTransport {
  discoverModels(cookieHeader: string, signal?: AbortSignal): Promise<GeminiModelCatalog>;
  postStreamGenerate(
    payload: unknown,
    cookieHeader: string,
    sapisidHash: string | undefined,
    modelId: string,
    signal?: AbortSignal
  ): Promise<string>;
}

export class MockGeminiWebTransport implements IGeminiWebTransport {
  private readonly responseHandler?: (payload: unknown) => Promise<string>;
  private readonly catalogHandler?: (cookieHeader?: string) => Promise<GeminiModelCatalog>;
  constructor(responseHandler?: (payload: unknown) => Promise<string>, catalogHandler?: (cookieHeader?: string) => Promise<GeminiModelCatalog>) {
    this.responseHandler = responseHandler;
    this.catalogHandler = catalogHandler;
  }
  async discoverModels(cookieHeader?: string): Promise<GeminiModelCatalog> {
    if (!this.catalogHandler) throw new WebProviderError("Mock Gemini catalog handler missing", "UPSTREAM_DRIFT", 502);
    return this.catalogHandler(cookieHeader);
  }
  async postStreamGenerate(payload: unknown, _cookieHeader: string, _sapisidHash?: string, _modelId?: string, _signal?: AbortSignal): Promise<string> {
    if (this.responseHandler) return this.responseHandler(payload);
    const innerJson = JSON.stringify([
      null,
      "c_mock_conv_id",
      "r_mock_resp_id",
      null,
      [["rc_mock_choice_id", ["Hello from Gemini Web!"]]],
    ]);
    const rpcEnvelope = JSON.stringify([["wrb.fr", null, innerJson]]);
    return `)]}'\n${rpcEnvelope.length}\n${rpcEnvelope}\n`;
  }
}

export interface GeminiAdapterDeps {
  transport?: IGeminiWebTransport;
  cookieSource?: ICookieSource;
  continuationCache?: AccountScopedContinuationCache<GeminiContinuationToken>;
  modelCatalogCache?: ModelCatalogCache;
}

export class GeminiWebAdapter extends BaseWebProviderAdapter {
  readonly id = "gemini-web";
  readonly name = "Gemini Web";
  readonly defaultBaseUrl = GEMINI_WEB_CONSTANTS.BASE_URL;

  private readonly transport: IGeminiWebTransport;
  private readonly defaultCookieSource?: ICookieSource;
  private readonly continuationCache: AccountScopedContinuationCache<GeminiContinuationToken>;
  private readonly modelCatalogCache: ModelCatalogCache;

  constructor(deps: GeminiAdapterDeps = {}) {
    super();
    this.transport = deps.transport ?? new LiveGeminiWebTransport();
    this.defaultCookieSource = deps.cookieSource;
    this.modelCatalogCache = deps.modelCatalogCache ?? getDefaultModelCatalogCache();
    this.continuationCache =
      deps.continuationCache ??
      new AccountScopedContinuationCache<GeminiContinuationToken>({
        ttlMs: 7 * 24 * 60 * 60 * 1000,
      });
  }

  getCapabilities(_model: string): WebProviderCapabilities {
    return {
      supportsStreaming: true,
      supportsReasoning: true,
      supportedThinkingEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      supportsToolCalling: false,
      supportsVision: true,
      supportsFiles: false,
      supportsContinuation: true,
    };
  }

  async validateCredentials(credentials: unknown): Promise<{ valid: boolean; error?: string }> {
    try {
      const cookieStr = typeof credentials === "string" ? credentials : await this.defaultCookieSource?.getCookie();
      if (!cookieStr) throw new CredentialError("No Gemini cookie provided");
      parseGeminiCookie(cookieStr);
      return { valid: true };
    } catch (e) {
      return { valid: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async resolveCookie(credentials: unknown): Promise<string> {
    let cookie = typeof credentials === "string" && credentials.trim() ? credentials.trim() : undefined;
    if (!cookie && this.defaultCookieSource) cookie = await this.defaultCookieSource.getCookie();
    if (!cookie) throw new CredentialError("Missing Gemini Web session cookie");
    return cookie;
  }

  private loadCatalog(cookie: string, signal?: AbortSignal) {
    const creds = parseGeminiCookie(cookie);
    const account = creds.secure1PSID ? `secure1PSID:${creds.secure1PSID}` : `sapisid:${creds.sapisid}`;
    const loader = () => this.transport.discoverModels(creds.rawCookie, signal);
    return this.modelCatalogCache
      ? this.modelCatalogCache.get("gemini-web", account, loader)
      : loader().then(catalog => ({ catalog, status: { fetchedAt: Date.now(), stale: false } }));
  }

  async getCatalog(credentials: unknown, signal?: AbortSignal) {
    return this.loadCatalog(await this.resolveCookie(credentials), signal);
  }

  async refreshCatalog(credentials: unknown, signal?: AbortSignal) {
    const creds = parseGeminiCookie(await this.resolveCookie(credentials));
    const account = creds.secure1PSID ? `secure1PSID:${creds.secure1PSID}` : `sapisid:${creds.sapisid}`;
    const loader = () => this.transport.discoverModels(creds.rawCookie, signal);
    return this.modelCatalogCache
      ? this.modelCatalogCache.refresh("gemini-web", account, loader)
      : this.loadCatalog(creds.rawCookie, signal);
  }

  async discoverModels(credentials: unknown, signal?: AbortSignal): Promise<GeminiModelCatalog> {
    return (await this.getCatalog(credentials, signal)).catalog;
  }

  async execute(
    request: ChatCompletionRequest,
    credentials: unknown,
    signal?: AbortSignal
  ): Promise<ChatCompletionResponse | AsyncIterable<ChatCompletionChunk>> {
    // 1. Resolve cookie: prefer explicit non-empty credentials, fallback to configured cookieSource
    let cookieStr = typeof credentials === "string" && credentials.trim() ? credentials.trim() : undefined;
    if (!cookieStr && this.defaultCookieSource) {
      cookieStr = await this.defaultCookieSource.getCookie();
    }
    if (!cookieStr) {
      throw new CredentialError("Missing Gemini Web session cookie");
    }

    const creds = parseGeminiCookie(cookieStr);
    const sapisidHash = creds.sapisid ? generateSapisidHash(creds.sapisid) : undefined;

    // 2. Validate attachments
    validateAttachments(request.attachments, {
      maxCount: 4,
      allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
    });

    if (!request.messages || request.messages.length === 0) {
      throw new InvalidRequestError("Request messages cannot be empty");
    }

    // Validate the exact upstream ID and account access; no category-based fallback.
    const catalog = (await this.loadCatalog(creds.rawCookie, signal)).catalog;
    const modelMeta = catalog.models.find(model => model.id === request.model);
    if (!modelMeta) throw new InvalidRequestError("Unknown Gemini Web model");
    if (modelMeta.disabled) throw new InvalidRequestError("Gemini Web model unavailable for this account");
    let thinkSetting = 0;
    let extendedThinking = 1; // 1 = normal, 2 = extended thinking
    if (request.reasoning_effort && request.reasoning_effort in GEMINI_REASONING_MAP) {
      thinkSetting = GEMINI_REASONING_MAP[request.reasoning_effort] ?? 0;
      if (request.reasoning_effort === "high" || request.reasoning_effort === "xhigh" || request.reasoning_effort === "max") {
        extendedThinking = 2;
      }
    }

    // 4. Continuation lookup
    // Scope continuation by the full account credential and exact upstream model.
    const accountScope = `${creds.secure1PSID}::${modelMeta.upstreamId}`;
    const hasPriorMessages = request.messages.length > 1;
    const priorMessages = hasPriorMessages ? request.messages.slice(0, -1) : [];
    const transcriptHash = AccountScopedContinuationCache.computeTranscriptHash(priorMessages);

    const cachedToken = hasPriorMessages ? this.continuationCache.get(accountScope, transcriptHash) : null;
    const isStateful = Boolean(cachedToken);

    // 5. Flatten user prompt
    const prompt = request.messages
      .map((m) => {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `${m.role.toUpperCase()}: ${text}`;
      })
      .join("\n\n");

    // Construct internal Gemini Web array payload matching UltraRoute recon
    const innerReq: unknown[] = new Array(102).fill(null);
    innerReq[0] = [prompt, 0, null, null, null, null, 0];
    innerReq[1] = ["en"];
    innerReq[2] = cachedToken
      ? [cachedToken.conversationId, cachedToken.responseId, cachedToken.choiceId, null, null, null, null, null, null, ""]
      : ["", "", "", null, null, null, null, null, null, ""];
    innerReq[6] = [0];
    innerReq[7] = 1;
    innerReq[10] = 1;
    innerReq[11] = 0;
    innerReq[17] = [[thinkSetting]];
    innerReq[18] = 0;
    innerReq[27] = 1;
    innerReq[30] = [4];
    innerReq[41] = [1]; // Temporary chat persistence
    innerReq[45] = 1;
    innerReq[53] = 0;
    innerReq[59] = randomUUID();
    innerReq[61] = [];
    innerReq[68] = 1;
    innerReq[GEMINI_WEB_CONSTANTS.PAYLOAD_SLOT_MODEL_CATEGORY] = 1;
    innerReq[GEMINI_WEB_CONSTANTS.PAYLOAD_SLOT_EXTENDED_THINKING] = extendedThinking;

    // 6. Post request to upstream
    const rawResponse = await this.transport.postStreamGenerate(
      innerReq,
      creds.rawCookie,
      sapisidHash,
      modelMeta.upstreamId,
      signal
    );

    // 7. Decode RPC response
    const decoder = new GeminiRpcDecoder();
    let aggregatedText = "";
    let capturedContinuation: GeminiContinuationToken | undefined;
    let capturedCitations: CitationSource[] | undefined;

    for (const chunk of decoder.feed(rawResponse)) {
      if (chunk.text && chunk.text.length > aggregatedText.length) {
        aggregatedText = chunk.text;
      }
      if (chunk.continuation) capturedContinuation = chunk.continuation;
      if (chunk.citations && chunk.citations.length > 0) {
        capturedCitations = chunk.citations;
      }
    }

    // 8. Commit continuation state if captured
    if (capturedContinuation) {
      const completedTranscript = [
        ...request.messages,
        { role: "assistant" as const, content: aggregatedText },
      ];
      const fullTranscriptHash = AccountScopedContinuationCache.computeTranscriptHash(completedTranscript);
      this.continuationCache.commit(accountScope, fullTranscriptHash, capturedContinuation);
    }

    const completionId = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    // Note preserved distinction from recon: stateful continuation buffers the answer,
    // while stateless can stream. If stream is requested on stateful path, emit single buffered chunk.
    if (request.stream) {
      return (async function* () {
        yield {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: modelMeta.id,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: aggregatedText,
                citations: capturedCitations,
              },
              finish_reason: "stop",
            },
          ],
        };
      })();
    }

    return {
      id: completionId,
      object: "chat.completion",
      created,
      model: modelMeta.id,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: aggregatedText,
            citations: capturedCitations,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: Math.ceil(prompt.length / 4),
        completion_tokens: Math.ceil(aggregatedText.length / 4),
        total_tokens: Math.ceil((prompt.length + aggregatedText.length) / 4),
      },
    };
  }
}
