import { randomUUID } from "node:crypto";
import type { ToolCall } from "../../shared/types.ts";
import { SseStreamDecoder, type SseEvent } from "../../shared/sseDecoder.ts";
import { CLAUDE_WEB_CONSTANTS } from "./constants.ts";

export interface ClaudeParsedTurnResult {
  assistantText: string;
  reasoningText: string;
  toolCalls: ToolCall[];
  stopReason: "stop" | "tool_calls" | "length" | null;
  conversationUuid?: string;
  messageUuid?: string;
  isComplete: boolean;
}

/**
 * Isolated SSE Stream Decoder for Claude Web.
 * Understands message_start, content_block_start, content_block_delta,
 * content_block_stop, message_delta, and message_stop.
 * Implements bounded idle-finish timeout for tool_use blocks.
 */
export class ClaudeSseDecoder {
  private assistantParts: string[] = [];
  private reasoningParts: string[] = [];
  private openTools = new Map<number, { id: string; name: string; inputParts: string[] }>();
  private completedTools: ToolCall[] = [];
  private stopReason: "stop" | "tool_calls" | "length" | null = null;
  private conversationUuid?: string;
  private messageUuid?: string;
  private isFinished = false;
  private lastActivityTimestamp = Date.now();
  private readonly toolUseIdleFinishMs: number;

  constructor(opts: { toolUseIdleFinishMs?: number } = {}) {
    this.toolUseIdleFinishMs = opts.toolUseIdleFinishMs ?? CLAUDE_WEB_CONSTANTS.DEFAULT_TOOL_USE_IDLE_FINISH_MS;
  }

  processEvent(event: SseEvent): void {
    this.lastActivityTimestamp = Date.now();
    if (!event.data || event.data === "[DONE]") {
      if (event.data === "[DONE]") this.isFinished = true;
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }

    const eventType = (payload.type as string) || event.event;

    switch (eventType) {
      case "message_start": {
        const msg = payload.message as Record<string, unknown> | undefined;
        if (msg) {
          if (typeof msg.id === "string") this.messageUuid = msg.id;
        }
        break;
      }
      case "content_block_start": {
        const index = typeof payload.index === "number" ? payload.index : 0;
        const block = payload.content_block as Record<string, unknown> | undefined;
        if (block?.type === "tool_use") {
          this.openTools.set(index, {
            id: (block.id as string) || `toolu_${randomUUID()}`,
            name: (block.name as string) || "",
            inputParts: [],
          });
        }
        break;
      }
      case "content_block_delta": {
        const delta = payload.delta as Record<string, unknown> | undefined;
        const index = typeof payload.index === "number" ? payload.index : 0;
        if (!delta) break;

        if (delta.type === "text_delta" && typeof delta.text === "string") {
          this.assistantParts.push(delta.text);
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          this.reasoningParts.push(delta.thinking);
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const tool = this.openTools.get(index);
          if (tool) {
            tool.inputParts.push(delta.partial_json);
          }
        }
        break;
      }
      case "content_block_stop": {
        const index = typeof payload.index === "number" ? payload.index : 0;
        const tool = this.openTools.get(index);
        if (tool) {
          this.completedTools.push({
            id: tool.id,
            type: "function",
            function: {
              name: tool.name,
              arguments: tool.inputParts.join(""),
            },
          });
          this.openTools.delete(index);
        }
        break;
      }
      case "message_delta": {
        const delta = payload.delta as Record<string, unknown> | undefined;
        if (typeof delta?.stop_reason === "string") {
          const rawReason = delta.stop_reason;
          if (rawReason === "tool_use") this.stopReason = "tool_calls";
          else if (rawReason === "end_turn") this.stopReason = "stop";
          else if (rawReason === "max_tokens") this.stopReason = "length";
          else this.stopReason = "stop";
        }
        break;
      }
      case "message_stop": {
        this.isFinished = true;
        if (!this.stopReason) {
          this.stopReason = this.completedTools.length > 0 ? "tool_calls" : "stop";
        }
        break;
      }
      case "completion": {
        // Legacy completion event fallback
        if (typeof payload.completion === "string") {
          this.assistantParts.push(payload.completion);
        }
        break;
      }
    }
  }

  /**
   * Checks if an idle finish should be synthesized for tool calls when stream hangs open.
   */
  checkIdleFinish(now = Date.now()): boolean {
    if (this.isFinished) return true;
    if (
      this.completedTools.length > 0 &&
      this.openTools.size === 0 &&
      now - this.lastActivityTimestamp >= this.toolUseIdleFinishMs
    ) {
      this.isFinished = true;
      this.stopReason = "tool_calls";
      return true;
    }
    return false;
  }

  getResult(): ClaudeParsedTurnResult {
    return {
      assistantText: this.assistantParts.join(""),
      reasoningText: this.reasoningParts.join(""),
      toolCalls: [...this.completedTools],
      stopReason: this.stopReason ?? (this.completedTools.length > 0 ? "tool_calls" : "stop"),
      conversationUuid: this.conversationUuid,
      messageUuid: this.messageUuid,
      isComplete: this.isFinished,
    };
  }
}
