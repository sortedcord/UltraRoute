import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import {
  installChatGptStreamCapture,
  resetChatGptStreamCapture,
  readChatGptStreamCapture,
} from "../../src/providers/chatgpt/streamCapture.ts";
import { CHATGPT_WEB_CONSTANTS } from "../../src/providers/chatgpt/constants.ts";
import { ChatGptDeltaV1Decoder } from "../../src/providers/chatgpt/deltaV1.ts";
import {
  ProviderTimeoutError,
  UpstreamDriftError,
} from "../../src/shared/errors.ts";

const conversationPath = `/backend-api${CHATGPT_WEB_CONSTANTS.DIRECT_SSE_PATH}`;
const sse =
  'data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":["café 🙂 東京"]},"status":"finished_successfully","end_turn":true}}\n\ndata: [DONE]\n\n';
const bytes = Buffer.from(sse);

test(
  "local Chromium observes only owned first-party responses and bounds the clone without changing native consumption",
  { skip: process.env.RUN_BROWSER_TESTS !== "1", timeout: 60_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "ultraroute-capture-"));
    let browser: Browser | undefined;
    const hanging = new Set<ServerResponse>();
    const requests: { method?: string; body: string }[] = [];
    const keyPath = join(directory, "key.pem");
    const certPath = join(directory, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        "/CN=chatgpt.com",
      ],
      { stdio: "ignore" },
    );
    const server = createServer(
      { key: await readFile(keyPath), cert: await readFile(certPath) },
      async (request, response) => {
        const url = new URL(request.url!, CHATGPT_WEB_CONSTANTS.BASE_URL);
        if (url.pathname === "/") {
          response.writeHead(200, { "content-type": "text/html" });
          // Capture installation must precede a frontend-cached fetch reference.
          response.end("<script>window.frontendFetch = window.fetch</script>");
          return;
        }
        const body: Buffer[] = [];
        for await (const chunk of request) body.push(Buffer.from(chunk));
        if (url.pathname === conversationPath && request.method === "POST")
          requests.push({
            method: request.method,
            body: Buffer.concat(body).toString(),
          });
        const mode = url.searchParams.get("mode");
        response.writeHead(mode === "unauthorized" ? 401 : 200, {
          "content-type":
            mode === "html"
              ? "text/html"
              : mode === "json"
                ? "application/json"
                : "text/event-stream",
        });
        if (mode === "hang" || mode?.startsWith("abort-")) {
          if (mode === "abort-finished") response.write(sse);
          else if (mode === "abort-progress")
            response.write(
              sse
                .replace('"finished_successfully"', '"in_progress"')
                .replace('"end_turn":true', '"end_turn":false'),
            );
          else if (mode === "abort-tail")
            response.write(Buffer.concat([bytes, Buffer.from([0xf0, 0x9f])]));
          else response.write("data: pending\n\n");
          hanging.add(response);
          response.once("close", () => hanging.delete(response));
        } else if (mode === "limit" || mode === "over") {
          response.write(
            Buffer.alloc(CHATGPT_WEB_CONSTANTS.MAX_RESPONSE_BYTES, 120),
          );
          response.end(mode === "over" ? Buffer.from("!") : undefined);
        } else if (mode === "invalid") {
          response.end(Buffer.from([0x61, 0xf0, 0x9f]));
        } else if (mode === "json") {
          response.end(
            '{"handoff":{"conversation_id":"local","topic_id":"fixture"}}',
          );
        } else {
          // Yield each written byte through its flush callback rather than a
          // guessed sleep; UTF-8 boundaries span independent server writes.
          for (let index = 0; index < bytes.length; index++) {
            await new Promise<void>((resolve) =>
              response.write(bytes.subarray(index, index + 1), () => resolve()),
            );
          }
          response.end();
        }
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      browser = await chromium.launch({
        executablePath:
          process.env.CHATGPT_CHROMIUM_PATH ||
          (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
        headless: true,
        args: [
          `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${address.port}`,
          "--no-proxy-server",
        ],
      });
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      await installChatGptStreamCapture(page);
      await page.goto(CHATGPT_WEB_CONSTANTS.BASE_URL);
      const nativeText = (page: Page, mode = "sse") =>
        page.evaluate(
          async ({ path, mode }) => {
            const frontend = window as unknown as Window & {
              frontendFetch: typeof fetch;
            };
            const response = await frontend.frontendFetch(
              new Request(new URL(`${path}?mode=${mode}`, location.href), {
                method: "GET",
              }),
              {
                method: "POST",
                body: "unaltered frontend payload",
              },
            );
            return response.text();
          },
          { path: conversationPath, mode },
        );

      await t.test(
        "split UTF-8 reaches both the native consumer and assistant decoder",
        async () => {
          await resetChatGptStreamCapture(page);
          const original = nativeText(page);
          const captured = await readChatGptStreamCapture(page);
          assert.equal(captured, sse);
          assert.equal(await original, sse);
          const result = new ChatGptDeltaV1Decoder().ingest(captured);
          assert.equal(result.assistantText, "café 🙂 東京");
          assert.equal(result.done, true);
          assert.deepEqual(requests[0], {
            method: "POST",
            body: "unaltered frontend payload",
          });
        },
      );

      await t.test("JSON handoff is preserved completely at EOF", async () => {
        await resetChatGptStreamCapture(page);
        const original = nativeText(page, "json");
        const captured = await readChatGptStreamCapture(page);
        assert.deepEqual(JSON.parse(captured), {
          handoff: { conversation_id: "local", topic_id: "fixture" },
        });
        assert.equal(await original, captured);
      });

      await t.test(
        "exact byte limit succeeds; overflow rejects while original reads all bytes",
        async () => {
          for (const mode of ["limit", "over"]) {
            await resetChatGptStreamCapture(page);
            const original = page.evaluate(
              async ({ path, mode }) => {
                const response = await fetch(`${path}?mode=${mode}`, {
                  method: "POST",
                });
                const body = new Uint8Array(await response.arrayBuffer());
                return {
                  length: body.byteLength,
                  first: body[0],
                  last: body[body.length - 1],
                };
              },
              { path: conversationPath, mode },
            );
            if (mode === "limit") {
              assert.equal(
                (await readChatGptStreamCapture(page)).length,
                CHATGPT_WEB_CONSTANTS.MAX_RESPONSE_BYTES,
              );
            } else {
              await assert.rejects(
                readChatGptStreamCapture(page),
                (error: unknown) =>
                  error instanceof UpstreamDriftError &&
                  error.message ===
                    "ChatGPT conversation response exceeded the size limit" &&
                  error.cause === undefined,
              );
            }
            assert.deepEqual(await original, {
              length:
                CHATGPT_WEB_CONSTANTS.MAX_RESPONSE_BYTES +
                (mode === "over" ? 1 : 0),
              first: 120,
              last: mode === "over" ? 33 : 120,
            });
          }
        },
      );

      await t.test(
        "malformed final UTF-8 rejects instead of replacing bytes",
        async () => {
          await resetChatGptStreamCapture(page);
          const original = nativeText(page, "invalid");
          await assert.rejects(
            readChatGptStreamCapture(page),
            (error: unknown) =>
              error instanceof UpstreamDriftError &&
              error.message ===
                "ChatGPT conversation response contained invalid UTF-8" &&
              error.cause === undefined,
          );
          assert.equal(await original, "a�");
        },
      );

      await t.test(
        "other origin, routes, method, status and HTML never satisfy capture",
        async () => {
          await page.route("https://example.test/**", (route) =>
            route.fulfill({
              contentType: "text/event-stream",
              body: "ignored",
              headers: { "access-control-allow-origin": "*" },
            }),
          );
          for (const url of [
            `https://example.test${conversationPath}`,
            `${conversationPath}/prepare`,
            "/api/auth/session",
            `${conversationPath}?mode=html`,
            `${conversationPath}?mode=unauthorized`,
          ]) {
            await resetChatGptStreamCapture(page);
            await page.evaluate(async (url) => {
              await (await fetch(url, { method: "POST" })).text();
            }, url);
            // A subsequent exact response must win, not any preceding ignored body.
            const original = nativeText(page, "json");
            assert.equal(await readChatGptStreamCapture(page), await original);
          }
          await resetChatGptStreamCapture(page);
          await page.evaluate(async (path) => {
            await (await fetch(path)).text();
          }, conversationPath);
          const original = nativeText(page, "json");
          assert.equal(await readChatGptStreamCapture(page), await original);
        },
      );

      await t.test(
        "aborting a hanging observation leaves native branch usable and reset discards it",
        async () => {
          await resetChatGptStreamCapture(page);
          const headers = page.waitForResponse((response) =>
            response.url().includes("mode=hang"),
          );
          const original = nativeText(page, "hang");
          const controller = new AbortController();
          const capture = readChatGptStreamCapture(page, controller.signal);
          const rejected = assert.rejects(
            capture,
            (error: unknown) =>
              error instanceof ProviderTimeoutError &&
              error.message === "ChatGPT browser turn cancelled" &&
              error.cause === undefined,
          );
          await headers;
          controller.abort("PRIVATE abort reason");
          await rejected;
          await resetChatGptStreamCapture(page);
          const next = nativeText(page, "json");
          const captured = await readChatGptStreamCapture(page);
          for (const response of hanging)
            response.end("data: native survives\n\n");
          assert.equal(
            await original,
            "data: pending\n\ndata: native survives\n\n",
          );
          assert.equal(captured, await next);
          assert.equal(await readChatGptStreamCapture(page), captured);
        },
      );

      await t.test(
        "frontend abort after verified terminal SSE succeeds; incomplete turn or UTF-8 rejects",
        async () => {
          for (const mode of [
            "abort-finished",
            "abort-progress",
            "abort-tail",
          ]) {
            await resetChatGptStreamCapture(page);
            const frontend = page.evaluate(
              async ({ path, mode }) => {
                const controller = new AbortController();
                const response = await fetch(`${path}?mode=${mode}`, {
                  method: "POST",
                  signal: controller.signal,
                });
                const reader = response.body!.getReader();
                const decoder = new TextDecoder();
                let text = "";
                while (!text.includes("data: [DONE]\n\n")) {
                  const chunk = await reader.read();
                  if (chunk.done)
                    throw new Error(
                      "Fixture ended before native terminal frame",
                    );
                  text += decoder.decode(chunk.value, { stream: true });
                }
                // Match native frontend cancellation after rendering the terminal
                // answer: yield to a real rendering frame, not a wall-clock sleep.
                await new Promise<void>((resolve) =>
                  requestAnimationFrame(() => resolve()),
                );
                controller.abort();
                return text;
              },
              { path: conversationPath, mode },
            );
            const captured = readChatGptStreamCapture(page);
            if (mode === "abort-finished") {
              assert.equal(await captured, sse);
              assert.equal(await frontend, sse);
            } else {
              await assert.rejects(
                captured,
                (error: unknown) =>
                  error instanceof UpstreamDriftError &&
                  error.details?.reason ===
                    (mode === "abort-tail" ? "encoding" : "stream-read") &&
                  error.cause === undefined,
              );
              await frontend;
            }
          }
        },
      );
    } finally {
      await browser?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
