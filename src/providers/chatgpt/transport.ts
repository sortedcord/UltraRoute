/*
 * Handoff/topic protocol adapted from OmniRoute, MIT License.
 * Copyright (c) 2026 diegosouzapw
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { UpstreamDriftError } from "../../shared/errors.ts";
import { parseEncodedItem } from "./deltaV1.ts";

export interface HandoffBootstrap {
  websocketTopicId: string;
  conversationId?: string;
  turnExchangeId?: string;
  resumeToken?: string;
}

/** Bootstrap identifiers are private transport state, never error context. */
export function parseHandoffBootstrap(
  rawText: string,
): HandoffBootstrap | null {
  let conversationId: string | undefined;
  let resumeConversation: string | undefined;
  let turnExchangeId: string | undefined;
  let resumeToken: string | undefined;
  let websocketTopicId: string | undefined;
  let resumeTopic: string | undefined;
  let handoff = false;
  for (const event of parseEncodedItem(rawText)) {
    const json = event.json as Record<string, unknown> | undefined;
    if (!json || typeof json !== "object") continue;
    if (json.type === "resume_conversation_token") {
      resumeToken = requiredString(json.token);
      resumeConversation = requiredString(json.conversation_id);
    }
    if (json.type !== "stream_handoff") continue;
    handoff = true;
    conversationId = requiredString(json.conversation_id);
    turnExchangeId = requiredString(json.turn_exchange_id);
    if (!Array.isArray(json.options))
      throw new UpstreamDriftError("ChatGPT handoff options missing");
    for (const option of json.options) {
      if (option?.type === "subscribe_ws_topic")
        websocketTopicId = requiredString(option.topic_id);
      if (option?.type === "resume_sse_endpoint")
        resumeTopic = requiredString(option.topic_id);
    }
  }
  if (!handoff) return null;
  if (
    !resumeToken ||
    !websocketTopicId ||
    !resumeTopic ||
    resumeTopic !== websocketTopicId ||
    resumeConversation !== conversationId
  ) {
    throw new UpstreamDriftError("ChatGPT handoff incomplete or inconsistent");
  }
  return { websocketTopicId, conversationId, turnExchangeId, resumeToken };
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new UpstreamDriftError("ChatGPT transport identifier missing");
  return value;
}

/** Topic demultiplexer adapted from OmniRoute (MIT, copyright 2026 diegosouzapw). */
export class ChatGptTopicStream {
  private seen = new Set<string>();
  private done = false;
  private readonly topic: string;
  constructor(topic: string) {
    this.topic = topic;
  }
  ingestFrame(text: string): { encodedItems: string[]; done: boolean } {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      throw new UpstreamDriftError("ChatGPT WebSocket frame malformed");
    }
    if (!Array.isArray(frame))
      throw new UpstreamDriftError("ChatGPT WebSocket frame is not an array");
    const encodedItems: string[] = [];
    const consume = (item: any): void => {
      if (item?.type === "reply" && Array.isArray(item.reply?.catchups)) {
        for (const catchup of item.reply.catchups) consume(catchup);
      }
      if (
        item?.type !== "message" ||
        item.topic_id !== this.topic ||
        item.payload?.type !== "conversation-turn-stream"
      )
        return;
      const payload = item.payload.payload;
      if (payload?.type === "done") this.done = true;
      if (payload?.type !== "stream-item") return;
      const id = requiredString(payload.stream_item_id);
      if (this.seen.has(id)) return;
      if (this.seen.size >= 2048)
        throw new UpstreamDriftError("ChatGPT topic item bound exceeded");
      this.seen.add(id);
      encodedItems.push(requiredString(payload.encoded_item));
    };
    for (const item of frame) consume(item);
    return { encodedItems, done: this.done };
  }
}

export interface IChatGptTransportSession {
  executeDirectTurn(payload: unknown, signal?: AbortSignal): Promise<string>;
  executeWebSocketTurn(
    bootstrap: HandoffBootstrap,
    signal?: AbortSignal,
  ): Promise<string>;
  close?(): Promise<void>;
}
