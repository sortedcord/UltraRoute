import type { Page } from "playwright";
import { setTimeout as delay } from "node:timers/promises";
import { CHATGPT_WEB_CONSTANTS } from "./constants.ts";
import { ChatGptDeltaV1Decoder } from "./deltaV1.ts";
import {
  ProviderTimeoutError,
  UpstreamDriftError,
} from "../../shared/errors.ts";

type CaptureError = "size" | "encoding" | "clone" | "body" | "stream-read";
type CaptureFailureName =
  "TypeError" | "AbortError" | "InvalidStateError" | "Other";
type CaptureResult =
  | { text: string }
  | {
      error: CaptureError;
      failureName?: CaptureFailureName;
      partialText?: string;
    };
interface CaptureState {
  reset(): void;
  cancel(): void;
  result?: CaptureResult;
}
type CaptureWindow = Window & {
  __ultraChatGptStreamCapture?: CaptureState;
};

// This function is serialized into the page. Keep all runtime dependencies in
// its argument or its closure, and never inspect request headers or bodies.
function installInPage(config: {
  origin: string;
  path: string;
  maxBytes: number;
}): void {
  const scope = window as CaptureWindow;
  if (scope.__ultraChatGptStreamCapture) return;
  type Turn = {
    started: boolean;
    cancelled: boolean;
    reader?: ReadableStreamDefaultReader<Uint8Array>;
  };
  let turn: Turn | undefined;
  const cancel = () => {
    if (!turn) return;
    turn.cancelled = true;
    // Cancelling one tee branch can wait for the original branch to finish.
    // Never await it or let a cancellation rejection escape into the frontend.
    void turn.reader?.cancel().catch(() => {});
  };
  const state: CaptureState = {
    reset() {
      cancel();
      state.result = undefined;
      turn = { started: false, cancelled: false };
    },
    cancel,
  };
  Object.defineProperty(scope, "__ultraChatGptStreamCapture", { value: state });
  const nativeFetch = scope.fetch;
  scope.fetch = function (...args: Parameters<typeof fetch>) {
    const ownedTurn = turn;
    let matches = false;
    try {
      const [input, init] = args;
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        location.href,
      );
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      matches =
        url.origin === config.origin &&
        url.pathname === config.path &&
        method.toUpperCase() === "POST";
    } catch {
      // Metadata that cannot be classified is not observed. Native fetch retains
      // responsibility for validating the original, unchanged arguments.
    }
    return nativeFetch.apply(this, args).then((response) => {
      if (
        !matches ||
        !ownedTurn ||
        ownedTurn !== turn ||
        ownedTurn.cancelled ||
        ownedTurn.started
      )
        return response;
      let responseUrl: URL;
      try {
        responseUrl = new URL(response.url);
      } catch {
        return response;
      }
      if (
        !response.ok ||
        responseUrl.origin !== config.origin ||
        responseUrl.pathname !== config.path ||
        !/^(?:text\/event-stream|application\/json)(?:;|$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      )
        return response;
      ownedTurn.started = true;
      const finish = (result: CaptureResult) => {
        if (ownedTurn === turn && !ownedTurn.cancelled) state.result = result;
      };
      const fail = (error: CaptureError, cause?: unknown) => {
        let failureName: CaptureFailureName | undefined;
        if (cause !== undefined) {
          const name =
            cause instanceof Error || cause instanceof DOMException
              ? cause.name
              : "Other";
          failureName =
            name === "TypeError" ||
            name === "AbortError" ||
            name === "InvalidStateError"
              ? name
              : "Other";
        }
        finish({ error, failureName });
        void ownedTurn.reader?.cancel().catch(() => {});
      };
      let stage: CaptureError = "clone";
      try {
        const declared = Number(response.headers.get("content-length") ?? 0);
        if (declared > config.maxBytes) {
          fail("size");
          return response;
        }
        const clone = response.clone();
        if (!clone.body) {
          fail("body");
          return response;
        }
        stage = "body";
        const reader = clone.body.getReader();
        ownedTurn.reader = reader;
        // Start consuming the observer branch without delaying native fetch.
        void (async () => {
          const decoder = new TextDecoder("utf-8", { fatal: true });
          const parts: string[] = [];
          let pending = "";
          let bytes = 0;
          try {
            while (!ownedTurn.cancelled) {
              const { value, done } = await reader.read();
              if (ownedTurn.cancelled) return;
              if (done) {
                try {
                  pending += decoder.decode();
                } catch {
                  fail("encoding");
                  return;
                }
                parts.push(pending);
                finish({ text: parts.join("") });
                return;
              }
              bytes += value.byteLength;
              if (bytes > config.maxBytes) {
                fail("size");
                return;
              }
              try {
                pending += decoder.decode(value, { stream: true });
                if (pending.length >= 32 * 1024) {
                  parts.push(pending);
                  pending = "";
                }
              } catch {
                fail("encoding");
                return;
              }
            }
          } catch (error) {
            if (
              (error instanceof Error || error instanceof DOMException) &&
              error.name === "AbortError"
            ) {
              try {
                pending += decoder.decode();
              } catch {
                fail("encoding");
                return;
              }
              parts.push(pending);
              finish({
                error: "stream-read",
                failureName: "AbortError",
                partialText: parts.join(""),
              });
              return;
            }
            fail("stream-read", error);
          } finally {
            reader.releaseLock();
          }
        })();
      } catch (error) {
        fail(stage, error);
      }
      return response;
    });
  };
}

/** Install before navigation so first-party scripts cannot cache unobserved fetch. */
export async function installChatGptStreamCapture(page: Page): Promise<void> {
  const config = {
    origin: CHATGPT_WEB_CONSTANTS.BASE_URL,
    path: `/backend-api${CHATGPT_WEB_CONSTANTS.DIRECT_SSE_PATH}`,
    maxBytes: CHATGPT_WEB_CONSTANTS.MAX_RESPONSE_BYTES,
  };
  await page.addInitScript(installInPage, config);
  // Also support already-loaded local composer fixtures. Installation is idempotent.
  await page.evaluate(installInPage, config);
}

/** Arm only the owned submission, discarding any preceding turn's observation. */
export async function resetChatGptStreamCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = (window as CaptureWindow).__ultraChatGptStreamCapture;
    if (!state) throw new Error("Stream capture is not installed");
    state.reset();
  });
}

/** The composer owns the deadline; polling never reads browser-network buffers. */
export async function readChatGptStreamCapture(
  page: Page,
  signal?: AbortSignal | null,
): Promise<string> {
  try {
    for (;;) {
      if (signal?.aborted)
        throw new ProviderTimeoutError("ChatGPT browser turn cancelled");
      const result = await page.evaluate(
        () => (window as CaptureWindow).__ultraChatGptStreamCapture?.result,
      );
      if (result) {
        if ("text" in result) return result.text;
        if (
          result.error === "stream-read" &&
          result.failureName === "AbortError" &&
          result.partialText !== undefined
        ) {
          try {
            const decoder = new ChatGptDeltaV1Decoder();
            decoder.ingest(result.partialText);
            if (decoder.isTurnFinished()) return result.partialText;
          } catch {
            // Partial protocol data is not completion evidence. Preserve the
            // sanitized stream-read failure rather than exposing parser data.
          }
        }
        const message =
          result.error === "size"
            ? "ChatGPT conversation response exceeded the size limit"
            : result.error === "encoding"
              ? "ChatGPT conversation response contained invalid UTF-8"
              : "ChatGPT conversation response stream failed";
        throw new UpstreamDriftError(message, {
          category: "composer-response",
          reason: result.error,
          ...(result.failureName ? { failureName: result.failureName } : {}),
        });
      }
      await delay(CHATGPT_WEB_CONSTANTS.POLL_INTERVAL_MS, undefined, {
        signal: signal ?? undefined,
      });
    }
  } catch (error) {
    if (signal?.aborted) {
      await page
        .evaluate(() =>
          (window as CaptureWindow).__ultraChatGptStreamCapture?.cancel(),
        )
        .catch(() => {});
      throw new ProviderTimeoutError("ChatGPT browser turn cancelled");
    }
    if (error instanceof UpstreamDriftError) throw error;
    throw new UpstreamDriftError(
      "ChatGPT conversation response stream failed",
      {
        category: "composer-response",
        reason: "capture-read",
      },
    );
  }
}
