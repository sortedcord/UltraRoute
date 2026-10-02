/**
 * Streaming Server-Sent Events (SSE) framing decoder.
 * Handles split chunk boundaries, multi-line data payloads, comments, and CRLF variants.
 */

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

export class SseStreamDecoder {
  private buffer = "";

  /**
   * Ingest a chunk of text or UTF-8 buffer and yield complete SSE events.
   */
  *feed(chunk: string | Uint8Array): Generator<SseEvent> {
    const text = typeof chunk === "string" ? chunk : new TextDecoder("utf-8").decode(chunk);
    this.buffer += text;

    const normalized = this.buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const blocks = normalized.split("\n\n");

    // The last element is the remaining incomplete block
    this.buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      if (!block.trim()) continue;
      const event = this.parseBlock(block);
      if (event) yield event;
    }
  }

  /**
   * Flush remaining buffered data at end of stream.
   */
  *flush(): Generator<SseEvent> {
    if (!this.buffer.trim()) {
      this.buffer = "";
      return;
    }
    const block = this.buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    this.buffer = "";
    const event = this.parseBlock(block);
    if (event) yield event;
  }

  private parseBlock(block: string): SseEvent | null {
    let eventName = "message";
    const dataLines: string[] = [];
    let id: string | undefined;
    let retry: number | undefined;

    const lines = block.split("\n");
    for (const line of lines) {
      if (line.startsWith(":")) continue; // comment
      if (!line) continue;

      const colonIndex = line.indexOf(":");
      let field = line;
      let value = "";
      if (colonIndex !== -1) {
        field = line.slice(0, colonIndex);
        value = line.slice(colonIndex + 1);
        if (value.startsWith(" ")) value = value.slice(1);
      }

      if (field === "event") {
        eventName = value;
      } else if (field === "data") {
        dataLines.push(value);
      } else if (field === "id") {
        id = value;
      } else if (field === "retry") {
        const parsed = parseInt(value, 10);
        if (!Number.isNaN(parsed)) retry = parsed;
      }
    }

    if (dataLines.length === 0 && eventName === "message") {
      return null;
    }

    return {
      event: eventName,
      data: dataLines.join("\n"),
      id,
      retry,
    };
  }
}
