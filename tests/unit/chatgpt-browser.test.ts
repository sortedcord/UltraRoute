import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { chromium } from "playwright";
import {
  WarmChatGptBrowserManager,
  type BrowserSessionDeps,
} from "../../src/providers/chatgpt/browser.ts";
import {
  ChallengeRequiredError,
  ProviderTimeoutError,
} from "../../src/shared/errors.ts";
import type { ChatGptStorageState } from "../../src/providers/chatgpt/storageState.ts";

function credential(account: string): ChatGptStorageState {
  return {
    cookies: [
      {
        name: "__Secure-next-auth.session-token",
        value: account,
        domain: ".chatgpt.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ],
    origins: [],
  };
}
const input = {
  prompt: "fixture",
  attachments: [],
  selection: {
    model: "future-native-model",
    thinkingEffort: "opaque-effort",
  },
};

class FixturePage extends EventEmitter {
  closed = false;
  navigations = 0;
  status = 200;
  async addInitScript() {}
  async goto() {
    this.navigations++;
    return { status: () => this.status };
  }
  url() {
    return "https://chatgpt.com/?temporary-chat=true";
  }
  isClosed() {
    return this.closed;
  }
  async close() {
    this.closed = true;
    this.emit("close");
  }
}
function runtimeFixture(execute?: BrowserSessionDeps["execute"], status = 200) {
  let starts = 0;
  let stops = 0;
  const accounts: Array<{ pages: FixturePage[]; closed: boolean }> = [];
  const launch = async () => {
    starts++;
    return {
      newContext: async () => {
        const account = { pages: [] as FixturePage[], closed: false };
        accounts.push(account);
        return {
          newPage: async () => {
            const page = new FixturePage();
            page.status = status;
            account.pages.push(page);
            return page;
          },
          pages: () => account.pages.filter((page) => !page.closed),
          close: async () => {
            account.closed = true;
            for (const page of account.pages) await page.close();
          },
        };
      },
      close: async () => {
        stops++;
      },
    };
  };
  // The fixture models only browser ownership and page lifetime, not Playwright internals.
  const launchBrowser = launch as unknown as typeof chromium.launch;
  const deps: BrowserSessionDeps = {
    launch: launchBrowser,
    initialize: async () => {},
    execute: execute ?? (async () => "completed"),
    idleTimeoutMs: 60_000,
  };
  return { deps, accounts, counters: () => ({ starts, stops }) };
}

test("released turn leases reuse the authenticated page and keep accounts separate", async () => {
  const fixture = runtimeFixture();
  const manager = new WarmChatGptBrowserManager(fixture.deps);
  try {
    for (let turn = 0; turn < 2; turn++) {
      const session = await manager.createSession(credential("account-a"));
      assert.equal(await session.executeDirectTurn(input), "completed");
      await session.close?.();
    }
    assert.equal(fixture.accounts[0].pages.length, 1);
    assert.equal(fixture.accounts[0].pages[0].navigations, 1);
    assert.equal(fixture.accounts[0].closed, false);
    const other = await manager.createSession(credential("account-b"));
    await other.executeDirectTurn(input);
    await other.close?.();
    assert.equal(fixture.accounts.length, 2);
    assert.equal(fixture.counters().starts, 2);
  } finally {
    await manager.close();
  }
  assert.equal(fixture.counters().stops, 2);
});

test("a cancelled queued lease cannot overtake the active account turn", async () => {
  const fixture = runtimeFixture();
  const manager = new WarmChatGptBrowserManager(fixture.deps);
  const first = await manager.createSession(credential("same"));
  const controller = new AbortController();
  const second = manager.createSession(credential("same"), controller.signal);
  controller.abort();
  await assert.rejects(second, ProviderTimeoutError);
  let thirdAcquired = false;
  const thirdPromise = manager
    .createSession(credential("same"))
    .then((session) => {
      thirdAcquired = true;
      return session;
    });
  await delay(10);
  assert.equal(thirdAcquired, false);
  await first.close?.();
  const third = await thirdPromise;
  await third.close?.();
  await manager.close();
});

test("active cancellation closes only the execution page and the next turn reuses its browser", async () => {
  let calls = 0;
  const fixture = runtimeFixture(async (page, _input, { signal } = {}) => {
    calls++;
    if (calls > 1) return "next answer";
    return new Promise<string>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  });
  const manager = new WarmChatGptBrowserManager(fixture.deps);
  const controller = new AbortController();
  const session = await manager.createSession(credential("same"));
  const turn = session.executeDirectTurn(input, controller.signal);
  await delay(10);
  controller.abort();
  await assert.rejects(turn, ProviderTimeoutError);
  await session.close?.();
  assert.equal(fixture.accounts[0].pages[0].closed, true);
  assert.equal(fixture.accounts[0].closed, false);
  const next = await manager.createSession(credential("same"));
  assert.equal(await next.executeDirectTurn(input), "next answer");
  await next.close?.();
  assert.equal(fixture.counters().starts, 1);
  await manager.close();
});

test("idle expiry releases a profile runtime and the next request starts cleanly", async () => {
  const fixture = runtimeFixture();
  const manager = new WarmChatGptBrowserManager({
    ...fixture.deps,
    idleTimeoutMs: 5,
  });
  const session = await manager.createSession(credential("same"));
  await session.executeDirectTurn(input);
  await session.close?.();
  await delay(30);
  assert.equal(fixture.accounts[0].closed, true);
  const next = await manager.createSession(credential("same"));
  await next.executeDirectTurn(input);
  await next.close?.();
  assert.equal(fixture.counters().starts, 2);
  await manager.close();
});

test("shutdown interrupts active work, releases browser ownership, and rejects new leases", async () => {
  const fixture = runtimeFixture(
    async (_page, _input, { signal } = {}) =>
      new Promise<string>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  const manager = new WarmChatGptBrowserManager(fixture.deps);
  const session = await manager.createSession(credential("same"));
  const turn = session.executeDirectTurn(input);
  const rejected = assert.rejects(turn, ProviderTimeoutError);
  await delay(10);
  await manager.close();
  await rejected;
  assert.equal(fixture.accounts[0].closed, true);
  await assert.rejects(
    manager.createSession(credential("same")),
    ProviderTimeoutError,
  );
});

test("initial browser verification failures remain actionable and release owned resources", async () => {
  const fixture = runtimeFixture(undefined, 403);
  const manager = new WarmChatGptBrowserManager(fixture.deps);
  const session = await manager.createSession(credential("same"));
  await assert.rejects(
    session.executeDirectTurn(input),
    ChallengeRequiredError,
  );
  await session.close?.();
  await manager.close();
  assert.equal(fixture.counters().stops, 1);
});

test("requests arriving during idle browser shutdown wait until ownership is released", async () => {
  const fixture = runtimeFixture();
  const shutdownStarted = Promise.withResolvers<void>();
  const finishShutdown = Promise.withResolvers<void>();
  const originalLaunch = fixture.deps.launch!;
  let launches = 0;
  const manager = new WarmChatGptBrowserManager({
    ...fixture.deps,
    idleTimeoutMs: 1,
    launch: async (options) => {
      const browser = await originalLaunch(options);
      launches++;
      if (launches === 1) {
        const close = browser.close.bind(browser);
        browser.close = async () => {
          shutdownStarted.resolve();
          await finishShutdown.promise;
          await close();
        };
      }
      return browser;
    },
  });
  const first = await manager.createSession(credential("same"));
  await first.executeDirectTurn(input);
  await first.close?.();
  await delay(10);
  await shutdownStarted.promise;
  const nextPromise = manager.createSession(credential("same"));
  await delay(10);
  assert.equal(launches, 1);
  finishShutdown.resolve();
  const next = await nextPromise;
  await next.executeDirectTurn(input);
  await next.close?.();
  assert.equal(launches, 2);
  await manager.close();
});

test("catalog operations and turns reuse the same authenticated page", async () => {
  const pages: unknown[] = [];
  const fixture = runtimeFixture(async (page) => {
    pages.push(page);
    return "turn answer";
  });
  const catalog = { models: [{ slug: "future-native-model" }] };
  const manager = new WarmChatGptBrowserManager({
    ...fixture.deps,
    getIdentity: async (page) => {
      pages.push(page);
      return JSON.stringify(["user-a", "workspace-a"]);
    },
    fetchModels: async (page) => {
      pages.push(page);
      return catalog;
    },
  });
  try {
    assert.equal(
      await manager.getAccountIdentity(credential("same")),
      JSON.stringify(["user-a", "workspace-a"]),
    );
    assert.deepEqual(await manager.fetchModels(credential("same")), catalog);
    const turn = await manager.createSession(credential("same"));
    try {
      assert.equal(await turn.executeDirectTurn(input), "turn answer");
    } finally {
      await turn.close?.();
    }
    assert.deepEqual(pages, [
      fixture.accounts[0].pages[0],
      fixture.accounts[0].pages[0],
      fixture.accounts[0].pages[0],
    ]);
    assert.equal(fixture.accounts[0].pages[0].navigations, 1);
    assert.equal(fixture.counters().starts, 1);
  } finally {
    await manager.close();
  }
});

test("catalog fetches hold the account queue exclusively and release it on completion", async () => {
  const fixture = runtimeFixture();
  const started = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<unknown>();
  let identityCalls = 0;
  const manager = new WarmChatGptBrowserManager({
    ...fixture.deps,
    fetchModels: async () => {
      started.resolve();
      return complete.promise;
    },
    getIdentity: async () => {
      identityCalls++;
      return JSON.stringify(["user-a", "workspace-a"]);
    },
  });
  try {
    const fetching = manager.fetchModels(credential("same"));
    await started.promise;
    let turnAcquired = false;
    const identity = manager.getAccountIdentity(credential("same"));
    const turn = manager.createSession(credential("same")).then((session) => {
      turnAcquired = true;
      return session;
    });
    await delay(10);
    assert.equal(identityCalls, 0);
    assert.equal(turnAcquired, false);
    const catalog = { models: [{ slug: "opaque-native" }] };
    complete.resolve(catalog);
    assert.deepEqual(await fetching, catalog);
    assert.equal(await identity, JSON.stringify(["user-a", "workspace-a"]));
    const session = await turn;
    await session.close?.();
    assert.equal(turnAcquired, true);
    assert.equal(fixture.accounts[0].pages.length, 1);
  } finally {
    await manager.close();
  }
});

test("a cancelled queued catalog fetch cannot run or release an active turn", async () => {
  const fixture = runtimeFixture();
  let fetchCalls = 0;
  const manager = new WarmChatGptBrowserManager({
    ...fixture.deps,
    fetchModels: async () => {
      fetchCalls++;
      return {};
    },
  });
  const active = await manager.createSession(credential("same"));
  try {
    const controller = new AbortController();
    const fetching = manager.fetchModels(credential("same"), controller.signal);
    const rejected = assert.rejects(fetching, ProviderTimeoutError);
    controller.abort();
    await rejected;
    let acquired = false;
    const next = manager.createSession(credential("same")).then((session) => {
      acquired = true;
      return session;
    });
    await delay(10);
    assert.equal(fetchCalls, 0);
    assert.equal(acquired, false);
    await active.close?.();
    await (await next).close?.();
  } finally {
    await active.close?.();
    await manager.close();
  }
});

test("a failed catalog request releases its lease for the next account turn", async () => {
  const fixture = runtimeFixture();
  const manager = new WarmChatGptBrowserManager({
    ...fixture.deps,
    fetchModels: async () => {
      throw new ChallengeRequiredError("Operator verification required");
    },
  });
  try {
    await assert.rejects(
      manager.fetchModels(credential("same")),
      ChallengeRequiredError,
    );
    const next = await manager.createSession(credential("same"));
    try {
      assert.equal(await next.executeDirectTurn(input), "completed");
    } finally {
      await next.close?.();
    }
  } finally {
    await manager.close();
  }
});
