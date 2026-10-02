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
import {
  CHATGPT_WEB_CONSTANTS,
  CHATGPT_WEB_MODELS,
  REASONING_EFFORT_MAP,
} from "./constants.ts";
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
import type { ChatGptWebUiSelection } from "./firstParty.ts";
import {
  isChatGptProfileCredential,
  validateChatGptProfile,
  type ChatGptProfileCredential,
} from "./profile.ts";

export interface ChatGptAdapterDeps {
  transportSession?: IChatGptTransportSession;
  browserBridgeFactory?: (
    state: ChatGptStorageState | ChatGptProfileCredential,
  ) => Promise<IChatGptTransportSession>;
}

export class ChatGptWebAdapter extends BaseWebProviderAdapter {
  readonly id = "chatgpt-web";
  readonly name = "ChatGPT Web";
  readonly defaultBaseUrl = CHATGPT_WEB_CONSTANTS.BASE_URL;
  private readonly deps: ChatGptAdapterDeps;
  constructor(deps: ChatGptAdapterDeps = {}) {
    super();
    this.deps = deps;
  }

  getCapabilities(model: string): WebProviderCapabilities {
    const found = CHATGPT_WEB_MODELS.find(
      (m) => m.id === model || (m.aliases as readonly string[]).includes(model),
    );
    return {
      // Browser turns buffer upstream; downstream SSE is supported, not token streaming.
      supportsStreaming: false,
      supportsReasoning: found
        ? "reasoningEffortIndex" in found && found.reasoningEffortIndex > 0
        : false,
      supportedThinkingEfforts: [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ],
      supportsToolCalling: false,
      supportsVision: true,
      supportsFiles: true,
      supportsContinuation: false,
      maxContextTokens: 128_000,
      maxOutputTokens: 16_384,
    };
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
    const storageState = isChatGptProfileCredential(credentials)
      ? {
          browserProfile: await validateChatGptProfile(
            credentials.browserProfile,
          ),
        }
      : validateAndNormalizeStorageState(credentials);
    if (!request.messages?.length)
      throw new InvalidRequestError("Request messages cannot be empty");
    if (
      request.tools?.length ||
      request.messages.some((m) => m.role === "tool" || m.tool_calls?.length)
    )
      throw new InvalidRequestError(
        "ChatGPT Web does not provide native third-party tool calls",
      );
    const model = CHATGPT_WEB_MODELS.find(
      (m) =>
        m.id === request.model ||
        (m.aliases as readonly string[]).includes(request.model),
    );
    if (!model) throw new InvalidRequestError("Unknown ChatGPT Web model");
    const effort =
      request.reasoning_effort === "none"
        ? 0
        : request.reasoning_effort
          ? REASONING_EFFORT_MAP[request.reasoning_effort]
          : "reasoningEffortIndex" in model
            ? model.reasoningEffortIndex
            : 0;
    if (effort === undefined)
      throw new InvalidRequestError("Unsupported ChatGPT reasoning effort");
    const selection: ChatGptWebUiSelection =
      model.uiKind === "free"
        ? {
            kind: "free",
            thinkEnabled: request.reasoning_effort
              ? effort > 0
              : model.thinkEnabled,
          }
        : {
            kind: "picker",
            modelLabel: model.uiLabel,
            effortIndex: effort as 0 | 1 | 2 | 3 | 4,
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
    const attachments = await resolveChatGptWebAttachments(sources);
    if (!this.deps.transportSession && !this.deps.browserBridgeFactory)
      throw new GenericUpstreamError(
        "ChatGPT browser transport is not configured",
        503,
        false,
      );
    const turnSignal = AbortSignal.any([
      AbortSignal.timeout(CHATGPT_WEB_CONSTANTS.DEFAULT_TURN_TIMEOUT_MS),
      ...(signal ? [signal] : []),
    ]);
    let transport: IChatGptTransportSession | undefined;
    let finalSse: string;
    try {
      transport =
        this.deps.transportSession ??
        (await this.deps.browserBridgeFactory!(storageState));
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
        ? await transport.executeWebSocketTurn(handoff, turnSignal)
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
