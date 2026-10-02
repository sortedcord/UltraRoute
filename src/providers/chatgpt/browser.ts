import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { existsSync } from "node:fs";
import { CHATGPT_WEB_CONSTANTS } from "./constants.ts";
import {
  validateAndNormalizeStorageState,
  type ChatGptStorageState,
} from "./storageState.ts";
import {
  executeChatGptWebFirstPartyTurn,
  type ChatGptWebFirstPartyRequest,
} from "./firstParty.ts";
import { executeChatGptComposerTurn } from "./composer.ts";
import { installChatGptStreamCapture } from "./streamCapture.ts";
import {
  ChatGptTopicStream,
  type HandoffBootstrap,
  type IChatGptTransportSession,
} from "./transport.ts";
import {
  CredentialError,
  ChallengeRequiredError,
  GenericUpstreamError,
  ProviderTimeoutError,
  RateLimitError,
  UpstreamDriftError,
  WebProviderError,
} from "../../shared/errors.ts";
import {
  acquireChatGptProfile,
  isChatGptProfileCredential,
  type ChatGptProfileCredential,
  type ChatGptProfileLease,
} from "./profile.ts";

export interface BrowserSessionDeps {
  launch?: typeof chromium.launch;
  execute?: typeof executeChatGptWebFirstPartyTurn;
  launchPersistent?: typeof chromium.launchPersistentContext;
}

/** Each request owns a fresh context. Cookies are never copied to other origins or accounts. */
export async function createChatGptBrowserSession(
  state: ChatGptStorageState | ChatGptProfileCredential,
  deps: BrowserSessionDeps = {},
): Promise<IChatGptTransportSession> {
  const profile = isChatGptProfileCredential(state) ? state : undefined;
  const normalized = profile
    ? undefined
    : validateAndNormalizeStorageState(state);
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let profileLease: ChatGptProfileLease | undefined;
  try {
    const executablePath =
      process.env.CHATGPT_CHROMIUM_PATH ||
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    if (profile) {
      profileLease = await acquireChatGptProfile(
        profile.browserProfile,
        false,
        { launch: deps.launchPersistent },
      );
      context = profileLease.context;
    } else {
      browser = await (deps.launch ?? chromium.launch.bind(chromium))({
        executablePath,
        headless:
          process.env.CHATGPT_WEB_HEADLESS === "1" || !process.env.DISPLAY,
        timeout: CHATGPT_WEB_CONSTANTS.BROWSER_ACQUIRE_TIMEOUT_MS,
      });
      context = await browser.newContext({ storageState: normalized });
    }
    const page = await context.newPage();
    if (profile) {
      // Keep the new execution tab alive before closing restored tabs: ordinary
      // headed Chromium exits when its last window is closed.
      for (const stalePage of context.pages())
        if (stalePage !== page) await stalePage.close();
    }
    return new BrowserSession(
      async () => {
        if (profileLease) await profileLease.close();
        else {
          await context?.close().catch(() => {});
          await browser?.close().catch(() => {});
        }
      },
      context,
      page,
      deps.execute ??
        (process.env.CHATGPT_WEB_EXECUTION === "module"
          ? executeChatGptWebFirstPartyTurn
          : executeChatGptComposerTurn),
    );
  } catch (error) {
    await profileLease?.close().catch(() => {});
    if (!profileLease) await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (error instanceof WebProviderError) throw error;
    throw new GenericUpstreamError(
      "ChatGPT browser could not start. Check Chromium path and display configuration.",
      503,
      false,
    );
  }
}

class BrowserSession implements IChatGptTransportSession {
  private frames: string[] = [];
  private bytes = 0;
  private frameError: WebProviderError | undefined;
  private used = false;
  private dispose: () => Promise<void>;
  private context: BrowserContext;
  private page: Page;
  private execute: typeof executeChatGptWebFirstPartyTurn;
  constructor(
    dispose: () => Promise<void>,
    context: BrowserContext,
    page: Page,
    execute: typeof executeChatGptWebFirstPartyTurn,
  ) {
    this.dispose = dispose;
    this.context = context;
    this.page = page;
    this.execute = execute;
  }

  async close(): Promise<void> {
    await this.dispose();
  }

  private async bounded<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted)
      throw new ProviderTimeoutError("ChatGPT browser turn cancelled");
    let timer: NodeJS.Timeout | undefined;
    let abort: () => void = () => {};
    const deadline = new Promise<never>((_, reject) => {
      abort = () => {
        void this.close();
        reject(new ProviderTimeoutError("ChatGPT browser turn cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        void this.close();
        reject(new ProviderTimeoutError("ChatGPT browser turn timed out"));
      }, CHATGPT_WEB_CONSTANTS.DEFAULT_TURN_TIMEOUT_MS);
    });
    try {
      return await Promise.race([operation(), deadline]);
    } catch (error) {
      throw browserError(error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async executeDirectTurn(
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.used)
      throw new UpstreamDriftError("ChatGPT browser session already consumed");
    this.used = true;
    return this.bounded(async () => {
      await installChatGptStreamCapture(this.page);
      // Observe the first-party socket. Do not recreate socket authentication or conduit tokens.
      await this.page.addInitScript(() => {
        const NativeSocket = window.WebSocket;
        const sockets: WebSocket[] = [];
        (window as any).__ultraSockets = sockets;
        window.WebSocket = class extends NativeSocket {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            const parsed = new URL(String(url));
            if (
              parsed.protocol === "wss:" &&
              (parsed.hostname === "chatgpt.com" ||
                parsed.hostname.endsWith(".chatgpt.com"))
            )
              sockets.push(this);
          }
        };
      });
      this.page.on("websocket", (socket) => {
        const url = new URL(socket.url());
        if (
          url.protocol !== "wss:" ||
          !(
            url.hostname === "chatgpt.com" ||
            url.hostname.endsWith(".chatgpt.com")
          )
        )
          return;
        socket.on("framereceived", (frame) => {
          const text =
            typeof frame.payload === "string"
              ? frame.payload
              : frame.payload.toString("utf8");
          this.bytes += Buffer.byteLength(text);
          if (
            this.frames.length >= CHATGPT_WEB_CONSTANTS.MAX_SOCKET_FRAMES ||
            this.bytes > CHATGPT_WEB_CONSTANTS.MAX_RESPONSE_BYTES
          ) {
            this.frameError = new UpstreamDriftError(
              "ChatGPT WebSocket buffer bound exceeded",
            );
            return;
          }
          this.frames.push(text);
        });
      });
      const response = await this.page.goto(
        CHATGPT_WEB_CONSTANTS.TEMPORARY_CHAT_URL,
        {
          waitUntil: "domcontentloaded",
          timeout: CHATGPT_WEB_CONSTANTS.BROWSER_ACQUIRE_TIMEOUT_MS,
        },
      );
      if (response?.status() === 401)
        throw new CredentialError(
          "ChatGPT session expired; refresh the configured browser session",
        );
      if (response?.status() === 403)
        throw new ChallengeRequiredError(
          "ChatGPT security verification required in the operator browser",
        );
      if (new URL(this.page.url()).origin !== CHATGPT_WEB_CONSTANTS.BASE_URL)
        throw new CredentialError(
          "ChatGPT session requires login in the operator browser",
        );
      await this.page.waitForFunction(
        (selector) =>
          document.querySelector(selector) ||
          /just a moment|verify you are human/i.test(document.title),
        CHATGPT_WEB_CONSTANTS.COMPOSER_SELECTOR,
        { timeout: CHATGPT_WEB_CONSTANTS.BROWSER_ACQUIRE_TIMEOUT_MS },
      );
      if (
        await this.page.evaluate(() =>
          /just a moment|verify you are human/i.test(document.title),
        )
      )
        throw new ChallengeRequiredError(
          "ChatGPT security verification required in the operator browser",
        );
      // SSR exposes the composer/model button before React attaches their actions.
      // The observed first-party page finishes initialization at network idle.
      await this.page.waitForLoadState("networkidle", {
        timeout: CHATGPT_WEB_CONSTANTS.BROWSER_ACQUIRE_TIMEOUT_MS,
      });
      return this.execute(this.page, payload as ChatGptWebFirstPartyRequest, {
        signal,
      });
    }, signal);
  }

  async executeWebSocketTurn(
    bootstrap: HandoffBootstrap,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.bounded(async () => {
      const subscribed = await this.page.evaluate((topic) => {
        const sockets = (window as any).__ultraSockets as
          WebSocket[] | undefined;
        const socket = sockets?.find((s) => s.readyState === WebSocket.OPEN);
        if (!socket) return false;
        socket.send(
          JSON.stringify([
            { id: 1, command: { type: "subscribe", topic_id: topic } },
          ]),
        );
        return true;
      }, bootstrap.websocketTopicId);
      if (!subscribed)
        throw new UpstreamDriftError(
          "ChatGPT handoff socket unavailable; first-party socket contract changed",
        );
      const topic = new ChatGptTopicStream(bootstrap.websocketTopicId);
      const items: string[] = [];
      let index = 0;
      for (;;) {
        if (this.frameError) throw this.frameError;
        if (signal?.aborted)
          throw new ProviderTimeoutError("ChatGPT browser turn cancelled");
        while (index < this.frames.length) {
          const result = topic.ingestFrame(this.frames[index++]);
          items.push(...result.encodedItems);
          if (result.done) return items.join("") + "\ndata: [DONE]\n\n";
        }
        await new Promise((resolve) =>
          setTimeout(resolve, CHATGPT_WEB_CONSTANTS.POLL_INTERVAL_MS),
        );
      }
    }, signal);
  }
}

function browserError(error: unknown): WebProviderError {
  if (error instanceof WebProviderError) return error;
  // Only classify known bridge status signals; never expose the original page exception.
  const message = error instanceof Error ? error.message : "";
  if (/status 401\b/.test(message))
    return new CredentialError("ChatGPT session expired; refresh credentials");
  if (/status 403\b/.test(message))
    return new ChallengeRequiredError(
      "ChatGPT security verification required in the operator browser",
    );
  if (/status 429\b/.test(message))
    return new RateLimitError("ChatGPT account quota or rate limit reached");
  if (/timed out|timeout/i.test(message))
    return new ProviderTimeoutError("ChatGPT browser turn timed out");
  if (/bridge|module|contract|asset/i.test(message))
    return new UpstreamDriftError(
      "ChatGPT first-party bridge failed; check frontend module/CSP diagnostics",
    );
  return new GenericUpstreamError("ChatGPT browser request failed");
}
