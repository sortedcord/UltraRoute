import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import {
  executeChatGptWebFirstPartyTurn,
  fetchChatGptWebModels,
  getChatGptWebAccountIdentity,
  initializeChatGptWebFirstPartyBridge,
  requireChatGptWebUploadUrl,
} from "../../src/providers/chatgpt/firstParty.ts";
import {
  ChallengeRequiredError,
  CredentialError,
  InvalidRequestError,
  ProviderTimeoutError,
  RateLimitError,
  UpstreamDriftError,
} from "../../src/shared/errors.ts";

describe(
  "ChatGPT native in-page runtime",
  { skip: process.env.RUN_BROWSER_TESTS !== "1" },
  () => {
    let browser: Browser;
    before(async () => {
      browser = await chromium.launch({
        executablePath:
          process.env.CHATGPT_CHROMIUM_PATH || "/usr/bin/chromium",
        headless: true,
        args: ["--no-sandbox"],
      });
    });
    after(async () => {
      await browser?.close();
    });

    // This is an executable native-module shape, not a production ID/source snapshot.
    const runtimeFixture = `
export function __webpack_require__(id) { throw new Error('Dormant factory executed: ' + id); }
const Request = {
  async safeGet(path, options) {
    const response = await fetch('/backend-api'+path, {signal:options.signal});
    if (!response.ok) { const error = new Error('PRIVATE_RESPONSE'); error.status = response.status; throw error; }
    return response.json();
  },
  async safePost(path, options) {
    const response = await fetch('/backend-api'+path, {method:'POST',body:JSON.stringify(options.requestBody),signal:options.signal});
    if (!response.ok) { const error = new Error('PRIVATE_RESPONSE'); error.status = response.status; throw error; }
    return response.json();
  },
  async postResponse(path, options) {
    return fetch('/backend-api'+path, {method:'POST',headers:options.additionalHeaders,body:JSON.stringify(options.requestBody),signal:options.signal});
  }
};
async function nativeIntegrity(callback) {
  const chatRequirements = await callback('native-payload');
  return {chatRequirements,headers:{'x-native-integrity':chatRequirements.token}};
}
__webpack_require__.c = { 'api-new': {exports: {Request}}, 'integrity-new': {exports:{renamed:nativeIntegrity}}, 'decoy': {exports:{object:{headers:true}}} };
__webpack_require__.m = {
  'requirements-caller': function(a,b,loader) { const x=loader('api-new'), y=loader('integrity-new'); return x.Request.safePost('/sentinel/chat-requirements/prepare',{}); },
  'integrity-new': function() { throw new Error('Chat requirements returned a non-object response.'); },
  'dormant': function() { throw new Error('DORMANT_EXECUTED'); }
};
`;
    async function fixturePage(source = runtimeFixture) {
      const page = await browser.newPage();
      let assetImports = 0;
      await page.route("**/*", (route) => route.abort());
      await page.route("https://chatgpt.com/**", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === "/")
          return route.fulfill({
            contentType: "text/html",
            body: `<script id="client-bootstrap" type="application/json">{"authStatus":"logged_in","session":{"accessToken":"fixture-not-a-credential","user":{"id":"fixture-user"},"account":{"id":"fixture-workspace"}}}</script><script>window.__reactRouterManifest={entry:{imports:['https://evil.test/secret.js','https://private@chatgpt.com/cdn/assets/x.js','https://chatgpt.com/cdn/assets/app.runtime.123.js']}}</script>`,
          });
        if (pathname === "/cdn/assets/app.runtime.123.js") {
          assetImports++;
          return route.fulfill({
            contentType: "application/javascript",
            body: source,
          });
        }
        if (pathname === "/backend-api/sentinel/chat-requirements/prepare") {
          assert.deepEqual(route.request().postDataJSON(), {
            p: "native-payload",
          });
          return route.fulfill({ json: { token: "fixture-integrity" } });
        }
        return route.abort();
      });
      await page.goto("https://chatgpt.com/");
      return { page, imports: () => assetImports };
    }
    const turn = (
      page: Page,
      selection: Parameters<
        typeof executeChatGptWebFirstPartyTurn
      >[1]["selection"] = {
        model: "opaque-future-native-slug",
        thinkingEffort: "opaque-future-effort",
      },
      signal?: AbortSignal,
    ) =>
      executeChatGptWebFirstPartyTurn(
        page,
        { prompt: "fixture prompt", selection, attachments: [] },
        { signal },
      );

    test("loaded native runtime forwards opaque selection unchanged with temporary-chat flags", async () => {
      const fixture = await fixturePage();
      const selections = [
        {
          model: "opaque-future-native-slug",
          thinkingEffort: "opaque-future-effort",
        },
        { model: "native-slug-with-no-derived-effort" },
      ];
      let count = 0;
      await fixture.page.route(
        "**/backend-api/f/conversation",
        async (route) => {
          const selection = selections[count++];
          const body = route.request().postDataJSON();
          assert.equal(
            route.request().headers()["x-native-integrity"],
            "fixture-integrity",
          );
          assert.equal(body.model, selection.model);
          assert.equal(
            body.thinking_effort,
            "thinkingEffort" in selection
              ? selection.thinkingEffort
              : undefined,
          );
          assert.deepEqual(body.system_hints, []);
          assert.equal(body.history_and_training_disabled, true);
          assert.equal(body.is_do_not_remember, true);
          assert.equal(body.temporary_chat_requests_personalization, false);
          assert.deepEqual(body.messages[0].content.parts, ["fixture prompt"]);
          await route.fulfill({
            contentType: "text/event-stream",
            body: `data: {"answer":"turn-${count}"}\n\ndata: [DONE]\n\n`,
          });
        },
      );
      try {
        await Promise.all([
          initializeChatGptWebFirstPartyBridge(fixture.page),
          initializeChatGptWebFirstPartyBridge(fixture.page),
        ]);
        for (const selection of selections)
          assert.match(
            await turn(fixture.page, selection),
            new RegExp(`turn-${count}`),
          );
        assert.equal(count, selections.length);
        assert.equal(fixture.imports(), 1);
      } finally {
        await fixture.page.close();
      }
    });

    test("native catalog GET uses the loaded request client and separates user and workspace identity", async () => {
      const fixture = await fixturePage();
      const catalog = {
        models: [
          { slug: "opaque-future-native-slug", extra: { untouched: true } },
        ],
        default_model: "opaque-future-native-slug",
      };
      let calls = 0;
      await fixture.page.route("**/backend-api/models", async (route) => {
        calls++;
        assert.equal(route.request().method(), "GET");
        assert.equal(route.request().postData(), null);
        await route.fulfill({ json: catalog });
      });
      try {
        assert.equal(
          await getChatGptWebAccountIdentity(fixture.page),
          JSON.stringify(["fixture-user", "fixture-workspace"]),
        );
        assert.deepEqual(await fetchChatGptWebModels(fixture.page), catalog);
        await fixture.page.evaluate(() => {
          document.getElementById("client-bootstrap")!.textContent =
            JSON.stringify({
              authStatus: "logged_in",
              session: {
                accessToken: "rotated-PRIVATE",
                user: { id: "fixture-user" },
                account: { id: "different-workspace" },
              },
            });
        });
        assert.equal(
          await getChatGptWebAccountIdentity(fixture.page),
          JSON.stringify(["fixture-user", "different-workspace"]),
        );
        assert.equal(calls, 1);
        assert.equal(fixture.imports(), 1);
      } finally {
        await fixture.page.close();
      }
    });

    test("catalog identity mismatches reject before a GET without disclosing account identifiers", async () => {
      const { page } = await fixturePage();
      let calls = 0;
      await page.route("**/backend-api/models", (route) => {
        calls++;
        return route.fulfill({ json: { models: [{ slug: "unexpected" }] } });
      });
      try {
        for (const expectedIdentity of [
          JSON.stringify(["different-user-PRIVATE", "fixture-workspace"]),
          JSON.stringify(["fixture-user", "different-workspace-PRIVATE"]),
        ]) {
          await assert.rejects(
            fetchChatGptWebModels(page, undefined, expectedIdentity),
            (error: unknown) => {
              assert(error instanceof CredentialError);
              assert.equal(error.details?.status, 401);
              assert(!JSON.stringify(error).includes("PRIVATE"));
              assert(!JSON.stringify(error).includes("fixture-user"));
              return true;
            },
          );
        }
        assert.equal(calls, 0);
      } finally {
        await page.close();
      }
    });

    test("a workspace switch during model discovery discards the response and permits a fresh account fetch", async () => {
      const { page } = await fixturePage();
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      let calls = 0;
      await page.route("**/backend-api/models", async (route) => {
        calls++;
        if (calls === 1) {
          started.resolve();
          await finish.promise;
        }
        await route.fulfill({
          json: {
            models: [
              {
                slug:
                  calls === 1
                    ? "stale-workspace-catalog"
                    : "new-workspace-catalog",
              },
            ],
          },
        });
      });
      try {
        const expectedIdentity = await getChatGptWebAccountIdentity(page);
        const pending = fetchChatGptWebModels(
          page,
          undefined,
          expectedIdentity,
        );
        const rejected = assert.rejects(pending, (error: unknown) => {
          assert(error instanceof CredentialError);
          assert.equal(error.details?.status, 401);
          assert(!JSON.stringify(error).includes("PRIVATE"));
          assert(!JSON.stringify(error).includes("stale-workspace-catalog"));
          return true;
        });
        await started.promise;
        await page.evaluate(() => {
          document.getElementById("client-bootstrap")!.textContent =
            JSON.stringify({
              authStatus: "logged_in",
              session: {
                accessToken: "PRIVATE",
                user: { id: "fixture-user" },
                account: { id: "new-workspace-PRIVATE" },
              },
            });
        });
        finish.resolve();
        await rejected;
        const newIdentity = await getChatGptWebAccountIdentity(page);
        assert.deepEqual(
          await fetchChatGptWebModels(page, undefined, newIdentity),
          { models: [{ slug: "new-workspace-catalog" }] },
        );
        assert.equal(calls, 2);
      } finally {
        finish.resolve();
        await page.close();
      }
    });

    test("catalog discovery rejects logged-out or incomplete account identity without exposing bootstrap data", async () => {
      const { page } = await fixturePage();
      try {
        for (const bootstrap of [
          {
            authStatus: "logged_out",
            session: {
              accessToken: "PRIVATE",
              user: { id: "user" },
              account: { id: "workspace" },
            },
          },
          {
            authStatus: "logged_in",
            session: { accessToken: "PRIVATE", user: { id: "user" } },
          },
        ]) {
          await page.evaluate((value) => {
            document.getElementById("client-bootstrap")!.textContent =
              JSON.stringify(value);
          }, bootstrap);
          await assert.rejects(
            getChatGptWebAccountIdentity(page),
            (error: unknown) => {
              assert(error instanceof CredentialError);
              assert(!JSON.stringify(error).includes("PRIVATE"));
              return true;
            },
          );
        }
      } finally {
        await page.close();
      }
    });

    test("native model fetch classifies upstream errors and recovers for the next request", async () => {
      const { page } = await fixturePage();
      try {
        for (const [status, ErrorType] of [
          [401, CredentialError],
          [403, ChallengeRequiredError],
          [429, RateLimitError],
          [504, ProviderTimeoutError],
        ] as const) {
          await page.route("**/backend-api/models", (route) =>
            route.fulfill({ status, body: "PRIVATE_RESPONSE SECRET" }),
          );
          await assert.rejects(
            fetchChatGptWebModels(page),
            (error: unknown) => {
              assert(error instanceof ErrorType);
              assert(!JSON.stringify(error).includes("PRIVATE_RESPONSE"));
              assert(!JSON.stringify(error).includes("SECRET"));
              return true;
            },
          );
          await page.unroute("**/backend-api/models");
        }
        await page.route("**/backend-api/models", (route) =>
          route.fulfill({
            json: { models: [{ slug: "recovered-native-slug" }] },
          }),
        );
        assert.deepEqual(await fetchChatGptWebModels(page), {
          models: [{ slug: "recovered-native-slug" }],
        });
      } finally {
        await page.close();
      }
    });

    test("cancelling native model discovery aborts the client signal and allows a later fetch", async () => {
      const { page } = await fixturePage();
      const started = Promise.withResolvers<void>();
      await page.exposeFunction("notifyModelsStarted", () => started.resolve());
      try {
        await page.evaluate(async (url) => {
          // The fixture intentionally loads the deployment-selected browser module boundary.
          const namespace = await import(url);
          const client =
            namespace.__webpack_require__.c["api-new"].exports.Request;
          const root = globalThis as typeof globalThis & {
            notifyModelsStarted(): void;
            modelsAborted?: boolean;
          };
          let requests = 0;
          client.safeGet = async (
            _path: string,
            options: { signal: AbortSignal },
          ) => {
            if (++requests > 1) return { models: [{ slug: "after-abort" }] };
            const stopped = Promise.withResolvers<unknown>();
            options.signal.addEventListener(
              "abort",
              () => {
                root.modelsAborted = true;
                stopped.reject(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
            root.notifyModelsStarted();
            return stopped.promise;
          };
        }, "https://chatgpt.com/cdn/assets/app.runtime.123.js");
        const controller = new AbortController();
        const pending = fetchChatGptWebModels(page, controller.signal);
        const rejected = assert.rejects(pending, { name: "AbortError" });
        await started.promise;
        controller.abort();
        await rejected;
        assert.equal(
          await page.evaluate(
            () =>
              (globalThis as typeof globalThis & { modelsAborted?: boolean })
                .modelsAborted,
          ),
          true,
        );
        assert.deepEqual(await fetchChatGptWebModels(page), {
          models: [{ slug: "after-abort" }],
        });
      } finally {
        await page.close();
      }
    });

    test("native status and HTML challenge errors are typed and never expose page data", async () => {
      const { page } = await fixturePage();
      try {
        for (const [status, ErrorType] of [
          [401, CredentialError],
          [403, ChallengeRequiredError],
          [429, RateLimitError],
          [400, InvalidRequestError],
          [504, ProviderTimeoutError],
        ] as const) {
          await page.route("**/backend-api/f/conversation", (route) =>
            route.fulfill({
              status,
              body: "PRIVATE_RESPONSE signed-url=SECRET",
            }),
          );
          await assert.rejects(turn(page), (error: unknown) => {
            assert(error instanceof ErrorType);
            assert(!JSON.stringify(error).includes("SECRET"));
            assert(!error.message.includes("PRIVATE_RESPONSE"));
            assert.equal(error.cause, undefined);
            return true;
          });
          await page.unroute("**/backend-api/f/conversation");
        }
        await page.route("**/backend-api/f/conversation", (route) =>
          route.fulfill({ contentType: "text/html", body: "PRIVATE_RESPONSE" }),
        );
        await assert.rejects(turn(page), ChallengeRequiredError);
      } finally {
        await page.close();
      }
    });

    test("streams reject malformed UTF-8 and the byte bound while preserving Unicode", async () => {
      const { page } = await fixturePage();
      try {
        for (const [body, category] of [
          [Buffer.from([0xc3, 0x28]), "response-utf8"],
          [Buffer.alloc(16 * 1024 * 1024 + 1), "response-size"],
        ] as const) {
          await page.route("**/backend-api/f/conversation", (route) =>
            route.fulfill({ contentType: "text/event-stream", body }),
          );
          await assert.rejects(
            turn(page),
            (error: unknown) =>
              error instanceof UpstreamDriftError &&
              error.details?.category === category,
          );
          await page.unroute("**/backend-api/f/conversation");
        }
        await page.route("**/backend-api/f/conversation", (route) =>
          route.fulfill({
            contentType: "text/event-stream",
            body: "data: café 🌐\n\n",
          }),
        );
        assert.equal(await turn(page), "data: café 🌐\n\n");
      } finally {
        await page.close();
      }
    });

    test("response decoding preserves split Unicode bytes and abort cancels an active body reader", async () => {
      const { page } = await fixturePage();
      const bodyStarted = Promise.withResolvers<void>();
      await page.exposeFunction("notifyBodyStarted", () =>
        bodyStarted.resolve(),
      );
      try {
        await page.evaluate(async (runtimeUrl) => {
          // This deployment-selected module owns the native request shape.
          const namespace = await import(runtimeUrl);
          const client =
            namespace.__webpack_require__.c["api-new"].exports.Request;
          const original = client.postResponse.bind(client);
          const root = globalThis as typeof globalThis & {
            notifyBodyStarted(): void;
            fixtureCancelled?: boolean;
          };
          let conversation = 0;
          client.postResponse = async function (
            path: string,
            options: Record<string, unknown>,
          ) {
            if (path !== "/f/conversation") return original(path, options);
            conversation++;
            if (conversation === 2)
              return new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(
                      new TextEncoder().encode("data: partial"),
                    );
                    root.notifyBodyStarted();
                  },
                  cancel() {
                    root.fixtureCancelled = true;
                  },
                }),
              );
            const encoded = new TextEncoder().encode("data: café 🌐\n\n");
            return new Response(
              new ReadableStream({
                start(controller) {
                  for (const byte of encoded)
                    controller.enqueue(Uint8Array.of(byte));
                  controller.close();
                },
              }),
            );
          };
        }, "https://chatgpt.com/cdn/assets/app.runtime.123.js");
        assert.equal(await turn(page), "data: café 🌐\n\n");
        const controller = new AbortController();
        const pending = turn(page, undefined, controller.signal);
        await bodyStarted.promise;
        controller.abort();
        await assert.rejects(pending, { name: "AbortError" });
        assert.equal(
          await page.evaluate(
            () =>
              (globalThis as typeof globalThis & { fixtureCancelled?: boolean })
                .fixtureCancelled,
          ),
          true,
        );
        assert.equal(await turn(page), "data: café 🌐\n\n");
      } finally {
        await page.close();
      }
    });

    test("cached runtime readiness waits for native exports without executing dormant factories", async () => {
      const { page } = await fixturePage(
        runtimeFixture.replace("renamed:nativeIntegrity", "renamed:{}"),
      );
      const inspected = Promise.withResolvers<void>();
      await page.exposeFunction("notifyCacheInspection", () =>
        inspected.resolve(),
      );
      try {
        await page.evaluate(async (runtimeUrl) => {
          // The active manifest selects this module at runtime.
          const namespace = await import(runtimeUrl);
          const root = globalThis as typeof globalThis & {
            notifyCacheInspection(): void;
            fixtureIntegrity?: Function;
          };
          Object.defineProperty(
            namespace.__webpack_require__.c["integrity-new"].exports,
            "renamed",
            {
              enumerable: true,
              get() {
                root.notifyCacheInspection();
                return root.fixtureIntegrity ?? {};
              },
            },
          );
        }, "https://chatgpt.com/cdn/assets/app.runtime.123.js");
        const pending = initializeChatGptWebFirstPartyBridge(page);
        await inspected.promise;
        await page.evaluate(() => {
          const root = globalThis as typeof globalThis & {
            fixtureIntegrity?: Function;
          };
          root.fixtureIntegrity = async function (callback: Function) {
            const chatRequirements = await callback("native-payload");
            return { chatRequirements, headers: {} };
          };
        });
        await pending;
      } finally {
        await page.close();
      }
    });

    test("catalog readiness waits for safeGet before exposing the native bridge", async () => {
      const { page } = await fixturePage();
      const inspected = Promise.withResolvers<void>();
      await page.exposeFunction("notifyModelsClientInspection", () =>
        inspected.resolve(),
      );
      try {
        await page.evaluate(async (url) => {
          // This fixture exercises the deployment-selected runtime loading boundary.
          const namespace = await import(url);
          const client =
            namespace.__webpack_require__.c["api-new"].exports.Request;
          const root = globalThis as typeof globalThis & {
            notifyModelsClientInspection(): void;
            enableModelsClient?: () => void;
          };
          const original = client.safeGet;
          let ready = false;
          root.enableModelsClient = () => {
            ready = true;
          };
          Object.defineProperty(client, "safeGet", {
            configurable: true,
            get() {
              root.notifyModelsClientInspection();
              return ready ? original : undefined;
            },
          });
        }, "https://chatgpt.com/cdn/assets/app.runtime.123.js");
        let ready = false;
        const pending = initializeChatGptWebFirstPartyBridge(page).then(() => {
          ready = true;
        });
        await inspected.promise;
        assert.equal(ready, false);
        await page.evaluate(() =>
          (
            globalThis as typeof globalThis & {
              enableModelsClient?: () => void;
            }
          ).enableModelsClient?.(),
        );
        await pending;
        await page.route("**/backend-api/models", (route) =>
          route.fulfill({ json: { models: [{ slug: "ready-native-slug" }] } }),
        );
        assert.deepEqual(await fetchChatGptWebModels(page), {
          models: [{ slug: "ready-native-slug" }],
        });
      } finally {
        await page.close();
      }
    });

    test("logged-out bootstrap fails as a credential error before any native request", async () => {
      const { page } = await fixturePage();
      try {
        await page.evaluate(() => {
          document.getElementById("client-bootstrap")!.textContent =
            JSON.stringify({
              authStatus: "logged_out",
              session: { accessToken: "PRIVATE" },
            });
        });
        await assert.rejects(
          initializeChatGptWebFirstPartyBridge(page),
          (error: unknown) =>
            error instanceof CredentialError &&
            !JSON.stringify(error).includes("PRIVATE"),
        );
      } finally {
        await page.close();
      }
    });

    test("in-flight and queued cancellation reject promptly and preserve exclusive turn serialization", async () => {
      const { page } = await fixturePage();
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      let calls = 0;
      await page.route("**/backend-api/f/conversation", async (route) => {
        calls++;
        if (calls === 1) {
          started.resolve();
          await finish.promise;
        }
        await route
          .fulfill({
            contentType: "text/event-stream",
            body: "data: recovered\n\n",
          })
          .catch(() => {});
      });
      try {
        const active = new AbortController();
        const first = turn(page, undefined, active.signal);
        await started.promise;
        const queued = new AbortController();
        const second = turn(page, undefined, queued.signal);
        queued.abort();
        await assert.rejects(second, { name: "AbortError" });
        const third = turn(page);
        assert.equal(calls, 1);
        active.abort();
        await assert.rejects(first, { name: "AbortError" });
        finish.resolve();
        assert.equal(await third, "data: recovered\n\n");
        assert.equal(calls, 2);
      } finally {
        finish.resolve();
        await page.close();
      }
    });

    test("native attachment JSON registration and processing streams preserve privacy and upload order", async () => {
      const { page } = await fixturePage();
      const originalFetch = globalThis.fetch;
      const bytes = Buffer.from("fixture local document");
      const sequence: string[] = [];
      await page.route("**/backend-api/files", async (route) => {
        sequence.push("register");
        const body = route.request().postDataJSON();
        assert.equal(body.file_name, "fixture.txt");
        assert.equal(body.file_size, bytes.length);
        assert.equal(body.store_in_library, false);
        assert.equal(body.use_case, "my_files");
        await route.fulfill({
          json: {
            file_id: "native-file",
            upload_url:
              "https://files.oaiusercontent.com/upload?signature=fixture",
          },
        });
      });
      await page.route(
        "**/backend-api/files/process_upload_stream",
        async (route) => {
          sequence.push("process");
          const body = route.request().postDataJSON();
          assert.equal(body.file_id, "native-file");
          assert.equal(body.index_for_retrieval, true);
          assert.equal(body.metadata.is_temporary_chat, true);
          assert.equal(body.metadata.store_in_library, false);
          await route.fulfill({
            contentType: "text/event-stream",
            body: 'data: {"status":"ready"}\n\n',
          });
        },
      );
      await page.route("**/backend-api/f/conversation", async (route) => {
        sequence.push("conversation");
        const body = route.request().postDataJSON();
        assert.equal(
          body.messages[0].metadata.attachments[0].id,
          "native-file",
        );
        assert.equal(
          body.messages[0].metadata.attachments[0].size,
          bytes.length,
        );
        assert.equal(body.history_and_training_disabled, true);
        await route.fulfill({
          contentType: "text/event-stream",
          body: "data: document complete\n\n",
        });
      });
      // Signed PUT runs in Node, so intercept it explicitly; no external request is sent.
      globalThis.fetch = async (url, init) => {
        sequence.push("upload");
        assert.equal(
          String(url),
          "https://files.oaiusercontent.com/upload?signature=fixture",
        );
        assert.equal(init?.credentials, "omit");
        assert.equal(init?.redirect, "error");
        assert.equal(new Headers(init?.headers).get("cookie"), null);
        assert.equal(new Headers(init?.headers).get("authorization"), null);
        assert(init?.body instanceof Uint8Array);
        assert.deepEqual(Buffer.from(init.body), bytes);
        return new Response(null, { status: 201 });
      };
      try {
        assert.equal(
          await executeChatGptWebFirstPartyTurn(page, {
            prompt: "read the file",
            selection: { model: "opaque-attachment-native-slug" },
            attachments: [
              {
                kind: "file",
                name: "fixture.txt",
                mimeType: "text/plain",
                size: bytes.length,
                data: bytes,
              },
            ],
          }),
          "data: document complete\n\n",
        );
        assert.deepEqual(sequence, [
          "register",
          "upload",
          "process",
          "conversation",
        ]);
      } finally {
        globalThis.fetch = originalFetch;
        await page.close();
      }
    });

    test("signed upload destinations stay HTTPS and credential-free", () => {
      for (const url of [
        "invalid SECRET",
        "http://files.oaiusercontent.com/x",
        "https://evil-oaiusercontent.com/x",
        "https://oaiusercontent.com.evil.test/x",
        "https://SECRET@files.oaiusercontent.com/x",
        "https://files.oaiusercontent.com:8443/x",
        "https://files.oaiusercontent.com/x#SECRET",
      ]) {
        assert.throws(
          () => requireChatGptWebUploadUrl(url),
          (error: unknown) =>
            error instanceof UpstreamDriftError &&
            !error.message.includes("SECRET") &&
            error.cause === undefined,
        );
      }
      assert.equal(
        requireChatGptWebUploadUrl(
          "https://files.oaiusercontent.com/x?signature=fixture",
        ),
        "https://files.oaiusercontent.com/x?signature=fixture",
      );
    });
  },
);
