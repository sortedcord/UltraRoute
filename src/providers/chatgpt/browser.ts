import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { CHATGPT_WEB_CONSTANTS } from "./constants.ts";
import {
  validateAndNormalizeStorageState,
  type ChatGptStorageState,
} from "./storageState.ts";
import {
  executeChatGptWebFirstPartyTurn,
  initializeChatGptWebFirstPartyBridge,
  getChatGptWebAccountIdentity,
  fetchChatGptWebModels,
  type ChatGptWebFirstPartyRequest,
} from "./firstParty.ts";
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
  UpstreamDriftError,
  WebProviderError,
} from "../../shared/errors.ts";
import {
  acquireChatGptProfile,
  isChatGptProfileCredential,
  type ChatGptProfileCredential,
} from "./profile.ts";

type Credential = ChatGptStorageState | ChatGptProfileCredential;
interface CatalogLease extends IChatGptTransportSession {
  getAccountIdentity(signal?: AbortSignal): Promise<string>;
  fetchModels(
    signal?: AbortSignal,
    expectedIdentity?: string,
  ): Promise<unknown>;
}
export interface BrowserSessionDeps {
  launch?: typeof chromium.launch;
  launchPersistent?: typeof chromium.launchPersistentContext;
  initialize?: typeof initializeChatGptWebFirstPartyBridge;
  execute?: typeof executeChatGptWebFirstPartyTurn;
  getIdentity?: typeof getChatGptWebAccountIdentity;
  fetchModels?: typeof fetchChatGptWebModels;
  idleTimeoutMs?: number;
}
interface Runtime {
  context: BrowserContext;
  page: Page;
  ready: boolean;
  dispose(): Promise<void>;
  frames: string[];
  bytes: number;
  frameError?: WebProviderError;
  observing: boolean;
  wake?: () => void;
  resetting?: Promise<void>;
}
interface Entry {
  key: string;
  tail: Promise<void>;
  runtime?: Runtime;
  idle?: NodeJS.Timeout;
  closed: boolean;
  opening?: Promise<Runtime>;
  release?: () => Promise<void>;
  leases: number;
  retiring?: Promise<void>;
}

function credentialKey(state: Credential): string {
  if (isChatGptProfileCredential(state))
    return `profile:${state.browserProfile}`;
  // Session identity must not change when clearance/analytics cookies rotate.
  const auth = state.cookies.filter((cookie) =>
    /(?:session-token|sessiontoken)/i.test(cookie.name),
  );
  const cookies = (auth.length ? auth : state.cookies)
    .map((cookie) => [cookie.domain, cookie.path, cookie.name, cookie.value])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256")
    .update(JSON.stringify({ cookies, origins: state.origins }))
    .digest("hex");
}
function cancelled(): ProviderTimeoutError {
  return new ProviderTimeoutError("ChatGPT turn cancelled or timed out");
}
async function withAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw cancelled();
  if (!signal) return operation;
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(cancelled());
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, stopped]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Owns warm account-isolated Chromium pages. A session is an exclusive turn lease. */
export class WarmChatGptBrowserManager {
  private readonly entries = new Map<string, Entry>();
  private readonly shutdown = new AbortController();
  private closing?: Promise<void>;
  private readonly deps: BrowserSessionDeps;
  private readonly idleTimeoutMs: number;
  constructor(deps: BrowserSessionDeps = {}) {
    this.deps = deps;
    const timeout =
      deps.idleTimeoutMs ??
      Number(process.env.CHATGPT_BROWSER_IDLE_TIMEOUT_MS ?? 300_000);
    if (!Number.isFinite(timeout) || timeout < 0)
      throw new Error("Invalid ChatGPT browser idle timeout");
    this.idleTimeoutMs = timeout;
  }

  async getAccountIdentity(
    state: Credential,
    signal?: AbortSignal,
  ): Promise<string> {
    const session = await this.createSession(state, signal);
    try {
      return await session.getAccountIdentity(signal);
    } finally {
      await session.close?.();
    }
  }

  async fetchModels(
    state: Credential,
    signal?: AbortSignal,
    expectedIdentity?: string,
  ): Promise<unknown> {
    const session = await this.createSession(state, signal);
    try {
      return await session.fetchModels(signal, expectedIdentity);
    } finally {
      await session.close?.();
    }
  }

  async createSession(
    state: Credential,
    signal?: AbortSignal,
  ): Promise<CatalogLease> {
    const combined = AbortSignal.any([
      this.shutdown.signal,
      ...(signal ? [signal] : []),
    ]);
    if (combined.aborted) throw cancelled();
    const normalized = isChatGptProfileCredential(state)
      ? state
      : validateAndNormalizeStorageState(state);
    const key = credentialKey(normalized);
    let entry = this.entries.get(key);
    if (entry?.closed) {
      await withAbort(entry.retiring ?? Promise.resolve(), combined);
      return this.createSession(normalized, signal);
    }
    if (!entry) {
      entry = { key, tail: Promise.resolve(), closed: false, leases: 0 };
      this.entries.set(key, entry);
    }
    clearTimeout(entry.idle);
    entry.leases++;
    const previous = entry.tail;
    const gate = Promise.withResolvers<void>();
    entry.tail = previous.catch(() => {}).then(() => gate.promise);
    try {
      await withAbort(previous, combined);
      if (entry.closed || combined.aborted) throw cancelled();
      clearTimeout(entry.idle);
    } catch (error) {
      // Never unlock a later request before its predecessor has released.
      void previous
        .finally(() => {
          gate.resolve();
          entry.leases--;
          this.scheduleIdle(entry);
        })
        .catch(() => {});
      throw error;
    }
    const owned = entry;
    let released = false;
    let used = false;
    let invalid = false;
    let recovering: Promise<void> | undefined;
    let active: Promise<unknown> | undefined;
    let releasing: Promise<void> | undefined;
    const release = (): Promise<void> => {
      releasing ??= (async () => {
        released = true;
        try {
          await active?.catch(() => {});
          await owned.opening?.catch(() => {});
          await recovering;
          const runtime = owned.runtime;
          if (runtime) {
            runtime.observing = false;
            runtime.frames = [];
            runtime.bytes = 0;
            if (invalid && !recovering && !owned.closed)
              await this.resetPage(runtime);
          }
        } finally {
          owned.release = undefined;
          owned.leases--;
          gate.resolve();
          this.scheduleIdle(owned);
        }
      })();
      return releasing;
    };
    owned.release = release;
    const run = <T>(
      operation: (runtime: Runtime, turnSignal: AbortSignal) => Promise<T>,
      turnSignal?: AbortSignal,
    ): Promise<T> => {
      const combinedTurn = AbortSignal.any([
        combined,
        ...(turnSignal ? [turnSignal] : []),
        AbortSignal.timeout(CHATGPT_WEB_CONSTANTS.DEFAULT_TURN_TIMEOUT_MS),
      ]);
      const work = (async () => {
        if (released || combinedTurn.aborted) throw cancelled();
        let abort: () => void = () => {};
        try {
          const initializing = (owned.opening ??= this.ensureRuntime(
            owned,
            normalized,
          ).finally(() => {
            owned.opening = undefined;
          }));
          const runtime = await withAbort(initializing, combinedTurn);
          owned.opening = undefined;
          abort = () => {
            invalid = true;
            // Interrupt all page-local native requests; retain the browser context.
            recovering ??= this.resetPage(runtime).catch(() => {});
            runtime.wake?.();
          };
          combinedTurn.addEventListener("abort", abort, { once: true });
          if (combinedTurn.aborted) {
            abort();
            throw cancelled();
          }
          await withAbort(this.ensureReady(runtime), combinedTurn);
          return await withAbort(
            operation(runtime, combinedTurn),
            combinedTurn,
          );
        } catch (error) {
          invalid = true;
          if (combinedTurn.aborted) throw cancelled();
          throw browserError(error);
        } finally {
          combinedTurn.removeEventListener("abort", abort);
        }
      })();
      active = work;
      return work;
    };
    return {
      getAccountIdentity: (turnSignal) =>
        run(
          (runtime, scopedSignal) =>
            (this.deps.getIdentity ?? getChatGptWebAccountIdentity)(
              runtime.page,
              scopedSignal,
            ),
          turnSignal,
        ),
      fetchModels: (turnSignal, expectedIdentity) =>
        run(
          (runtime, scopedSignal) =>
            (this.deps.fetchModels ?? fetchChatGptWebModels)(
              runtime.page,
              scopedSignal,
              expectedIdentity,
            ),
          turnSignal,
        ),
      executeDirectTurn: (payload, turnSignal) => {
        if (used)
          return Promise.reject(
            new UpstreamDriftError("ChatGPT turn lease already consumed"),
          );
        used = true;
        return run(async (runtime, scopedSignal) => {
          runtime.frames = [];
          runtime.bytes = 0;
          runtime.frameError = undefined;
          runtime.observing = true;
          return (this.deps.execute ?? executeChatGptWebFirstPartyTurn)(
            runtime.page,
            payload as ChatGptWebFirstPartyRequest,
            { signal: scopedSignal },
          );
        }, turnSignal);
      },
      executeWebSocketTurn: (bootstrap, turnSignal) =>
        run(
          (runtime, scopedSignal) =>
            this.readHandoff(runtime, bootstrap, scopedSignal),
          turnSignal,
        ),
      close: release,
    };
  }

  private async ensureRuntime(
    entry: Entry,
    state: Credential,
  ): Promise<Runtime> {
    if (entry.runtime && !entry.runtime.page.isClosed()) return entry.runtime;
    if (entry.runtime) {
      try {
        entry.runtime.page = await entry.runtime.context.newPage();
        entry.runtime.ready = false;
        await this.installSocketObserver(entry.runtime);
        return entry.runtime;
      } catch {
        await entry.runtime.dispose().catch(() => {});
        entry.runtime = undefined;
      }
    }
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let dispose: (() => Promise<void>) | undefined;
    try {
      if (isChatGptProfileCredential(state)) {
        const lease = await acquireChatGptProfile(state.browserProfile, false, {
          launch: this.deps.launchPersistent,
        });
        context = lease.context;
        dispose = lease.close;
      } else {
        browser = await (this.deps.launch ?? chromium.launch.bind(chromium))({
          executablePath:
            process.env.CHATGPT_CHROMIUM_PATH ||
            (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
          headless:
            process.env.CHATGPT_WEB_HEADLESS === "1" || !process.env.DISPLAY,
          timeout: CHATGPT_WEB_CONSTANTS.BROWSER_ACQUIRE_TIMEOUT_MS,
        });
        context = await browser.newContext({ storageState: state });
        const ownedContext = context;
        const ownedBrowser = browser;
        dispose = async () => {
          await ownedContext.close().catch(() => {});
          await ownedBrowser.close().catch(() => {});
        };
      }
      const page = await context.newPage();
      const runtime: Runtime = {
        context,
        page,
        ready: false,
        dispose,
        frames: [],
        bytes: 0,
        observing: false,
      };
      entry.runtime = runtime;
      if (entry.closed || this.shutdown.signal.aborted) {
        await dispose();
        throw cancelled();
      }
      await this.installSocketObserver(runtime);
      // Dedicated profiles belong to this manager, not to the operator's browser.
      for (const stale of context.pages())
        if (stale !== page) await stale.close();
      return runtime;
    } catch (error) {
      await dispose?.().catch(() => {});
      if (!dispose) {
        await context?.close().catch(() => {});
        await browser?.close().catch(() => {});
      }
      entry.runtime = undefined;
      throw browserError(error);
    }
  }

  private async ensureReady(runtime: Runtime): Promise<void> {
    if (runtime.ready) return;
    const response = await runtime.page.goto(
      CHATGPT_WEB_CONSTANTS.TEMPORARY_CHAT_URL,
      {
        waitUntil: "domcontentloaded",
        timeout: CHATGPT_WEB_CONSTANTS.BROWSER_ACQUIRE_TIMEOUT_MS,
      },
    );
    if (response?.status() === 401)
      throw new CredentialError(
        "ChatGPT session expired; sign in to the dedicated profile",
      );
    if (response?.status() === 403)
      throw new ChallengeRequiredError(
        "Complete ChatGPT verification in the dedicated browser",
      );
    if (new URL(runtime.page.url()).origin !== CHATGPT_WEB_CONSTANTS.BASE_URL)
      throw new CredentialError(
        "ChatGPT requires login in the dedicated browser",
      );
    await (this.deps.initialize ?? initializeChatGptWebFirstPartyBridge)(
      runtime.page,
    );
    runtime.ready = true;
  }

  private resetPage(runtime: Runtime): Promise<void> {
    if (runtime.resetting) return runtime.resetting;
    runtime.resetting = (async () => {
      runtime.ready = false;
      runtime.observing = false;
      const old = runtime.page;
      // Keep a window alive before closing a native headed Chromium's last page.
      const replacement = await runtime.context
        .newPage()
        .catch(() => undefined);
      await old.close().catch(() => {});
      if (replacement) {
        runtime.page = replacement;
        await this.installSocketObserver(runtime);
      }
    })().finally(() => {
      runtime.resetting = undefined;
    });
    return runtime.resetting;
  }

  private async installSocketObserver(runtime: Runtime): Promise<void> {
    await runtime.page.addInitScript(() => {
      const NativeSocket = window.WebSocket;
      const sockets: WebSocket[] = [];
      const scope = window as Window & { __ultraSockets?: WebSocket[] };
      scope.__ultraSockets = sockets;
      window.WebSocket = class extends NativeSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          const target = new URL(String(url));
          if (
            target.protocol === "wss:" &&
            (target.hostname === "chatgpt.com" ||
              target.hostname.endsWith(".chatgpt.com"))
          )
            sockets.push(this);
        }
      };
    });
    runtime.page.on("websocket", (socket) => {
      const target = new URL(socket.url());
      if (
        target.protocol !== "wss:" ||
        !(
          target.hostname === "chatgpt.com" ||
          target.hostname.endsWith(".chatgpt.com")
        )
      )
        return;
      socket.on("framereceived", (frame) => {
        if (!runtime.observing) return;
        const text =
          typeof frame.payload === "string"
            ? frame.payload
            : frame.payload.toString("utf8");
        runtime.bytes += Buffer.byteLength(text);
        if (
          runtime.frames.length >= CHATGPT_WEB_CONSTANTS.MAX_SOCKET_FRAMES ||
          runtime.bytes > CHATGPT_WEB_CONSTANTS.MAX_RESPONSE_BYTES
        )
          runtime.frameError = new UpstreamDriftError(
            "ChatGPT handoff response exceeded its limit",
          );
        else runtime.frames.push(text);
        runtime.wake?.();
      });
      socket.on("close", () => runtime.wake?.());
    });
  }

  private async readHandoff(
    runtime: Runtime,
    bootstrap: HandoffBootstrap,
    signal: AbortSignal,
  ): Promise<string> {
    const subscribed = await runtime.page.evaluate((topic) => {
      const scope = window as Window & { __ultraSockets?: WebSocket[] };
      const sockets = scope.__ultraSockets;
      const socket = sockets?.find(
        (candidate) => candidate.readyState === WebSocket.OPEN,
      );
      if (!socket) return false;
      socket.send(
        JSON.stringify([
          {
            id: crypto.randomUUID(),
            command: { type: "subscribe", topic_id: topic },
          },
        ]),
      );
      return true;
    }, bootstrap.websocketTopicId);
    if (!subscribed)
      throw new UpstreamDriftError(
        "ChatGPT first-party handoff socket is unavailable",
      );
    const topic = new ChatGptTopicStream(bootstrap.websocketTopicId);
    const items: string[] = [];
    let cursor = 0;
    try {
      for (;;) {
        if (signal.aborted) throw cancelled();
        if (runtime.frameError) throw runtime.frameError;
        while (cursor < runtime.frames.length) {
          const result = topic.ingestFrame(runtime.frames[cursor++]);
          items.push(...result.encodedItems);
          if (result.done) return items.join("") + "\ndata: [DONE]\n\n";
        }
        await withAbort(
          new Promise<void>((resolve) => {
            runtime.wake = resolve;
          }),
          signal,
        );
      }
    } finally {
      runtime.wake = undefined;
    }
  }

  private scheduleIdle(entry: Entry): void {
    if (
      entry.closed ||
      entry.leases !== 0 ||
      this.entries.get(entry.key) !== entry
    )
      return;
    clearTimeout(entry.idle);
    entry.idle = setTimeout(() => {
      void this.retire(entry);
    }, this.idleTimeoutMs);
    entry.idle.unref();
  }

  private retire(entry: Entry): Promise<void> {
    if (entry.retiring) return entry.retiring;
    entry.closed = true;
    clearTimeout(entry.idle);
    entry.retiring = (async () => {
      await entry.release?.();
      await entry.opening?.catch(() => {});
      await entry.tail.catch(() => {});
      await entry.runtime?.dispose().catch(() => {});
      entry.runtime = undefined;
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    })();
    return entry.retiring;
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.shutdown.abort();
      await Promise.all(
        [...this.entries.values()].map((entry) => this.retire(entry)),
      );
    })();
    return this.closing;
  }
}

function browserError(error: unknown): WebProviderError {
  if (error instanceof WebProviderError) return error;
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  )
    return cancelled();
  return new UpstreamDriftError("ChatGPT in-page browser execution failed", {
    category: "browser-runtime",
  });
}
