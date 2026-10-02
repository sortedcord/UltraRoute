import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  WebProviderCapabilities,
} from "./types.ts";

export interface IWebSessionProvider {
  readonly id: string;
  readonly name: string;
  readonly defaultBaseUrl: string;

  getCapabilities(model: string): WebProviderCapabilities;
  validateCredentials(credentials: unknown): Promise<{ valid: boolean; error?: string }>;
  execute(
    request: ChatCompletionRequest,
    credentials: unknown,
    signal?: AbortSignal
  ): Promise<ChatCompletionResponse | AsyncIterable<ChatCompletionChunk>>;
}

export abstract class BaseWebProviderAdapter implements IWebSessionProvider {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly defaultBaseUrl: string;

  abstract getCapabilities(model: string): WebProviderCapabilities;
  abstract validateCredentials(credentials: unknown): Promise<{ valid: boolean; error?: string }>;

  abstract execute(
    request: ChatCompletionRequest,
    credentials: unknown,
    signal?: AbortSignal
  ): Promise<ChatCompletionResponse | AsyncIterable<ChatCompletionChunk>>;

  /**
   * Helper to format an SSE chunk as OpenAI-compatible wire string
   */
  protected formatSseChunk(chunk: ChatCompletionChunk): string {
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  /**
   * Helper to format final [DONE] event
   */
  protected formatSseDone(): string {
    return `data: [DONE]\n\n`;
  }
}
