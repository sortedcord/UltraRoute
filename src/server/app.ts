import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { extractChromiumCredentials } from "./autoAuth.ts";
import {
  globalProviderRegistry,
  globalModelRegistry,
  initializeWebProviders,
  ChatGptWebAdapter,
  ClaudeWebAdapter,
  GeminiWebAdapter,
  CHATGPT_WEB_CONSTANTS,
} from "../index.ts";
import { createChatGptBrowserSession } from "../providers/chatgpt/browser.ts";
import {
  CredentialError,
  InvalidRequestError,
  ProviderTimeoutError,
} from "../shared/errors.ts";
import type { ChatMessage } from "../shared/types.ts";
import { resolveChatRoute, getCredentialsForProvider } from "./routing.ts";
import {
  awaitWithAbort,
  createProviderUIMessageStreamResponse,
  logChatError,
  publicChatError,
  writeUIResponse,
} from "./uiStream.ts";
import type { ChatCompletionRequest } from "../index.ts";

// Initialize providers and models
initializeWebProviders();


// All registered server adapters use real transports, never fixture responses.
globalProviderRegistry.register(
  new ChatGptWebAdapter({
    browserBridgeFactory: createChatGptBrowserSession,
  }),
);

// Claude Web
const liveClaude = new ClaudeWebAdapter();
globalProviderRegistry.register(liveClaude);

// Gemini Web
const liveGemini = new GeminiWebAdapter();
globalProviderRegistry.register(liveGemini);

// ── HTTP Server ─────────────────────────────────────────────────────
const PORT = 3000;
const server = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // Serve bundle.js
    if (req.method === "GET" && url.pathname === "/bundle.js") {
      const bundlePath = join(process.cwd(), "public", "bundle.js");
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
      url.pathname === "/api/providers/claude-web/models"
    ) {
      try {
        const credentials = getCredentialsForProvider(
          "claude-web",
          extractChromiumCredentials(),
        );
        const catalog = await liveClaude.discoverModels(
          credentials,
          AbortSignal.timeout(30_000),
        );
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(catalog));
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

    if (req.method === "GET" && url.pathname === "/api/providers/gemini-web/models") {
      try {
        const credentials = getCredentialsForProvider("gemini-web", extractChromiumCredentials());
        const catalog = await liveGemini.discoverModels(credentials, AbortSignal.timeout(60_000));
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(catalog));
      } catch (error) {
        const failure = publicChatError(error);
        res.writeHead(failure.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: failure.message }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      const upstream = new AbortController();
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
          (body.provider !== undefined && typeof body.provider !== "string")
        ) {
          throw new InvalidRequestError("Model and provider must be strings");
        }
        const route = resolveChatRoute(
          globalModelRegistry,
          body.model as string | undefined,
          body.provider as string | undefined,
        );
        if (!Array.isArray(body.messages) || body.messages.length === 0)
          throw new InvalidRequestError("Messages cannot be empty");
        const modelMessages: ChatMessage[] = body.messages.map(
          (raw: unknown) => {
            if (!raw || typeof raw !== "object")
              throw new InvalidRequestError("Invalid message");
            const message = raw as Record<string, unknown>;
            const role = message.role;
            if (role !== "user" && role !== "assistant" && role !== "system")
              throw new InvalidRequestError("Unsupported message role");
            const parts = Array.isArray(message.parts)
              ? message.parts
              : Array.isArray(message.content)
                ? message.content
                : [];
            const content =
              typeof message.content === "string"
                ? message.content
                : parts
                    .map((part: unknown) => {
                      if (!part || typeof part !== "object") return "";
                      const value = part as Record<string, unknown>;
                      return value.type === "text" &&
                        typeof value.text === "string"
                        ? value.text
                        : "";
                    })
                    .join("");
            return { role, content };
          },
        );

        if (route.providerId === "google") {
          if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY)
            throw new CredentialError("Google API key missing");
          const [{ google }, { streamText }] = await Promise.all([
            import("@ai-sdk/google"),
            import("ai"),
          ]);
          upstream.signal.throwIfAborted();
          const result = streamText({
            model: google(route.model),
            messages: modelMessages.map((message) => ({
              role: message.role as "user" | "assistant" | "system",
              content: message.content as string,
            })),
            abortSignal: upstream.signal,
          });
          await writeUIResponse(
            res,
            result.toUIMessageStreamResponse({
              sendReasoning: true,
              onError: (error) =>
                publicChatError(error, upstream.signal).message,
            }),
            disconnected.signal,
          );
        } else {
          const provider = globalProviderRegistry.get(route.providerId);
          if (!provider)
            throw new InvalidRequestError("Provider is unavailable");
          // Refresh browser credentials on every request so sign-in/session changes take effect.
          const credentials = getCredentialsForProvider(
            route.providerId,
            extractChromiumCredentials(),
          );
          if (!credentials)
            throw new CredentialError("Provider credentials missing");
          const request: ChatCompletionRequest = {
            model: route.model,
            messages: modelMessages,
            stream: true,
          };
          const result = await awaitWithAbort(
            provider.execute(request, credentials, upstream.signal),
            upstream.signal,
          );
          await writeUIResponse(
            res,
            createProviderUIMessageStreamResponse(result, upstream.signal),
            disconnected.signal,
          );
        }
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

const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(
    `UltraRoute Chat UI running on all interfaces at http://${HOST}:${PORT}`,
  );
  console.log(`Local network URL: http://192.168.0.17:${PORT}`);
});
