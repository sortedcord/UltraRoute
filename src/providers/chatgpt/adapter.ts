import { randomUUID } from "node:crypto";
import {
  BaseWebProviderAdapter,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type WebProviderCapabilities,
} from "../../shared/index.ts";
import {
  GenericUpstreamError,
  InvalidRequestError,
  ProviderTimeoutError,
  UpstreamDriftError,
} from "../../shared/errors.ts";
import { CHATGPT_WEB_CONSTANTS } from "./constants.ts";
import {
  getDefaultModelCatalogCache,
  type ModelCatalogCache,
} from "../../shared/modelCatalogCache.ts";
import {
  chatGptTransportCapabilities,
  parseChatGptModelCatalog,
  type ChatGptModelCatalog,
} from "./models.ts";
import {
  validateAndNormalizeStorageState,
  type ChatGptStorageState,
} from "./storageState.ts";
import { ChatGptDeltaV1Decoder } from "./deltaV1.ts";
import {
  parseHandoffBootstrap,
  type IChatGptTransportSession,
} from "./transport.ts";
import { resolveChatGptWebAttachments } from "./attachments.ts";
import type { ChatGptWebSelection } from "./firstParty.ts";
import {
  isChatGptProfileCredential,
  validateChatGptProfile,
  type ChatGptProfileCredential,
} from "./profile.ts";

export type ChatGptCredential = ChatGptStorageState | ChatGptProfileCredential;

export interface ChatGptAdapterDeps {
  transportSession?: IChatGptTransportSession;
  transportFactory?: (
    state: ChatGptCredential,
    signal?: AbortSignal,
  ) => Promise<IChatGptTransportSession>;
  modelCatalogSource?: {
    getAccountIdentity(
      state: ChatGptCredential,
      signal?: AbortSignal,
    ): Promise<string>;
    fetchModels(
      state: ChatGptCredential,
      signal?: AbortSignal,
      expectedIdentity?: string,
    ): Promise<unknown>;
  };
  modelCatalogCache?: ModelCatalogCache;
}

export class ChatGptWebAdapter extends BaseWebProviderAdapter {
  readonly id = "chatgpt-web";
  readonly name = "ChatGPT Web";
  readonly defaultBaseUrl = CHATGPT_WEB_CONSTANTS.BASE_URL;
  private readonly deps: ChatGptAdapterDeps;
  private readonly modelCatalogCache: ModelCatalogCache;
  constructor(deps: ChatGptAdapterDeps = {}) {
    super();
    this.deps = deps;
    this.modelCatalogCache =
      deps.modelCatalogCache ?? getDefaultModelCatalogCache();
  }

  getCapabilities(_model: string): WebProviderCapabilities {
    // This synchronous API has no account context: never reuse another account's metadata.
    return chatGptTransportCapabilities();
  }

  private async normalizeCredentials(
    credentials: unknown,
  ): Promise<ChatGptCredential> {
    return isChatGptProfileCredential(credentials)
      ? {
          browserProfile: await validateChatGptProfile(
            credentials.browserProfile,
          ),
        }
      : validateAndNormalizeStorageState(credentials);
  }

  private async loadCatalog(
    state: ChatGptCredential,
    refresh: boolean,
    signal?: AbortSignal,
  ) {
    const source = this.deps.modelCatalogSource;
    if (!source)
      throw new GenericUpstreamError(
        "ChatGPT model catalog source is not configured",
        503,
        false,
      );
    const account = await source.getAccountIdentity(state, signal);
    if (typeof account !== "string" || !account.trim())
      throw new UpstreamDriftError("ChatGPT account identity is missing");
    const loader = async () =>
      parseChatGptModelCatalog(
        await source.fetchModels(state, signal, account),
      );
    return refresh
      ? this.modelCatalogCache.refresh("chatgpt-web", account, loader)
      : this.modelCatalogCache.get("chatgpt-web", account, loader);
  }

  async getCatalog(credentials: unknown, signal?: AbortSignal) {
    return this.loadCatalog(
      await this.normalizeCredentials(credentials),
      false,
      signal,
    );
  }

  async refreshCatalog(credentials: unknown, signal?: AbortSignal) {
    return this.loadCatalog(
      await this.normalizeCredentials(credentials),
      true,
      signal,
    );
  }

  async discoverModels(
    credentials: unknown,
    signal?: AbortSignal,
  ): Promise<ChatGptModelCatalog> {
    return (await this.getCatalog(credentials, signal)).catalog;
  }

  async validateCredentials(
    credentials: unknown,
  ): Promise<{ valid: boolean; error?: string }> {
    try {
      if (isChatGptProfileCredential(credentials))
        await validateChatGptProfile(credentials.browserProfile);
      else validateAndNormalizeStorageState(credentials);
      return { valid: true };
    } catch {
      return {
        valid: false,
        error:
          "ChatGPT credentials must contain valid first-party cookies/storage state",
      };
    }
  }

  async execute(
    request: ChatCompletionRequest,
    credentials: unknown,
    signal?: AbortSignal,
  ): Promise<ChatCompletionResponse | AsyncIterable<ChatCompletionChunk>> {
    const turnSignal = AbortSignal.any([
      AbortSignal.timeout(CHATGPT_WEB_CONSTANTS.DEFAULT_TURN_TIMEOUT_MS),
      ...(signal ? [signal] : []),
    ]);
    if (turnSignal.aborted)
      throw new ProviderTimeoutError("ChatGPT turn cancelled or timed out");
    const storageState = await this.normalizeCredentials(credentials);
    if (!request.messages?.length)
      throw new InvalidRequestError("Request messages cannot be empty");
    if (
      request.tools?.length ||
      request.messages.some((m) => m.role === "tool" || m.tool_calls?.length)
    )
      throw new InvalidRequestError(
        "ChatGPT Web does not provide native third-party tool calls",
      );
    const catalog = (await this.loadCatalog(storageState, false, turnSignal))
      .catalog;
    const model = catalog.models.find((model) => model.id === request.model);
    if (!model) throw new InvalidRequestError("Unknown ChatGPT Web model");
    if (model.disabled)
      throw new InvalidRequestError(
        "ChatGPT Web model unavailable for this account",
      );
    const effort = request.reasoning_effort ?? model.defaultReasoningLevel;
    const level = model.reasoningLevels.find((level) => level.value === effort);
    if (!level)
      throw new InvalidRequestError("Unsupported ChatGPT reasoning effort");
    if (level.disabled)
      throw new InvalidRequestError(
        "ChatGPT reasoning effort unavailable for this account",
      );
    const selection: ChatGptWebSelection = {
      model: level.model,
      ...(level.thinkingEffort ? { thinkingEffort: level.thinkingEffort } : {}),
    };
    const sources = [...(request.attachments ?? [])];
    const prompt = request.messages
      .map((message) => {
        if (typeof message.content === "string")
          return `${message.role.toUpperCase()}: ${message.content}`;
        const text: string[] = [];
        for (const part of message.content) {
          if (part.type === "text") text.push(part.text ?? "");
          else if (part.type === "image_url" && part.image_url) {
            // MIME must be supplied by a data URL; remote input needs explicit AttachmentSource metadata.
            const mimeType = /^data:([^;]+);base64,/.exec(
              part.image_url.url,
            )?.[1];
            if (!mimeType)
              throw new InvalidRequestError(
                "Remote image input requires attachments with an explicit MIME type",
              );
            sources.push({ type: "image", mimeType, url: part.image_url.url });
          } else if (
            part.type === "file" &&
            part.file?.url &&
            part.file.mimeType
          )
            sources.push({
              type: "file",
              url: part.file.url,
              mimeType: part.file.mimeType,
              fileName: part.file.fileName,
            });
          else
            throw new InvalidRequestError(
              "Unsupported ChatGPT message content part",
            );
        }
        return `${message.role.toUpperCase()}: ${text.join("\n")}`;
      })
      .join("\n\n");
    if (Buffer.byteLength(prompt) > CHATGPT_WEB_CONSTANTS.MAX_PROMPT_BYTES)
      throw new InvalidRequestError("ChatGPT prompt exceeds byte limit");
    const attachments = await resolveChatGptWebAttachments(sources, {
      signal: turnSignal,
    });
    if (!this.deps.transportSession && !this.deps.transportFactory)
      throw new GenericUpstreamError(
        "ChatGPT browser transport is not configured",
        503,
        false,
      );
    let transport: IChatGptTransportSession | undefined;
    let finalSse: string;
    try {
      transport =
        this.deps.transportSession ??
        (await this.deps.transportFactory!(storageState, turnSignal));
      if (turnSignal.aborted)
        throw new ProviderTimeoutError(
          "ChatGPT browser turn cancelled or timed out",
        );
      const raw = await transport.executeDirectTurn(
        { prompt, attachments, selection },
        turnSignal,
      );
      const handoff = parseHandoffBootstrap(raw);
      finalSse = handoff
        ? raw +
          "\n\n" +
          (await transport.executeWebSocketTurn(handoff, turnSignal))
        : raw;
    } finally {
      // Close only factory-owned sessions; injected reusable transports belong to their caller.
      if (!this.deps.transportSession) await transport?.close?.();
    }
    const decoder = new ChatGptDeltaV1Decoder();
    const decoded = decoder.ingest(finalSse);
    if (!decoder.isTurnFinished())
      throw new UpstreamDriftError(
        "ChatGPT stream ended without a successful assistant end-of-turn",
      );
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    if (request.stream)
      return (async function* () {
        yield {
          id,
          object: "chat.completion.chunk" as const,
          created,
          model: model.id,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant" as const,
                content: decoded.assistantText,
              },
              finish_reason: null,
            },
          ],
        };
        yield {
          id,
          object: "chat.completion.chunk" as const,
          created,
          model: model.id,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" as const }],
        };
      })();
    return {
      id,
      object: "chat.completion",
      created,
      model: model.id,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: decoded.assistantText },
          finish_reason: "stop",
        },
      ],
    };
  }
}
