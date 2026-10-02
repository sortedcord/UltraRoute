/**
 * Shared types for UltraRoute web-session-backed AI provider adapters.
 */

export type Role = "system" | "user" | "assistant" | "tool";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export interface ToolFunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ToolDefinition {
  type: "function";
  function: ToolFunctionDefinition;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface AttachmentSource {
  type: "image" | "file";
  mimeType: string;
  data?: Uint8Array | Buffer;
  url?: string;
  fileName?: string;
  dimensions?: { width: number; height: number };
}

export interface MessageContentPart {
  type: "text" | "image_url" | "input_audio" | "file";
  text?: string;
  image_url?: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
  file?: {
    url?: string;
    mimeType?: string;
    fileName?: string;
  };
}

export interface ChatMessage {
  role: Role;
  content: string | MessageContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  reasoning_content?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  reasoning_effort?: ReasoningEffort;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  user?: string;
  metadata?: Record<string, unknown>;
  attachments?: AttachmentSource[];
}
export interface CitationSource {
  id: string;
  url: string;
  title?: string;
  favicon?: string;
  startIndex?: number;
  endIndex?: number;
  snippet?: string;
  citationNumber?: number;
}

export interface ChatCompletionChoiceDelta {
  role?: Role;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
  citations?: CitationSource[];
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: ChatCompletionChoiceDelta;
    finish_reason: "stop" | "tool_calls" | "length" | "content_filter" | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: Role;
    content: string | null;
    reasoning_content?: string | null;
    tool_calls?: ToolCall[];
    citations?: CitationSource[];
  };
  finish_reason: "stop" | "tool_calls" | "length" | "content_filter";
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface WebProviderCapabilities {
  supportsStreaming: boolean;
  supportsReasoning: boolean;
  supportedThinkingEfforts: readonly ReasoningEffort[];
  supportsToolCalling: boolean;
  supportsVision: boolean;
  supportsFiles: boolean;
  supportsContinuation: boolean;
  maxContextTokens?: number;
  maxOutputTokens?: number;
}
