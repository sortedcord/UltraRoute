import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import {
  chromium,
  type Browser,
  type BrowserContextOptions,
  type CDPSession,
  type Locator,
  type Page,
} from "playwright";

const browserTest = { skip: process.env.RUN_BROWSER_TESTS !== "1" };
const mobileViewport: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
};
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/dist/bundle.js"></script></body></html>`;
const chatgptCatalog = {
  models: ["5.6", "5.5"].map((version) => ({
    id: `chatgpt-web:${version}`,
    name: `GPT-${version} Sol`,
    disabled: false,
    reasoningLevels: [
      {
        value: "none",
        label: "Instant",
        model: `fixture-${version}-instant`,
        disabled: false,
      },
      {
        value: "medium",
        label: "Medium",
        model: `fixture-${version}-thinking`,
        thinkingEffort: "standard",
        disabled: false,
      },
      {
        value: "high",
        label: "High",
        model: `fixture-${version}-thinking`,
        thinkingEffort: "extended",
        disabled: false,
      },
      {
        value: "max",
        label: "Locked preset",
        model: `fixture-${version}-locked`,
        disabled: true,
      },
    ],
    defaultReasoningLevel: "none",
  })),
  defaultModel: "chatgpt-web:5.6",
};
const geminiCatalog = {
  models: [
    {
      id: "gemini-web:account-default",
      name: "Gemini Web Account Default",
      disabled: false,
      availability: "Available",
    },
  ],
  defaultModel: "gemini-web:account-default",
};

async function withWorkspace(
  run: (
    openPage: (options: BrowserContextOptions) => Promise<Page>,
  ) => Promise<void>,
) {
  // Exercise the production entry point, not a separately mounted test component.
  const bundle = await readFile(
    new URL("../../dist/bundle.js", import.meta.url),
  );
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/dist/bundle.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(bundle);
      return;
    } else if (path === "/api/providers/chatgpt-web/models") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(chatgptCatalog));
    } else if (
      path === "/api/providers/claude-web/models" ||
      path === "/api/providers/gemini-web/models"
    ) {
      // Gemini Web remains discovery-backed; empty catalogs expose no API fallback.
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          path.includes("gemini-web") ? geminiCatalog : { models: [] },
        ),
      );
    } else if (path.startsWith("/api/")) {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ error: "Provider unavailable in UI regression" }),
      );
    } else if (path === "/") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(html);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  let browser: Browser | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({
      executablePath:
        process.env.CHATGPT_CHROMIUM_PATH ||
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
      headless: true,
    });
    const runningBrowser = browser;
    await run(async (options) => {
      const context = await runningBrowser.newContext({
        ...options,
        reducedMotion: "no-preference",
        serviceWorkers: "block",
      });
      // No fonts, provider traffic or other requests may leave the local fixture.
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin
          ? route.continue()
          : route.abort(),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(8_000);
      await page.goto(origin);
      await page.getByRole("button", { name: /^Select model:/ }).waitFor();
      return page;
    });
  } finally {
    try {
      await browser?.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  assert.ok(box, "surface must have visible geometry");
  return box;
}

function near(actual: number, expected: number, message: string) {
  assert.ok(
    Math.abs(actual - expected) < 3,
    `${message}: ${actual} vs ${expected}`,
  );
}

async function frame(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function touch(
  session: CDPSession,
  page: Page,
  type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
  x = 0,
  y = 0,
) {
  // CDP delivers trusted native touch/pointer events, including pointer capture.
  await session.send("Input.dispatchTouchEvent", {
    type,
    touchPoints:
      type === "touchEnd" || type === "touchCancel"
        ? []
        : [{ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
  });
  await frame(page);
}

async function moveTouch(
  session: CDPSession,
  page: Page,
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  for (let step = 1; step <= 4; step++) {
    await touch(
      session,
      page,
      "touchMove",
      start.x + ((end.x - start.x) * step) / 4,
      start.y + ((end.y - start.y) * step) / 4,
    );
  }
}

async function openSheet(page: Page, name: string) {
  const dialog = page.getByRole("dialog", { name, exact: true });
  await dialog.waitFor();
  await page.waitForFunction((label) => {
    const dialog = Array.from(document.querySelectorAll("dialog")).find(
      (element) => element.getAttribute("aria-label") === label,
    );
    const sheet = dialog?.querySelector(".pf-mobile-drawer-sheet");
    return (
      dialog?.matches(":modal") &&
      sheet &&
      Math.abs(sheet.getBoundingClientRect().bottom - innerHeight) < 1
    );
  }, name);
  const sheet = dialog.locator(".pf-mobile-drawer-sheet");
  const box = await bounds(sheet);
  near(box.x, 0, "sheet reaches left viewport edge");
  near(box.width, 390, "sheet spans viewport width");
  near(box.y + box.height, 844, "sheet is bottom-aligned");
  return { dialog, sheet, box };
}

async function assertChatCannotFocus(page: Page, dialog: Locator) {
  await page
    .getByRole("textbox", { name: "Message", includeHidden: true })
    .evaluate((element) => {
      (element as HTMLElement).focus();
    });
  assert.equal(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
    true,
  );
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
    true,
  );
}

async function waitForSheetClosed(page: Page, opener: Locator) {
  await page.waitForFunction(
    () => !document.querySelector(".pf-mobile-drawer"),
  );
  assert.equal(
    await opener.evaluate((element) => element === document.activeElement),
    true,
  );
}

test(
  "mobile drawers slide into view without autofocus scrolling or reversing position",
  browserTest,
  async () => {
    await withWorkspace(async (openPage) => {
      const page = await openPage(mobileViewport);
      for (const opener of [
        page.getByRole("button", { name: /^Select model:/ }),
        page.getByRole("button", { name: "Open add menu", exact: true }),
      ]) {
        await page.evaluate(() => {
          const samples: { top: number; bottom: number; scroll: number }[] = [];
          const started = performance.now();
          const captured = new Promise<typeof samples>((resolve) => {
            function sample() {
              const dialog =
                document.querySelector<HTMLDialogElement>(".pf-mobile-drawer");
              const sheet = dialog?.querySelector(".pf-mobile-drawer-sheet");
              if (dialog?.open && sheet) {
                const rect = sheet.getBoundingClientRect();
                samples.push({
                  top: rect.top,
                  bottom: rect.bottom,
                  scroll: dialog.scrollTop,
                });
              }
              if (performance.now() - started < 600)
                requestAnimationFrame(sample);
              else resolve(samples);
            }
            requestAnimationFrame(sample);
          });
          Object.assign(window, { drawerOpening: captured });
        });
        await opener.click();
        const samples = await page.evaluate(() => {
          // This in-page promise is installed by the capture above, not external data.
          const captureWindow = window as unknown as {
            drawerOpening: Promise<
              { top: number; bottom: number; scroll: number }[]
            >;
          };
          return captureWindow.drawerOpening;
        });
        assert.ok(samples.length > 2, "capture intermediate opening positions");
        assert.ok(
          samples.every((sample) => sample.scroll === 0),
          "autofocus must not scroll the animated viewport",
        );
        assert.ok(
          samples.some((sample) => sample.top >= 844),
          "drawer begins below the visible viewport",
        );
        for (let index = 1; index < samples.length; index++) {
          assert.ok(
            samples[index].top <= samples[index - 1].top + 1,
            "opening never jumps back down",
          );
        }
        near(
          samples.at(-1)!.bottom,
          844,
          "opening finishes at the viewport bottom",
        );
        await page.keyboard.press("Escape");
        await waitForSheetClosed(page, opener);
      }
    });
  },
);

test(
  "mobile model sheet follows native drag, snaps back and dismisses; add options stay inline",
  browserTest,
  async () => {
    await withWorkspace(async (openPage) => {
      const page = await openPage(mobileViewport);
      const session = await page.context().newCDPSession(page);
      const modelOpener = page.getByRole("button", { name: /^Select model:/ });
      // Focusing before clicking also makes restoration deterministic on touch UAs.
      await modelOpener.focus();
      await modelOpener.click();
      const { dialog, sheet, box } = await openSheet(page, "Choose a model");
      await assertChatCannotFocus(page, dialog);
      await dialog
        .getByRole("menuitemradio", { name: /Gemini Web Account Default/ })
        .waitFor();
      const handle = await bounds(dialog.locator(".pf-mobile-drawer-handle"));
      const start = {
        x: handle.x + handle.width / 2,
        y: handle.y + handle.height / 2,
      };
      await touch(session, page, "touchStart", start.x, start.y);
      await moveTouch(session, page, start, { x: start.x, y: start.y + 42 });
      near(
        (await bounds(sheet)).y - box.y,
        42,
        "sheet tracks a held short drag",
      );
      assert.equal(
        await dialog.evaluate((element) => element.matches(":modal")),
        true,
      );
      await touch(session, page, "touchEnd");
      await page.waitForFunction((top) => {
        const sheet = document.querySelector(".pf-mobile-drawer-sheet");
        return sheet && Math.abs(sheet.getBoundingClientRect().top - top) < 1;
      }, box.y);
      assert.equal(
        await dialog.evaluate((element) => element.matches(":modal")),
        true,
      );

      await touch(session, page, "touchStart", start.x, start.y);
      await moveTouch(session, page, start, { x: start.x, y: start.y + 180 });
      near(
        (await bounds(sheet)).y - box.y,
        180,
        "sheet tracks a held dismissing drag",
      );
      await touch(session, page, "touchEnd");
      await waitForSheetClosed(page, modelOpener);

      const addOpener = page.getByRole("button", {
        name: "Open add menu",
        exact: true,
      });
      await addOpener.focus();
      await addOpener.click();
      const add = await openSheet(page, "Add to chat");
      await assertChatCannotFocus(page, add.dialog);
      const moreUploads = add.dialog.getByRole("menuitem", {
        name: "More uploads",
        exact: true,
      });
      await moreUploads.click();
      assert.equal(await moreUploads.getAttribute("aria-expanded"), "true");
      const uploads = add.dialog.getByRole("group", {
        name: "More uploads",
        exact: true,
      });
      await uploads
        .getByRole("menuitem", { name: "Add from Drive", exact: true })
        .waitFor();
      assert.equal(await page.locator(".pf-plus-flyout").count(), 0);
      const uploadBox = await bounds(uploads);
      const addBox = await bounds(add.sheet);
      assert.ok(
        uploadBox.x >= addBox.x &&
          uploadBox.x + uploadBox.width <= addBox.x + addBox.width,
      );
      await moreUploads.click();
      assert.equal(await moreUploads.getAttribute("aria-expanded"), "false");
      assert.equal(await uploads.count(), 0);
      await page.keyboard.press("Escape");
      await waitForSheetClosed(page, addOpener);
    });
  },
);

test(
  "navigation edge swipe tracks touch and rejects incomplete gestures without changing desktop menus",
  browserTest,
  async () => {
    await withWorkspace(async (openPage) => {
      const page = await openPage(mobileViewport);
      const session = await page.context().newCDPSession(page);
      const sidebar = page.locator("dialog.pf-mobile-navigation-dialog");
      const sidebarOpener = page.getByRole("button", {
        name: "Open sidebar",
        exact: true,
      });
      const start = { x: 8, y: 300 };
      const edge = await bounds(page.locator(".pf-mobile-navigation-edge"));
      near(edge.y, 0, "edge target starts at viewport top");
      near(edge.height, 844, "edge target reaches viewport bottom");
      await page.getByRole("textbox", { name: "Message" }).focus();

      const assertClosed = async () => {
        await page.waitForFunction(() => {
          const dialog = document.querySelector<HTMLDialogElement>(
            ".pf-mobile-navigation-dialog",
          );
          return dialog && !dialog.open;
        });
        assert.equal(
          await sidebarOpener.getAttribute("aria-expanded"),
          "false",
        );
      };
      const preview = async (distance: number) => {
        await touch(session, page, "touchStart", start.x, start.y);
        await moveTouch(session, page, start, {
          x: start.x + distance,
          y: start.y,
        });
        near(
          (await bounds(sidebar)).x,
          distance - 390,
          "navigation tracks held edge swipe",
        );
        assert.equal(
          await sidebar.evaluate((element) => element.matches(":modal")),
          false,
        );
        assert.equal(
          await sidebarOpener.getAttribute("aria-expanded"),
          "false",
        );
      };

      await preview(90);
      await touch(session, page, "touchEnd");
      await assertClosed();
      await preview(180);
      await touch(session, page, "touchCancel");
      await assertClosed();
      await touch(session, page, "touchStart", start.x, start.y);
      await moveTouch(session, page, start, { x: 12, y: 390 });
      await touch(session, page, "touchEnd");
      await assertClosed();

      await preview(150);
      await moveTouch(
        session,
        page,
        { x: start.x + 150, y: start.y },
        { x: start.x + 220, y: start.y },
      );
      near(
        (await bounds(sidebar)).x,
        220 - 390,
        "navigation keeps following later touch movement",
      );
      await touch(session, page, "touchEnd");
      await page.waitForFunction(() => {
        const dialog = document.querySelector(".pf-mobile-navigation-dialog");
        return (
          dialog?.matches(":modal") &&
          Math.abs(dialog.getBoundingClientRect().left) < 1
        );
      });
      const navigationBox = await bounds(sidebar.locator(".pf-sidebar"));
      near(navigationBox.x, 0, "navigation reaches viewport left");
      near(navigationBox.y, 0, "navigation reaches viewport top");
      near(navigationBox.width, 390, "navigation fills viewport width");
      near(navigationBox.height, 844, "navigation fills viewport height");
      await assertChatCannotFocus(page, sidebar);
      await page.keyboard.press("Escape");
      await assertClosed();
      await sidebarOpener.click();
      await sidebar
        .getByRole("button", { name: "Collapse sidebar", exact: true })
        .click();
      await assertClosed();

      const desktop = await openPage({
        viewport: { width: 1280, height: 844 },
      });
      await desktop.locator(".pf-topbar-title").waitFor({ state: "visible" });
      assert.ok((await bounds(desktop.locator(".pf-topbar-title"))).width > 0);
      assert.equal(
        await desktop
          .locator(
            ".pf-mobile-navigation-edge, .pf-mobile-navigation-dialog, .pf-mobile-drawer",
          )
          .count(),
        0,
      );
      const modelOpener = desktop.getByRole("button", {
        name: /^Select model:/,
      });
      await modelOpener.click();
      const modelMenu = desktop.getByRole("dialog", {
        name: "Choose a model",
        exact: true,
      });
      assert.equal(
        await modelMenu.evaluate((element) => element.matches(":modal")),
        false,
      );
      const modelBox = await bounds(modelMenu);
      const triggerBox = await bounds(modelOpener);
      near(
        modelBox.x + modelBox.width,
        triggerBox.x + triggerBox.width,
        "desktop model menu remains right-anchored",
      );
      near(
        modelBox.y + modelBox.height,
        triggerBox.y - 8,
        "desktop model menu stays above opener",
      );
      assert.ok(
        modelBox.width < 640,
        "desktop picker is compact, not a viewport sheet",
      );
      await desktop.keyboard.press("Escape");
      await modelMenu.waitFor({ state: "hidden" });
      const plusOpener = desktop.getByRole("button", {
        name: "Open add menu",
        exact: true,
      });
      await plusOpener.click();
      const plusBox = await bounds(
        desktop.getByRole("menu", { name: "Add to chat", exact: true }),
      );
      const plusTriggerBox = await bounds(
        desktop.getByRole("button", { name: "Close add menu", exact: true }),
      );
      near(
        plusBox.x,
        plusTriggerBox.x,
        "desktop add menu remains left-anchored",
      );
      near(
        plusBox.y + plusBox.height,
        plusTriggerBox.y - 8,
        "desktop add menu stays above opener",
      );
      assert.ok(
        plusBox.width < 640,
        "desktop add menu is compact, not a viewport sheet",
      );
      assert.equal(await desktop.locator("dialog:modal").count(), 0);
      await desktop.keyboard.press("Escape");
      await plusOpener.waitFor();
    });
  },
);

test(
  "discovered ChatGPT families expose only available presets and retain per-model choices",
  browserTest,
  async () => {
    await withWorkspace(async (openPage) => {
      const page = await openPage(mobileViewport);
      const requests: {
        model: string;
        provider: string;
        reasoning_effort: string;
      }[] = [];
      await page.route("**/api/chat", async (route) => {
        requests.push(route.request().postDataJSON());
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Fixture reply unavailable" }),
        });
      });
      const opener = page.getByRole("button", { name: /^Select model:/ });
      for (const [familyIndex, model] of chatgptCatalog.models.entries()) {
        for (const [presetIndex, preset] of model.reasoningLevels
          .filter((level) => !level.disabled)
          .entries()) {
          await opener.click();
          const dialog = page.getByRole("dialog", {
            name: "Choose a model",
            exact: true,
          });
          await dialog
            .getByRole("tab", { name: "OpenAI", exact: true })
            .click();
          await dialog
            .getByRole("menuitemradio", {
              name: `${model.name} Available`,
              exact: true,
            })
            .click();
          const slider = dialog.getByRole("slider", {
            name: "Reasoning level",
          });
          assert.equal(await slider.getAttribute("max"), "2");
          await slider.focus();
          await page.keyboard.press("Home");
          for (let step = 0; step < presetIndex; step++)
            await page.keyboard.press("ArrowRight");
          assert.equal(
            await slider.getAttribute("aria-valuetext"),
            preset.label,
          );
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden" });
          await page
            .getByRole("textbox", { name: "Message" })
            .fill(`Family ${familyIndex}, ${preset.label}`);
          await page
            .getByRole("button", { name: "Send message", exact: true })
            .click();
          await page
            .locator(".pf-runtime-error[role='alert']")
            .filter({ hasText: "Fixture reply unavailable" })
            .waitFor();
          const request = requests.at(-1);
          assert.ok(request, "the composer sends the selected model");
          assert.deepEqual(
            {
              model: request.model,
              provider: request.provider,
              reasoning_effort: request.reasoning_effort,
            },
            {
              model: model.id,
              provider: "chatgpt-web",
              reasoning_effort: preset.value,
            },
          );
        }
      }
      await opener.click();
      const dialog = page.getByRole("dialog", {
        name: "Choose a model",
        exact: true,
      });
      await dialog
        .getByRole("menuitemradio", {
          name: `${chatgptCatalog.models[0].name} Available`,
          exact: true,
        })
        .click();
      assert.equal(
        await dialog
          .getByRole("slider", { name: "Reasoning level" })
          .getAttribute("aria-valuetext"),
        "High",
      );
      await page.keyboard.press("Escape");
      let revisedCatalog = {
        ...chatgptCatalog,
        models: chatgptCatalog.models.map((model) => ({
          ...model,
          defaultReasoningLevel: "medium",
          reasoningLevels: model.reasoningLevels.filter(
            (level) => level.value !== "high",
          ),
        })),
      };
      await page.route("**/api/providers/chatgpt-web/models", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(revisedCatalog),
        }),
      );
      await Promise.all([
        page.waitForResponse("**/api/providers/chatgpt-web/models"),
        page.evaluate(() => window.dispatchEvent(new Event("focus"))),
      ]);
      await opener.click();
      const updatedSlider = dialog.getByRole("slider", {
        name: "Reasoning level",
      });
      await page.waitForFunction(
        () =>
          document
            .querySelector("input[aria-label='Reasoning level']")
            ?.getAttribute("aria-valuetext") === "Medium",
      );
      assert.equal(await updatedSlider.getAttribute("max"), "1");
      assert.equal(
        await updatedSlider.getAttribute("aria-valuetext"),
        "Medium",
      );
      await page.keyboard.press("Escape");
      revisedCatalog = {
        ...revisedCatalog,
        models: revisedCatalog.models.slice(1),
      };
      await Promise.all([
        page.waitForResponse("**/api/providers/chatgpt-web/models"),
        page.evaluate(() => window.dispatchEvent(new Event("focus"))),
      ]);
      await page
        .getByRole("button", {
          name: "Select model: Gemini Web Account Default",
          exact: true,
        })
        .waitFor();
      await opener.click();
      await dialog.getByRole("tab", { name: "Gemini", exact: true }).click();
      await dialog
        .getByRole("menuitemradio", {
          name: "Gemini Web Account Default Available",
          exact: true,
        })
        .waitFor();
      await dialog
        .getByRole("tab", { name: "Miscellaneous", exact: true })
        .click();
      assert.equal(await dialog.getByRole("menuitemradio").count(), 0);
      await dialog.getByRole("tab", { name: "OpenAI", exact: true }).click();
      await dialog
        .getByRole("menuitemradio", {
          name: `${chatgptCatalog.models[1].name} Available`,
          exact: true,
        })
        .waitFor();
      assert.equal(
        await dialog
          .getByRole("menuitemradio", {
            name: `${chatgptCatalog.models[0].name} Available`,
            exact: true,
          })
          .count(),
        0,
      );
      await page.keyboard.press("Escape");
    });
  },
);

test(
  "OpenAI discovery displays loading and errors without static fallback models",
  browserTest,
  async () => {
    await withWorkspace(async (openPage) => {
      const page = await openPage(mobileViewport);
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/api/providers/chatgpt-web/models", async (route) => {
        await pending;
        await route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ error: "Catalog unavailable" }),
        });
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: /^Select model:/ }).click();
      const dialog = page.getByRole("dialog", {
        name: "Choose a model",
        exact: true,
      });
      await dialog.getByRole("tab", { name: "OpenAI", exact: true }).click();
      await dialog
        .getByRole("status")
        .filter({ hasText: "Loading ChatGPT models" })
        .waitFor();
      release();
      await dialog
        .getByRole("alert")
        .filter({ hasText: "Catalog unavailable" })
        .waitFor();
      assert.equal(await dialog.getByRole("menuitemradio").count(), 0);
      await page.keyboard.press("Escape");
    });
  },
);
