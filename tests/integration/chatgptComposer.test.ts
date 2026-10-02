import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { executeChatGptComposerTurn } from "../../src/providers/chatgpt/composer.ts";
import {
  InvalidRequestError,
  ChallengeRequiredError,
  ProviderTimeoutError,
} from "../../src/shared/errors.ts";

const html = await readFile(
  new URL("../fixtures/chatgptComposer.html", import.meta.url),
  "utf8",
);
const sse =
  'data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":["fixture answer"]},"status":"finished_successfully","end_turn":true}}\n\ndata: [DONE]\n\n';
const launch = (args: string[] = []) =>
  chromium.launch({
    executablePath:
      process.env.CHATGPT_CHROMIUM_PATH ||
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    headless: true,
    args,
  });

test(
  "native Chromium controls preserve model, temporary chat, uploaded bytes and capture actual SSE",
  { skip: process.env.RUN_BROWSER_TESTS !== "1" },
  async () => {
    const browser = await launch();
    const page = await browser.newPage();
    const submitted: Record<string, unknown>[] = [];
    await page.route("https://chatgpt.com/**", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "GET")
        return route.fulfill({ contentType: "text/html", body: html });
      const payload = route.request().postDataJSON();
      if (url.pathname.endsWith("/prepare"))
        return route.fulfill({ json: { ready: true } });
      submitted.push(payload);
      return route.fulfill({ contentType: "text/event-stream", body: sse });
    });
    try {
      await page.goto("https://chatgpt.com/?temporary=off");
      const result = await executeChatGptComposerTurn(page, {
        prompt: "describe fixture",
        selection: { kind: "picker", modelLabel: "GPT-5.5", effortIndex: 0 },
        attachments: [
          {
            kind: "file",
            name: "fixture.txt",
            mimeType: "text/plain",
            size: 3,
            data: Buffer.from("abc"),
          },
        ],
      });
      assert.equal(result, sse);
      assert.deepEqual(submitted, [
        {
          model: "gpt-5-5",
          think: false,
          prompt: "describe fixture",
          temporary: true,
          attachments: [
            { name: "fixture.txt", mimeType: "text/plain", data: [97, 98, 99] },
          ],
        },
      ]);
      await page.goto("https://chatgpt.com/");
      await assert.rejects(
        executeChatGptComposerTurn(page, {
          prompt: "unsupported",
          selection: {
            kind: "picker",
            modelLabel: "GPT-5.6 Sol",
            effortIndex: 4,
          },
          attachments: [],
        }),
        InvalidRequestError,
      );
      assert.equal(submitted.length, 1);
      await page.goto("https://chatgpt.com/");
      const freeResult = await executeChatGptComposerTurn(page, {
        prompt: "think fixture",
        selection: { kind: "free", thinkEnabled: true },
        attachments: [],
      });
      assert.equal(freeResult, sse);
      assert.equal(submitted[1].model, "auto");
      assert.equal(submitted[1].think, true);
      await page.goto("https://chatgpt.com/");
      await page.evaluate(() => {
        document.querySelector('[aria-label="Select model"]')!.textContent =
          "Medium";
        const slider =
          document.querySelector<HTMLInputElement>('[role="slider"]')!;
        slider.disabled = false;
        slider.setAttribute("aria-valuemin", "0");
        slider.setAttribute("aria-valuemax", "2");
        slider.setAttribute("aria-valuenow", "1");
      });
      const instantResult = await executeChatGptComposerTurn(page, {
        prompt: "instant fixture",
        selection: {
          kind: "picker",
          modelLabel: "GPT-5.6 Sol",
          effortIndex: 0,
        },
        attachments: [],
      });
      assert.equal(instantResult, sse);
      assert.equal(submitted[2].prompt, "instant fixture");
      assert.equal(
        await page
          .getByRole("slider", { includeHidden: true })
          .getAttribute("aria-valuenow"),
        "0",
      );
      assert.equal(
        await page
          .getByRole("menuitem", {
            name: "Select model",
            exact: true,
            includeHidden: true,
          })
          .innerText(),
        "Instant",
      );
      await page.goto("https://chatgpt.com/");
      await page.evaluate(() => {
        const slider =
          document.querySelector<HTMLInputElement>('[role="slider"]')!;
        slider.disabled = false;
        slider.setAttribute("aria-valuemin", "0");
        slider.setAttribute("aria-valuemax", "2");
        slider.setAttribute("aria-valuenow", "1");
        document.querySelector('[aria-label="Select model"]')!.textContent =
          "Medium";
        document.getElementById("models")!.textContent =
          "Thinking effortMedium";
      });
      const instantFromMedium = await executeChatGptComposerTurn(page, {
        prompt: "instant from medium",
        selection: {
          kind: "picker",
          modelLabel: "GPT-5.6 Sol",
          effortIndex: 0,
        },
        attachments: [],
      });
      assert.equal(instantFromMedium, sse);
      assert.equal(submitted[3].prompt, "instant from medium");
      assert.equal(
        await page
          .getByRole("slider", { includeHidden: true })
          .getAttribute("aria-valuenow"),
        "0",
      );
      assert.equal(
        await page
          .getByRole("menuitem", {
            name: "Select model",
            exact: true,
            includeHidden: true,
          })
          .innerText(),
        "Instant",
      );
      await page.goto("https://chatgpt.com/");
      await page.evaluate(() => {
        document.querySelector('[aria-label="Select model"]')!.textContent =
          "Medium";
        const slider =
          document.querySelector<HTMLInputElement>('[role="slider"]')!;
        slider.disabled = false;
        slider.setAttribute("aria-valuenow", "1");
        slider.addEventListener("keydown", () => {
          throw new Error(
            "Already-selected Medium must not manipulate the slider",
          );
        });
      });
      const mediumResult = await executeChatGptComposerTurn(page, {
        prompt: "medium fixture",
        selection: {
          kind: "picker",
          modelLabel: "GPT-5.6 Sol",
          effortIndex: 2,
        },
        attachments: [],
      });
      assert.equal(mediumResult, sse);
      assert.equal(submitted[4].prompt, "medium fixture");
      assert.equal(
        await page
          .getByRole("slider", { includeHidden: true })
          .getAttribute("aria-valuenow"),
        "1",
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  "native prepare challenge stops before conversation and never exposes response HTML",
  { skip: process.env.RUN_BROWSER_TESTS !== "1" },
  async () => {
    const browser = await launch();
    const page = await browser.newPage();
    let conversations = 0;
    await page.route("https://chatgpt.com/**", async (route) => {
      if (route.request().method() === "GET")
        return route.fulfill({ contentType: "text/html", body: html });
      if (new URL(route.request().url()).pathname.endsWith("/prepare"))
        return route.fulfill({
          status: 403,
          contentType: "text/html",
          body: "<html>FAKE_SECRET session-cookie</html>",
        });
      conversations++;
      return route.fulfill({ contentType: "text/event-stream", body: sse });
    });
    try {
      await page.goto("https://chatgpt.com/");
      await assert.rejects(
        executeChatGptComposerTurn(page, {
          prompt: "challenge",
          selection: {
            kind: "picker",
            modelLabel: "GPT-5.6 Sol",
            effortIndex: 0,
          },
          attachments: [],
        }),
        (error: unknown) =>
          error instanceof ChallengeRequiredError &&
          !error.message.includes("FAKE_SECRET") &&
          error.cause === undefined,
      );
      assert.equal(conversations, 0);
      assert.equal(page.isClosed(), false);
      assert.equal(await page.title(), "ChatGPT native composer fixture");
    } finally {
      await browser.close();
    }
  },
);

test(
  "cancellation before Send closes only the execution page and submits nothing",
  { skip: process.env.RUN_BROWSER_TESTS !== "1", timeout: 15_000 },
  async () => {
    const browser = await launch();
    const context = await browser.newContext();
    const operatorPage = await context.newPage();
    let submissions = 0;
    await context.route("https://chatgpt.com/**", async (route) => {
      if (route.request().method() === "GET")
        return route.fulfill({ contentType: "text/html", body: html });
      submissions++;
      return route.fulfill({ contentType: "text/event-stream", body: sse });
    });
    try {
      for (const pending of ["composer", "send"] as const) {
        const page = await context.newPage();
        await page.goto("https://chatgpt.com/");
        await page.evaluate((pending) => {
          const composer =
            document.querySelector<HTMLElement>("[contenteditable]")!;
          if (pending === "composer") composer.style.display = "none";
          else {
            composer.addEventListener("input", () => {
              document.querySelector<HTMLButtonElement>(
                '[aria-label="Send"]',
              )!.disabled = true;
            });
          }
        }, pending);
        const controller = new AbortController();
        const turn = executeChatGptComposerTurn(
          page,
          {
            prompt: "must not submit",
            selection: { kind: "free", thinkEnabled: false },
            attachments: [],
          },
          { signal: controller.signal },
        );
        const rejected = assert.rejects(
          turn,
          (error: unknown) =>
            error instanceof ProviderTimeoutError &&
            error.message === "ChatGPT browser turn cancelled" &&
            error.cause === undefined,
        );
        if (pending === "send")
          await page.waitForFunction(
            () =>
              document.querySelector("[contenteditable]")?.textContent ===
              "must not submit",
          );
        controller.abort("PRIVATE abort reason");
        await rejected;
        assert.equal(page.isClosed(), true);
        assert.equal(submissions, 0);
        assert.equal(operatorPage.isClosed(), false);
        await operatorPage.setContent("<p>Operator context remains usable</p>");
        assert.equal(
          await operatorPage.locator("p").innerText(),
          "Operator context remains usable",
        );
      }
    } finally {
      await browser.close();
    }
  },
);

test(
  "turn-wide cancellation interrupts response-header races and a hanging body",
  { skip: process.env.RUN_BROWSER_TESTS !== "1", timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ultraroute-composer-"));
    let browser: Browser | undefined;
    let server: Server | undefined;
    try {
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
      let conversations = 0;
      const closedConnections: Promise<void>[] = [];
      server = createServer(
        {
          key: await readFile(keyPath),
          cert: await readFile(certPath),
        },
        (request, response) => {
          if (request.method === "GET") {
            response.writeHead(200, { "content-type": "text/html" });
            response.end(html);
          } else if (request.url?.endsWith("/prepare")) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end('{"ready":true}');
          } else {
            conversations++;
            closedConnections.push(
              new Promise<void>((resolve) => response.once("close", resolve)),
            );
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(
              'data: {"PRIVATE":"response body never finishes"}\n\n',
            );
          }
        },
      );
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      browser = await launch([
        `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${address.port}`,
        "--no-proxy-server",
      ]);
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      for (const abortAtHeaders of [true, false]) {
        const page = await context.newPage();
        await page.goto("https://chatgpt.com/");
        const controller = new AbortController();
        const headers = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/backend-api/f/conversation",
        );
        if (abortAtHeaders)
          page.on("response", (response) => {
            if (
              new URL(response.url()).pathname === "/backend-api/f/conversation"
            )
              controller.abort("PRIVATE header race");
          });
        const turn = executeChatGptComposerTurn(
          page,
          {
            prompt: "body must be cancellable",
            selection: { kind: "free", thinkEnabled: false },
            attachments: [],
          },
          { signal: controller.signal },
        );
        const rejected = assert.rejects(
          turn,
          (error: unknown) =>
            error instanceof ProviderTimeoutError &&
            error.message === "ChatGPT browser turn cancelled" &&
            error.cause === undefined,
        );
        await headers;
        if (!abortAtHeaders) {
          // A page round trip lets the composer enter its clone observation,
          // which cannot finish while this real local HTTPS response stays open.
          await page.evaluate(() => document.title);
          controller.abort("PRIVATE body abort");
        }
        await rejected;
        assert.equal(page.isClosed(), true);
        assert.equal(context.pages().length, 0);
      }
      assert.equal(conversations, 2);
      await Promise.all(closedConnections);
      assert.equal(closedConnections.length, 2);
    } finally {
      await browser?.close();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
