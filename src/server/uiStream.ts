import { once } from "node:events";
import type { ServerResponse } from "node:http";
import {
  APICallError,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type FinishReason,
  type UIMessageStreamWriter,
} from "ai";
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  CitationSource,
} from "../shared/types.ts";
import { WebProviderError } from "../shared/errors.ts";

export function publicChatError(
  error: unknown,
  signal?: AbortSignal,
): { status: number; code: string; message: string } {
  const cause = signal?.aborted ? signal.reason : error;
  const code =
    cause instanceof WebProviderError
      ? cause.code
      : APICallError.isInstance(cause) && cause.statusCode === 401
        ? "CREDENTIAL_FAILURE"
        : APICallError.isInstance(cause) && cause.statusCode === 403
          ? "CHALLENGE_REQUIRED"
          : APICallError.isInstance(cause) && cause.statusCode === 429
            ? "RATE_LIMIT_EXCEEDED"
            : cause instanceof Error && cause.name === "AbortError"
              ? "ABORTED"
              : "GENERIC_UPSTREAM_FAILURE";
  switch (code) {
    case "INVALID_REQUEST":
      return {
        status: 400,
        code,
        message: "Invalid model, provider, or chat request.",
      };
    case "CREDENTIAL_FAILURE":
      return {
        status: 401,
        code,
        message:
          "Provider credentials are missing or expired. Sign in and refresh the browser session.",
      };
    case "CHALLENGE_REQUIRED":
      return {
        status: 403,
        code,
        message:
          "Provider browser verification is required. Complete it in the signed-in browser.",
      };
    case "RATE_LIMIT_EXCEEDED":
      return {
        status: 429,
        code,
        message: "The provider rate limit or quota was reached.",
      };
    case "TIMEOUT":
      return {
        status: 504,
        code,
        message: "The provider request timed out. Please try again.",
      };
    case "UPSTREAM_DRIFT":
      return {
        status: 502,
        code,
        message:
          "The provider response format changed. The browser bridge needs updating.",
      };
    case "ABORTED":
      return { status: 499, code, message: "The request was cancelled." };
    default:
      return {
        status:
          cause instanceof WebProviderError && cause.httpStatus === 503
            ? 503
            : 502,
        code,
        message:
          cause instanceof WebProviderError && cause.httpStatus === 503
            ? "Provider browser session unavailable. Close the dedicated session-preparation window and check browser/profile configuration."
            : "The provider request failed. Check the browser bridge and try again.",
      };
  }
}

/** Diagnostic fields are enum-checked, never copied from raw browser exceptions. */
export function logChatError(error: unknown, signal?: AbortSignal): void {
  const cause = signal?.aborted ? signal.reason : error;
  const details = cause instanceof WebProviderError ? cause.details : undefined;
  const diagnostics: Record<string, string | number> = {};
  const category = details?.category;
  if (category === "module-discovery" || category === "bridge-load")
    diagnostics.category = category;
  const reason = details?.reason;
  if (
    reason === "csp" ||
    reason === "asset-status" ||
    reason === "requestfailed" ||
    reason === "evaluation" ||
    reason === "timeout"
  )
    diagnostics.reason = reason;
  const directive = details?.directive;
  if (
    typeof directive === "string" &&
    [
      "default-src",
      "script-src",
      "script-src-elem",
      "script-src-attr",
      "connect-src",
      "worker-src",
      "child-src",
      "frame-src",
      "style-src",
      "style-src-elem",
      "style-src-attr",
      "img-src",
      "font-src",
      "media-src",
      "object-src",
      "base-uri",
      "form-action",
      "frame-ancestors",
      "trusted-types",
      "require-trusted-types-for",
    ].includes(directive)
  ) {
    diagnostics.directive = directive;
  }
  const status = details?.status;
  if (
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
  )
    diagnostics.status = status;
  console.error(
    "Chat request failed:",
    publicChatError(error, signal).code,
    diagnostics,
  );
}

export function awaitWithAbort<T>(
  promise: PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function finishReason(
  reason: ChatCompletionChunk["choices"][number]["finish_reason"],
): FinishReason {
  return reason === "tool_calls"
    ? "tool-calls"
    : reason === "content_filter"
      ? "content-filter"
      : (reason ?? "stop");
}

interface PendingTool {
  id?: string;
  name: string;
  arguments: string;
  started: boolean;
}

/** Translate OpenAI completion data into the installed AI SDK's UI SSE protocol. */
export function createProviderUIMessageStream(
  result: ChatCompletionResponse | AsyncIterable<ChatCompletionChunk>,
  signal?: AbortSignal,
) {
  return createUIMessageStream({
    onError: (error) => publicChatError(error, signal).message,
    execute: async ({ writer }) => {
      let textStarted = false;
      let reasoningStarted = false;
      let reason: FinishReason = "stop";
      let receivedFinish = false;
      let usage: ChatCompletionResponse["usage"];
      const tools = new Map<number, PendingTool>();
      const emittedSources = new Set<string>();
      const writeCitations = (citations?: CitationSource[]) => {
        if (!citations || citations.length === 0) return;
        for (const citation of citations) {
          if (!citation.url || emittedSources.has(citation.id)) continue;
          emittedSources.add(citation.id);
          writer.write({
            type: "source-url",
            sourceId: citation.id,
            url: citation.url,
            title: citation.title,
            providerMetadata: {
              gemini: {
                citationNumber: citation.citationNumber,
                startIndex: citation.startIndex,
                endIndex: citation.endIndex,
                snippet: citation.snippet,
                favicon: citation.favicon,
              },
            },
          });
        }
      };
      let iterator: AsyncIterator<ChatCompletionChunk> | undefined;
      let exhausted = false;
      const writeContent = (
        type: "text" | "reasoning",
        delta: string | null | undefined,
      ) => {
        if (!delta) return;
        if (type === "text" ? !textStarted : !reasoningStarted) {
          writer.write({
            type: type === "text" ? "text-start" : "reasoning-start",
            id: type,
          });
          if (type === "text") textStarted = true;
          else reasoningStarted = true;
        }
        writer.write({
          type: type === "text" ? "text-delta" : "reasoning-delta",
          id: type,
          delta,
        });
      };
      const closeContent = () => {
        if (textStarted) {
          writer.write({ type: "text-end", id: "text" });
          textStarted = false;
        }
        if (reasoningStarted) {
          writer.write({ type: "reasoning-end", id: "reasoning" });
          reasoningStarted = false;
        }
      };
      writer.write({ type: "start" });
      writer.write({ type: "start-step" });
      try {
        signal?.throwIfAborted();
        if (Symbol.asyncIterator in result) {
          iterator = result[Symbol.asyncIterator]();
          while (true) {
            const next = await awaitWithAbort(iterator.next(), signal);
            if (next.done) {
              exhausted = true;
              break;
            }
            const chunk = next.value;
            if (chunk.usage) usage = chunk.usage;
            // A UI message is one assistant candidate, never concatenate alternatives.
            const choice = chunk.choices.find(
              (candidate) => candidate.index === 0,
            );
            if (!choice) continue;
            writeContent("reasoning", choice.delta.reasoning_content);
            writeContent("text", choice.delta.content);
            writeCitations(choice.delta.citations);
            for (const delta of choice.delta.tool_calls ?? []) {
              const tool = tools.get(delta.index) ?? {
                name: "",
                arguments: "",
                started: false,
              };
              if (delta.id) tool.id = delta.id;
              if (delta.function?.name) tool.name += delta.function.name;
              const argumentsDelta = delta.function?.arguments ?? "";
              tool.arguments += argumentsDelta;
              if (!tool.started && tool.id && tool.name) {
                writer.write({
                  type: "tool-input-start",
                  toolCallId: tool.id,
                  toolName: tool.name,
                  dynamic: true,
                });
                tool.started = true;
                if (tool.arguments)
                  writer.write({
                    type: "tool-input-delta",
                    toolCallId: tool.id,
                    inputTextDelta: tool.arguments,
                  });
              } else if (tool.started && argumentsDelta) {
                writer.write({
                  type: "tool-input-delta",
                  toolCallId: tool.id!,
                  inputTextDelta: argumentsDelta,
                });
              }
              tools.set(delta.index, tool);
            }
            if (choice.finish_reason) {
              reason = finishReason(choice.finish_reason);
              receivedFinish = true;
            }
          }
          if (!receivedFinish)
            throw new Error("Provider stream ended before completion");
        } else {
          const choice = result.choices.find(
            (candidate) => candidate.index === 0,
          );
          if (!choice) throw new Error("Missing assistant choice");
          writeContent("reasoning", choice.message.reasoning_content);
          writeContent("text", choice.message.content);
          writeCitations(choice.message.citations);
          for (const [index, tool] of (
            choice.message.tool_calls ?? []
          ).entries()) {
            tools.set(index, {
              id: tool.id,
              name: tool.function.name,
              arguments: tool.function.arguments,
              started: false,
            });
          }
          reason = finishReason(choice.finish_reason);
          usage = result.usage;
        }
        closeContent();
        for (const tool of tools.values()) writeToolInput(writer, tool);
        writer.write({ type: "finish-step" });
        writer.write({
          type: "finish",
          finishReason: reason,
          ...(usage ? { messageMetadata: { usage } } : {}),
        });
        writer.setOutcome({ status: "completed" });
      } catch (error) {
        closeContent();
        const safe = publicChatError(error, signal);
        logChatError(error, signal);
        if (safe.code === "ABORTED")
          writer.write({ type: "abort", reason: safe.message });
        else writer.write({ type: "error", errorText: safe.message });
        writer.write({ type: "finish-step" });
        writer.write({ type: "finish", finishReason: "error" });
        writer.setOutcome(
          safe.code === "ABORTED"
            ? { status: "aborted" }
            : { status: "failed", error: new Error(safe.message) },
        );
      } finally {
        if (iterator && !exhausted) void iterator.return?.().catch(() => {});
      }
    },
  });
}

function writeToolInput(writer: UIMessageStreamWriter, tool: PendingTool) {
  if (!tool.id || !tool.name) throw new Error("Incomplete provider tool call");
  let input: unknown;
  try {
    input = JSON.parse(tool.arguments);
  } catch {
    writer.write({
      type: "tool-input-error",
      toolCallId: tool.id,
      toolName: tool.name,
      input: tool.arguments,
      dynamic: true,
      errorText: "The provider returned invalid tool arguments.",
    });
    return;
  }
  writer.write({
    type: "tool-input-available",
    toolCallId: tool.id,
    toolName: tool.name,
    input,
    dynamic: true,
  });
}

export function createProviderUIMessageStreamResponse(
  result: ChatCompletionResponse | AsyncIterable<ChatCompletionChunk>,
  signal?: AbortSignal,
): Response {
  return createUIMessageStreamResponse({
    stream: createProviderUIMessageStream(result, signal),
  });
}

/** Respect backpressure and cancel the SDK reader when the HTTP client leaves. */
export async function writeUIResponse(
  res: ServerResponse,
  response: Response,
  signal: AbortSignal,
): Promise<void> {
  if (!response.body) throw new Error("Missing UI response body");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (res.destroyed) return;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.writeHead(response.status);
    while (!res.destroyed) {
      const { done, value } = await awaitWithAbort(reader.read(), signal);
      if (done) break;
      if (value && !res.write(value)) await once(res, "drain", { signal });
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}
