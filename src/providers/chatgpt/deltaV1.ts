import { UpstreamDriftError } from "../../shared/errors.ts";

export interface DeltaV1Operation {
  p?: string; // JSON Pointer path
  o?: "add" | "append" | "patch" | "replace";
  v?: unknown;
}

export interface DeltaV1Event {
  event: string;
  data: string;
  json?: unknown;
  done: boolean;
}

export interface DeltaV1IngestResult {
  events: DeltaV1Event[];
  changed: boolean;
  done: boolean;
  assistantText: string;
  status?: string;
}

type Operation = NonNullable<DeltaV1Operation["o"]>;
type JsonRecord = Record<string, unknown>;
interface AssistantDocument {
  message?: {
    author?: { role?: unknown };
    channel?: unknown;
    metadata?: { channel?: unknown };
    recipient?: unknown;
    content?: { content_type?: unknown; parts?: unknown[] };
    status?: unknown;
    end_turn?: unknown;
  };
}
const DELTA_OPERATIONS: Record<string, boolean> = {
  add: true,
  append: true,
  patch: true,
  replace: true,
};
const FORBIDDEN_POINTER_SEGMENTS: Record<string, boolean> = {
  ["__proto__"]: true,
  constructor: true,
  prototype: true,
};

function assertSafeValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSafeValue(item);
  } else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(FORBIDDEN_POINTER_SEGMENTS, key)) {
        throw new UpstreamDriftError("Forbidden object key in ChatGPT delta");
      }
      const record = value as JsonRecord;
      assertSafeValue(record[key]);
    }
  }
}

function encodedEvent(event: string, data: string): DeltaV1Event {
  if (data === "[DONE]") return { event, data, done: true };
  try {
    return { event, data, json: JSON.parse(data), done: false };
  } catch {
    return { event, data, done: false };
  }
}

function pointerToSegments(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer)) {
    throw new UpstreamDriftError("Malformed JSON Pointer in ChatGPT delta");
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => {
      const decoded = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      if (Object.hasOwn(FORBIDDEN_POINTER_SEGMENTS, decoded)) {
        throw new UpstreamDriftError(
          "Forbidden JSON Pointer segment in ChatGPT delta",
        );
      }
      return decoded;
    });
}

function parseArrayIndex(
  segment: string,
  length: number,
  allowAppend: boolean,
): number {
  if (allowAppend && segment === "-") return length;
  if (!/^(?:0|[1-9]\d*)$/.test(segment)) {
    throw new UpstreamDriftError("Invalid array index in ChatGPT delta");
  }
  const index = Number(segment);
  if (
    !Number.isSafeInteger(index) ||
    index > (allowAppend ? length : length - 1)
  ) {
    throw new UpstreamDriftError("Array index out of bounds in ChatGPT delta");
  }
  return index;
}

function requireOperation(value: unknown): Operation {
  if (typeof value !== "string" || !Object.hasOwn(DELTA_OPERATIONS, value)) {
    throw new UpstreamDriftError("Unsupported ChatGPT delta operation");
  }
  return value as Operation;
}

function appendValue(target: unknown, incoming: unknown): unknown {
  if (target === undefined || target === null) return structuredClone(incoming);
  if (typeof target === "string" && typeof incoming === "string")
    return target + incoming;
  if (Array.isArray(target)) {
    if (Array.isArray(incoming)) {
      for (const item of incoming) target.push(structuredClone(item));
    } else {
      target.push(structuredClone(incoming));
    }
    return target;
  }
  if (
    typeof target === "object" &&
    target !== null &&
    typeof incoming === "object" &&
    incoming !== null &&
    !Array.isArray(incoming)
  ) {
    const current = target as JsonRecord;
    const next = incoming as JsonRecord;
    for (const key of Object.keys(next))
      current[key] = structuredClone(next[key]);
    return target;
  }
  throw new UpstreamDriftError("Cannot append mismatched ChatGPT delta types");
}

/** Parse a complete browser encoded_item, including an unterminated last frame. */
export function parseEncodedItem(rawText: string): DeltaV1Event[] {
  const events: DeltaV1Event[] = [];
  let eventName = "message";
  let dataLines: string[] = [];
  const flush = () => {
    if (dataLines.length)
      events.push(encodedEvent(eventName, dataLines.join("\n")));
    eventName = "message";
    dataLines = [];
  };
  for (const line of rawText.replace(/\r\n?/g, "\n").split("\n")) {
    if (line === "") {
      flush();
    } else if (!line.startsWith(":")) {
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") eventName = value || "message";
      else if (field === "data") dataLines.push(value);
    }
  }
  flush();
  return events;
}

/** Stateful SSE and compact Delta V1 decoder. [DONE] is not proof of a successful turn. */
export class ChatGptDeltaV1Decoder {
  private document: unknown = null;
  private lastPath: string | null = null;
  private lastOp: Operation | null = null;
  private assistantText = "";
  private assistantStatus: string | undefined;
  private successfulTurn = false;
  private pendingText = "";
  private eventName = "message";
  private dataLines: string[] = [];
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });
  private hasByteChunks = false;
  private pendingUtf8Bytes = 0;

  getDocument(): unknown {
    return structuredClone(this.document);
  }

  getAssistantText(): string {
    return this.assistantText;
  }

  getStatus(): string | undefined {
    return this.assistantStatus;
  }

  isTurnFinished(): boolean {
    return (
      this.successfulTurn &&
      this.pendingUtf8Bytes === 0 &&
      this.pendingText === "" &&
      this.dataLines.length === 0 &&
      this.eventName === "message"
    );
  }

  /** Ingest terminated SSE frames; retain partial frames and UTF-8 sequences for the next call. */
  ingest(chunk: string | Uint8Array): DeltaV1IngestResult {
    try {
      if (typeof chunk === "string") {
        this.pendingText +=
          (this.hasByteChunks ? this.utf8.decode() : "") + chunk;
        this.hasByteChunks = false;
        this.pendingUtf8Bytes = 0;
      } else {
        this.pendingText += this.utf8.decode(chunk, { stream: true });
        this.hasByteChunks = true;
        // TextDecoder retains incomplete code points internally; do not call that a complete turn.
        if (chunk.length) {
          let start = chunk.length - 1;
          while (start >= 0 && (chunk[start] & 0xc0) === 0x80) start--;
          if (start < 0) {
            this.pendingUtf8Bytes = Math.max(
              0,
              this.pendingUtf8Bytes - chunk.length,
            );
          } else {
            const lead = chunk[start];
            const width =
              lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
            this.pendingUtf8Bytes = Math.max(0, width - (chunk.length - start));
          }
        }
      }
    } catch {
      throw new UpstreamDriftError("Malformed UTF-8 in ChatGPT SSE");
    }
    const events: DeltaV1Event[] = [];
    const newlines = /\r\n|\r|\n/g;
    let offset = 0;
    let match: RegExpExecArray | null;
    while ((match = newlines.exec(this.pendingText)) !== null) {
      if (match[0] === "\r" && newlines.lastIndex === this.pendingText.length)
        break;
      const line = this.pendingText.slice(offset, match.index);
      offset = newlines.lastIndex;
      if (line === "") {
        if (this.dataLines.length)
          events.push(encodedEvent(this.eventName, this.dataLines.join("\n")));
        this.eventName = "message";
        this.dataLines = [];
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") this.eventName = value || "message";
        else if (field === "data") this.dataLines.push(value);
      }
    }
    this.pendingText = this.pendingText.slice(offset);
    let changed = false;
    for (const event of events) {
      if (event.event === "delta_encoding") {
        if (event.json !== "v1")
          throw new UpstreamDriftError(
            "Unsupported ChatGPT delta encoding version",
          );
        this.document = null;
        this.lastPath = null;
        this.lastOp = null;
        this.assistantText = "";
        this.assistantStatus = undefined;
        this.successfulTurn = false;
      } else if (
        !event.done &&
        (event.event === "delta" || event.event === "message")
      ) {
        if (
          event.json === null ||
          typeof event.json !== "object" ||
          Array.isArray(event.json)
        ) {
          throw new UpstreamDriftError("Malformed ChatGPT SSE payload");
        }
        const payload = event.json as JsonRecord;
        if (
          event.event === "delta" ||
          ["p", "o", "v"].some((key) => Object.hasOwn(payload, key))
        ) {
          this.applyDelta(payload);
          changed = true;
        } else if (Object.hasOwn(payload, "message")) {
          if (
            payload.message === null ||
            typeof payload.message !== "object" ||
            Array.isArray(payload.message)
          ) {
            throw new UpstreamDriftError("Malformed ChatGPT message payload");
          }
          assertSafeValue(payload);
          this.document = structuredClone(payload);
          this.lastPath = null;
          this.lastOp = null;
          changed = true;
        }
        this.captureAssistant();
      }
    }
    return {
      events,
      changed,
      done: this.isTurnFinished(),
      assistantText: this.getAssistantText(),
      status: this.getStatus(),
    };
  }

  private captureAssistant(): void {
    if (
      this.document === null ||
      typeof this.document !== "object" ||
      Array.isArray(this.document)
    )
      return;
    const document = this.document as AssistantDocument;
    const message = document.message;
    if (
      !message ||
      typeof message !== "object" ||
      message.author?.role !== "assistant"
    )
      return;
    const channel = message.channel ?? message.metadata?.channel;
    if (channel !== undefined && channel !== null && channel !== "final")
      return;
    if (message.recipient !== undefined && message.recipient !== "all") return;
    if (!message.content || !Array.isArray(message.content.parts)) return;
    if (
      message.content.content_type !== undefined &&
      message.content.content_type !== "text" &&
      message.content.content_type !== "multimodal_text"
    )
      return;
    this.assistantText = message.content.parts
      .filter((part): part is string => typeof part === "string")
      .join("");
    this.assistantStatus =
      typeof message.status === "string" ? message.status : undefined;
    this.successfulTurn =
      message.status === "finished_successfully" && message.end_turn === true;
  }

  private applyDelta(payload: JsonRecord): void {
    const path = payload.p === undefined ? this.lastPath : payload.p;
    const operation =
      payload.o === undefined ? this.lastOp : requireOperation(payload.o);
    if (
      typeof path !== "string" ||
      operation === null ||
      !Object.hasOwn(payload, "v")
    ) {
      throw new UpstreamDriftError(
        "ChatGPT delta requires a valid path, operation, and value",
      );
    }
    assertSafeValue(payload.v);
    this.applyAtPath(path, operation, payload.v);
    this.lastPath = path;
    this.lastOp = operation;
  }

  private applyAtPath(
    path: string,
    operation: Operation,
    value: unknown,
  ): void {
    const segments = pointerToSegments(path);
    if (operation === "patch") {
      if (segments.length !== 0)
        throw new UpstreamDriftError(
          "Nested ChatGPT patch target is unsupported",
        );
      if (!Array.isArray(value))
        throw new UpstreamDriftError(
          "ChatGPT patch requires an operation array",
        );
      for (const entry of value) {
        if (
          entry === null ||
          typeof entry !== "object" ||
          Array.isArray(entry)
        ) {
          throw new UpstreamDriftError("Malformed ChatGPT patch entry");
        }
        const delta = entry as JsonRecord;
        if (typeof delta.p !== "string" || !Object.hasOwn(delta, "v")) {
          throw new UpstreamDriftError("Malformed ChatGPT patch entry");
        }
        this.applyAtPath(delta.p, requireOperation(delta.o), delta.v);
      }
      return;
    }
    if (segments.length === 0) {
      this.document =
        operation === "append"
          ? appendValue(this.document, value)
          : structuredClone(value);
      return;
    }
    const parent = this.valueAt(segments.slice(0, -1));
    const key = segments[segments.length - 1];
    if (Array.isArray(parent)) {
      const index = parseArrayIndex(key, parent.length, operation === "add");
      if (operation === "add") parent.splice(index, 0, structuredClone(value));
      else
        parent[index] =
          operation === "append"
            ? appendValue(parent[index], value)
            : structuredClone(value);
    } else if (parent !== null && typeof parent === "object") {
      if (operation !== "add" && !Object.hasOwn(parent, key)) {
        throw new UpstreamDriftError("ChatGPT delta target does not exist");
      }
      const target = parent as JsonRecord;
      target[key] =
        operation === "append"
          ? appendValue(target[key], value)
          : structuredClone(value);
    } else {
      throw new UpstreamDriftError("ChatGPT delta target is not mutable");
    }
  }

  private valueAt(segments: string[]): unknown {
    let value = this.document;
    for (const segment of segments) {
      if (Array.isArray(value))
        value = value[parseArrayIndex(segment, value.length, false)];
      else if (
        value !== null &&
        typeof value === "object" &&
        Object.hasOwn(value, segment)
      ) {
        const record = value as JsonRecord;
        value = record[segment];
      } else throw new UpstreamDriftError("ChatGPT delta path does not exist");
    }
    return value;
  }
}
