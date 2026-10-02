import { randomUUID } from "node:crypto";
import {
  BaseWebProviderAdapter,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type WebProviderCapabilities,
} from "../../shared/index.ts";
import { AccountScopedContinuationCache } from "../../shared/continuationCache.ts";
import { CredentialError, InvalidRequestError, WebProviderError } from "../../shared/errors.ts";
import { SseStreamDecoder } from "../../shared/sseDecoder.ts";
import { CLAUDE_WEB_CONSTANTS } from "./constants.ts";
import { parseClaudeModelCatalog, type ClaudeModelCatalog } from "./models.ts";
import { LiveClaudeWebTransport } from "./transport.ts";
import {
  normalizeClaudeSessionCookie,
  buildClaudeCookieHeader,
} from "./credentials.ts";
import {
  transformToClaudePayload,
  type ClaudeWebWirePayload,
} from "./payload.ts";
import { ClaudeSseDecoder } from "./stream.ts";
import { catalogAccountKey, getDefaultModelCatalogCache, ModelCatalogCache } from "../../shared/modelCatalogCache.ts";

export interface ClaudeContinuationState {
  conversationUuid: string;
  lastMessageUuid: string;
}

export interface IClaudeWebTransport {
  fetchOrganizations(
    cookieHeader: string,
    signal?: AbortSignal,
  ): Promise<Array<{ id: string; name: string }>>;
  fetchBootstrap(
    orgId: string,
    cookieHeader: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  sendTurn(
    orgId: string,
    conversationUuid: string,
    payload: ClaudeWebWirePayload,
    cookieHeader: string,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array> | string>;
}

export class MockClaudeWebTransport implements IClaudeWebTransport {
  private readonly orgsHandler?: () => Promise<
    Array<{ id: string; name: string }>
  >;
  private readonly turnHandler?: (
    payload: ClaudeWebWirePayload,
  ) => Promise<string>;
  private readonly bootstrapHandler?: () => Promise<unknown>;

  constructor(
    orgsHandler?: () => Promise<Array<{ id: string; name: string }>>,
    turnHandler?: (payload: ClaudeWebWirePayload) => Promise<string>,
    bootstrapHandler?: () => Promise<unknown>,
  ) {
    this.orgsHandler = orgsHandler;
    this.turnHandler = turnHandler;
    this.bootstrapHandler = bootstrapHandler;
  }
  async fetchOrganizations(
    _cookieHeader: string,
    _signal?: AbortSignal,
  ): Promise<Array<{ id: string; name: string }>> {
    if (this.orgsHandler) return this.orgsHandler();
    return [{ id: "mock-org-uuid", name: "Default Org" }];
  }

  async fetchBootstrap(): Promise<unknown> {
    if (!this.bootstrapHandler)
      throw new WebProviderError(
        "Mock Claude bootstrap handler missing",
        "UPSTREAM_DRIFT",
        502,
      );
    return this.bootstrapHandler();
  }

  async sendTurn(
    _orgId: string,
    _conversationUuid: string,
    payload: ClaudeWebWirePayload,
    _cookieHeader: string,
    _signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array> | string> {
    if (this.turnHandler) return this.turnHandler(payload);
    return [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from Claude Web!"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
  }
}

export interface ClaudeAdapterDeps {
  transport?: IClaudeWebTransport;
  continuationCache?: AccountScopedContinuationCache<ClaudeContinuationState>;
  modelCatalogCache?: ModelCatalogCache;
}


export class ClaudeWebAdapter extends BaseWebProviderAdapter {
  readonly id = "claude-web";
  readonly name = "Claude Web";
  readonly defaultBaseUrl = CLAUDE_WEB_CONSTANTS.BASE_URL;

  private readonly transport: IClaudeWebTransport;
  private readonly continuationCache: AccountScopedContinuationCache<ClaudeContinuationState>;
  private readonly modelCatalogCache: ModelCatalogCache;
  private readonly organizationByAccount = new Map<string, string>();
  private readonly organizationLookups = new Map<string, Promise<string>>();

  constructor(deps: ClaudeAdapterDeps = {}) {
    super();
    this.transport = deps.transport ?? new LiveClaudeWebTransport();
    this.modelCatalogCache = deps.modelCatalogCache ?? getDefaultModelCatalogCache();
    this.continuationCache =
      deps.continuationCache ??
      new AccountScopedContinuationCache<ClaudeContinuationState>({
        ttlMs: CLAUDE_WEB_CONSTANTS.CACHE_TTL_MS,
        maxEntries: CLAUDE_WEB_CONSTANTS.CACHE_MAX_ENTRIES,
      });
  }

  private async resolveOrganization(sessionKey: string, cookieHeader: string, organizationId: string | undefined, signal?: AbortSignal): Promise<string> {
    if (organizationId) return organizationId;
    const accountKey = catalogAccountKey("claude-web", sessionKey);
    const cached = this.organizationByAccount.get(accountKey);
    if (cached) return cached;
    const pending = this.organizationLookups.get(accountKey);
    if (pending) return pending;
    const lookup = (async () => {
      const orgId = (await this.transport.fetchOrganizations(cookieHeader, signal))[0]?.id;
      if (!orgId) throw new CredentialError("No active Claude organization found for session");
      this.organizationByAccount.set(accountKey, orgId);
      return orgId;
    })().finally(() => this.organizationLookups.delete(accountKey));
    this.organizationLookups.set(accountKey, lookup);
    return lookup;
  }

  private loadCatalog(sessionKey: string, orgId: string, cookieHeader: string, signal?: AbortSignal) {
    const loader = async () => parseClaudeModelCatalog(await this.transport.fetchBootstrap(orgId, cookieHeader, signal));
    return this.modelCatalogCache
      ? this.modelCatalogCache.get("claude-web", `${sessionKey}::${orgId}`, loader)
      : loader().then(catalog => ({ catalog, status: { fetchedAt: Date.now(), stale: false } }));
  }

  async getCatalog(credentials: unknown, signal?: AbortSignal) {
    const creds = normalizeClaudeSessionCookie(credentials);
    const cookieHeader = buildClaudeCookieHeader(creds);
    const orgId = await this.resolveOrganization(creds.sessionKey, cookieHeader, creds.organizationId, signal);
    return this.loadCatalog(creds.sessionKey, orgId, cookieHeader, signal);
  }

  async refreshCatalog(credentials: unknown, signal?: AbortSignal) {
    const creds = normalizeClaudeSessionCookie(credentials);
    const cookieHeader = buildClaudeCookieHeader(creds);
    const orgId = await this.resolveOrganization(creds.sessionKey, cookieHeader, creds.organizationId, signal);
    const loader = async () => parseClaudeModelCatalog(await this.transport.fetchBootstrap(orgId, cookieHeader, signal));
    return this.modelCatalogCache
      ? this.modelCatalogCache.refresh("claude-web", `${creds.sessionKey}::${orgId}`, loader)
      : this.loadCatalog(creds.sessionKey, orgId, cookieHeader, signal);
  }


  getCapabilities(_model: string): WebProviderCapabilities {
    return {
      supportsStreaming: true,
      supportsReasoning: true,
      supportedThinkingEfforts: [],
      supportsToolCalling: true,
      supportsVision: false,
      supportsFiles: false,
      supportsContinuation: true,
    };
  }

  async discoverModels(credentials: unknown, signal?: AbortSignal): Promise<ClaudeModelCatalog> {
    return (await this.getCatalog(credentials, signal)).catalog;
  }



  async validateCredentials(credentials: unknown): Promise<{ valid: boolean; error?: string }> {
    try {
      normalizeClaudeSessionCookie(credentials);
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async execute(
    request: ChatCompletionRequest,
    credentials: unknown,
    signal?: AbortSignal,
  ): Promise<ChatCompletionResponse | AsyncIterable<ChatCompletionChunk>> {
    const creds = normalizeClaudeSessionCookie(credentials);
    const cookieHeader = buildClaudeCookieHeader(creds);
    const orgId = await this.resolveOrganization(creds.sessionKey, cookieHeader, creds.organizationId, signal);
    const catalog = (await this.loadCatalog(creds.sessionKey, orgId, cookieHeader, signal)).catalog;
    const modelMeta = catalog.models.find(model => model.id === request.model);
    if (!modelMeta) throw new InvalidRequestError("Unknown Claude model");
    if (modelMeta.disabled) throw new InvalidRequestError(`Claude model unavailable: ${modelMeta.badge ?? modelMeta.disabledReason ?? "disabled by upstream"}`);
    const resolvedModel = modelMeta.id;

    // 4. Continuation cache lookup
    // Scope includes account sessionKey (hashed) + orgId + model
    const accountScope = `${creds.sessionKey}::${orgId}::${resolvedModel}`;
    // We compute transcript hash over all preceding messages except the latest user turn if multi-turn
    const hasPriorMessages = request.messages.length > 1;
    const priorMessages = hasPriorMessages ? request.messages.slice(0, -1) : [];
    const transcriptHash =
      AccountScopedContinuationCache.computeTranscriptHash(priorMessages);

    let conversationUuid: string;
    let parentMessageUuid: string | undefined;

    const cachedState = hasPriorMessages
      ? this.continuationCache.get(accountScope, transcriptHash)
      : null;
    if (cachedState) {
      conversationUuid = cachedState.conversationUuid;
      parentMessageUuid = cachedState.lastMessageUuid;
    } else {
      conversationUuid = randomUUID();
    }

    // 5. Build payload
    const payload = transformToClaudePayload(
      request,
      resolvedModel,
      parentMessageUuid,
    );

    // 6. Send turn
    const turnResponse = await this.transport.sendTurn(
      orgId,
      conversationUuid,
      payload,
      cookieHeader,
      signal,
    );

    // 7. Parse response
    const sseDecoder = new SseStreamDecoder();
    const claudeDecoder = new ClaudeSseDecoder();

    if (typeof turnResponse === "string") {
      for (const event of sseDecoder.feed(turnResponse)) {
        claudeDecoder.processEvent(event);
      }
      for (const event of sseDecoder.flush()) {
        claudeDecoder.processEvent(event);
      }
    } else {
      const reader = turnResponse.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            for (const event of sseDecoder.feed(value)) {
              claudeDecoder.processEvent(event);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      for (const event of sseDecoder.flush()) {
        claudeDecoder.processEvent(event);
      }
    }

    claudeDecoder.checkIdleFinish();
    const result = claudeDecoder.getResult();

    // 8. Commit continuation cache ONLY upon successful completion
    if (result.isComplete && result.messageUuid) {
      // Commit state for the transcript including this assistant turn so subsequent turns match
      const completedTranscript = [
        ...request.messages,
        { role: "assistant" as const, content: result.assistantText },
      ];
      const fullTranscriptHash =
        AccountScopedContinuationCache.computeTranscriptHash(
          completedTranscript,
        );
      this.continuationCache.commit(accountScope, fullTranscriptHash, {
        conversationUuid,
        lastMessageUuid: result.messageUuid,
      });
    }

    const completionId = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    if (request.stream) {
      return (async function* () {
        yield {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: resolvedModel,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: result.assistantText || null,
                reasoning_content: result.reasoningText || null,
                tool_calls:
                  result.toolCalls.length > 0
                    ? result.toolCalls.map((tc, idx) => ({ index: idx, ...tc }))
                    : undefined,
              },
              finish_reason: result.stopReason,
            },
          ],
        };
      })();
    }

    return {
      id: completionId,
      object: "chat.completion",
      created,
      model: resolvedModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: result.assistantText || null,
            reasoning_content: result.reasoningText || null,
            tool_calls:
              result.toolCalls.length > 0 ? result.toolCalls : undefined,
          },
          finish_reason: result.stopReason ?? "stop",
        },
      ],
      usage: {
        prompt_tokens: Math.ceil(payload.prompt.length / 4),
        completion_tokens: Math.ceil(result.assistantText.length / 4),
        total_tokens: Math.ceil(
          (payload.prompt.length + result.assistantText.length) / 4,
        ),
      },
    };
  }
}
