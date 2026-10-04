import { homedir } from "node:os";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { extractChromiumCredentials } from "./autoAuth.ts";

// Load environment variables from .env.local and .env
for (const envFile of [".env.local", ".env"]) {
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf-8").split("\n")) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let val = match[2]?.trim() || "";
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
}
import {
  globalProviderRegistry,
  globalModelRegistry,
  initializeWebProviders,
  ChatGptWebAdapter,
  ClaudeWebAdapter,
  GeminiWebAdapter,
  CHATGPT_WEB_CONSTANTS,
  FileCookieSource,
} from "../index.ts";
import { WarmChatGptBrowserManager } from "../providers/chatgpt/browser.ts";
import {
  CredentialError,
  InvalidRequestError,
  ProviderTimeoutError,
} from "../shared/errors.ts";
import type { ReasoningEffort } from "../shared/types.ts";
import { convertHttpChatMessages } from "./messages.ts";
import { ModelCatalogCache } from "../shared/modelCatalogCache.ts";
import { resolveChatRoute, getCredentialsForProvider } from "./routing.ts";
import {
  awaitWithAbort,
  createProviderUIMessageStreamResponse,
  logChatError,
  publicChatError,
  writeUIResponse,
} from "./uiStream.ts";
import type { ChatCompletionRequest } from "../index.ts";

const chatGptBrowserManager = new WarmChatGptBrowserManager();

const catalogCachePath =
  process.env.MODEL_CATALOG_CACHE_FILE ??
  join(homedir(), ".local", "share", "ultraroute", "model-catalogs.json");
const modelCatalogCache = new ModelCatalogCache(catalogCachePath);
// The server supplies live browser services; initialization never replaces them.
const liveChatGpt = new ChatGptWebAdapter({
  transportFactory: (state, signal) =>
    chatGptBrowserManager.createSession(state, signal),
  modelCatalogSource: chatGptBrowserManager,
  modelCatalogCache,
});
globalProviderRegistry.register(liveChatGpt);
const liveClaude = new ClaudeWebAdapter({ modelCatalogCache });
globalProviderRegistry.register(liveClaude);

// Gemini Web
const geminiCookieSource = process.env.GEMINI_COOKIE_FILE
  ? new FileCookieSource(process.env.GEMINI_COOKIE_FILE)
  : undefined;
const liveGemini = new GeminiWebAdapter({
  cookieSource: geminiCookieSource,
  modelCatalogCache,
});
globalProviderRegistry.register(liveGemini);
initializeWebProviders(modelCatalogCache);
const shutdownController = new AbortController();
const activeRequests = new Set<AbortController>();
const refreshInterval = Number(
  process.env.MODEL_CATALOG_REFRESH_INTERVAL_MS ?? 6 * 60 * 60 * 1000,
);
let refreshInProgress: Promise<void> | undefined;
const refreshCatalogs = () => {
  if (refreshInProgress) return refreshInProgress;
  refreshInProgress = (async () => {
    try {
      const credentials = getCredentialsForProvider(
        "chatgpt-web",
        extractChromiumCredentials("chatgpt-web"),
      );
      if (credentials)
        await liveChatGpt.refreshCatalog(
          credentials,
          AbortSignal.any([
            shutdownController.signal,
            AbortSignal.timeout(60_000),
          ]),
        );
    } catch (error) {
      console.warn(
        "ChatGPT model catalog refresh failed:",
        publicChatError(error).message,
      );
    }
    if (shutdownController.signal.aborted) return;
    try {
      const extracted = extractChromiumCredentials("claude-web");
      const claudeCredentials = getCredentialsForProvider(
        "claude-web",
        extracted,
      );
      if (claudeCredentials)
        await liveClaude.refreshCatalog(
          claudeCredentials,
          AbortSignal.any([
            shutdownController.signal,
            AbortSignal.timeout(30_000),
          ]),
        );
    } catch (error) {
      console.warn(
        "Claude model catalog refresh failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (shutdownController.signal.aborted) return;
    try {
      const geminiCredentials = geminiCookieSource
        ? await geminiCookieSource.getCookie()
        : getCredentialsForProvider(
            "gemini-web",
            extractChromiumCredentials("gemini-web"),
          );
      if (geminiCredentials)
        await liveGemini.refreshCatalog(
          geminiCredentials,
          AbortSignal.any([
            shutdownController.signal,
            AbortSignal.timeout(60_000),
          ]),
        );
    } catch (error) {
      console.warn(
        "Gemini model catalog refresh failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  })().finally(() => {
    refreshInProgress = undefined;
  });
  return refreshInProgress;
};
const catalogRefreshTimer =
  Number.isFinite(refreshInterval) && refreshInterval > 0
    ? setInterval(() => {
        void refreshCatalogs();
      }, refreshInterval)
    : undefined;
catalogRefreshTimer?.unref();

function stopCatalogRefresh() {
  clearInterval(catalogRefreshTimer);
}

// ── HTTP Server ─────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 3000);
export const server = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    if (shutdownController.signal.aborted) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server is shutting down" }));
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // Serve the generated client bundle from dist/.
    if (req.method === "GET" && url.pathname === "/dist/bundle.js") {
      const bundlePath = join(process.cwd(), "dist", "bundle.js");
      if (existsSync(bundlePath)) {
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
        });
        res.end(readFileSync(bundlePath));
        return;
      }
    }

    // Serve Frontend HTML
    if (
      req.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/index.html")
    ) {
      const candidates = [
        join(process.cwd(), "public", "index.html"),
        "/home/sortedcord/UltraRoute/public/index.html",
      ];
      for (const htmlPath of candidates) {
        if (existsSync(htmlPath)) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(readFileSync(htmlPath));
          return;
        }
      }
    }
    if (
      req.method === "GET" &&
      url.pathname === "/api/providers/chatgpt-web/models"
    ) {
      try {
        const credentials = getCredentialsForProvider(
          "chatgpt-web",
          extractChromiumCredentials("chatgpt-web"),
        );
        const result = await liveChatGpt.getCatalog(
          credentials,
          AbortSignal.any([
            shutdownController.signal,
            AbortSignal.timeout(60_000),
          ]),
        );
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(
          JSON.stringify({ ...result.catalog, catalogStatus: result.status }),
        );
      } catch (error) {
        const failure = publicChatError(error);
        res.writeHead(failure.status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ error: failure.message }));
      }
      return;
    }

    if (
      req.method === "GET" &&
      url.pathname === "/api/providers/claude-web/models"
    ) {
      try {
        const credentials = getCredentialsForProvider(
          "claude-web",
          extractChromiumCredentials("claude-web"),
        );
        const result = await liveClaude.getCatalog(
          credentials,
          AbortSignal.any([
            shutdownController.signal,
            AbortSignal.timeout(30_000),
          ]),
        );
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(
          JSON.stringify({ ...result.catalog, catalogStatus: result.status }),
        );
      } catch (error) {
        const failure = publicChatError(error);
        res.writeHead(failure.status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ error: failure.message }));
      }
      return;
    }

    if (
      req.method === "GET" &&
      url.pathname === "/api/providers/gemini-web/models"
    ) {
      try {
        const credentials = geminiCookieSource
          ? await geminiCookieSource.getCookie()
          : getCredentialsForProvider(
              "gemini-web",
              extractChromiumCredentials("gemini-web"),
            );
        const result = await liveGemini.getCatalog(
          credentials,
          AbortSignal.any([
            shutdownController.signal,
            AbortSignal.timeout(60_000),
          ]),
        );
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(
          JSON.stringify({ ...result.catalog, catalogStatus: result.status }),
        );
      } catch (error) {
        const failure = publicChatError(error);
        res.writeHead(failure.status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ error: failure.message }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      const upstream = new AbortController();
      activeRequests.add(upstream);
      const disconnected = new AbortController();
      const onDisconnect = () => {
        if (res.writableEnded) return;
        const error = new DOMException("Client disconnected", "AbortError");
        disconnected.abort(error);
        upstream.abort(error);
      };
      req.once("aborted", onDisconnect);
      res.once("close", onDisconnect);
      const timeout = setTimeout(
        () =>
          upstream.abort(new ProviderTimeoutError("Chat request timed out")),
        CHATGPT_WEB_CONSTANTS.DEFAULT_TURN_TIMEOUT_MS,
      );
      timeout.unref();
      try {
        let bodyStr = "";
        for await (const chunk of req) bodyStr += chunk;
        let body: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(bodyStr);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("Invalid body");
          body = parsed as Record<string, unknown>;
        } catch {
          throw new InvalidRequestError("Expected a JSON chat request");
        }
        if (
          (body.model !== undefined && typeof body.model !== "string") ||
          (body.provider !== undefined && typeof body.provider !== "string") ||
          (body.reasoning_effort !== undefined &&
            typeof body.reasoning_effort !== "string")
        ) {
          throw new InvalidRequestError(
            "Model, provider, and reasoning_effort must be strings",
          );
        }
        const route = resolveChatRoute(
          globalModelRegistry,
          body.model as string | undefined,
          body.provider as string | undefined,
        );
        const { messages: modelMessages, attachments } =
          convertHttpChatMessages(body.messages, route.providerId);

        const provider = globalProviderRegistry.get(route.providerId);
        if (!provider) throw new InvalidRequestError("Provider is unavailable");
        // Refresh browser credentials on every request so sign-in/session changes take effect.
        const credentials =
          route.providerId === "gemini-web" && geminiCookieSource
            ? await geminiCookieSource.getCookie()
            : getCredentialsForProvider(
                route.providerId,
                extractChromiumCredentials(
                  route.providerId as
                    "chatgpt-web" | "claude-web" | "gemini-web",
                ),
              );
        if (!credentials)
          throw new CredentialError("Provider credentials missing");
        const request: ChatCompletionRequest = {
          model: route.model,
          messages: modelMessages,
          attachments,
          stream: true,
          reasoning_effort: body.reasoning_effort as
            ReasoningEffort | undefined,
        };
        const result = await awaitWithAbort(
          provider.execute(request, credentials, upstream.signal),
          upstream.signal,
        );
      } catch (error) {
        const safe = publicChatError(error, upstream.signal);
        logChatError(error, upstream.signal);
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(safe.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: safe.message, code: safe.code }));
        } else if (!res.destroyed && !res.writableEnded) {
          res.end();
        }
      } finally {
        clearTimeout(timeout);
        activeRequests.delete(upstream);
        req.removeListener("aborted", onDisconnect);
        res.removeListener("close", onDisconnect);
        if (!res.destroyed && !res.writableEnded) res.end();
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  },
);
let shutdown: Promise<void> | undefined;
const beginShutdown = () => {
  if (shutdown) return shutdown;
  stopCatalogRefresh();
  const reason = new DOMException("Server shutting down", "AbortError");
  shutdownController.abort(reason);
  for (const request of activeRequests) request.abort(reason);
  process.removeListener("SIGINT", onShutdownSignal);
  process.removeListener("SIGTERM", onShutdownSignal);
  shutdown = chatGptBrowserManager.close().catch(() => {
    console.warn("ChatGPT browser shutdown failed");
  });
  return shutdown;
};
const closeServer = server.close.bind(server);
server.close = (callback) => {
  void beginShutdown();
  const result = closeServer((error) => {
    void beginShutdown().then(() => callback?.(error));
  });
  server.closeAllConnections();
  return result;
};
function onShutdownSignal() {
  server.close();
}
process.once("SIGINT", onShutdownSignal);
process.once("SIGTERM", onShutdownSignal);
server.once("close", () => {
  void beginShutdown();
});
void refreshCatalogs();

const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(
    `UltraRoute Chat UI running on all interfaces at http://${HOST}:${PORT}`,
  );
  console.log(`Local network URL: http://192.168.0.17:${PORT}`);
});
