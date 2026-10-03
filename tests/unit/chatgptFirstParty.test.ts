import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import {
  executeChatGptWebFirstPartyTurn,
  fetchChatGptWebModels,
  getChatGptWebAccountIdentity,
  requireChatGptWebUploadUrl,
} from "../../src/providers/chatgpt/firstParty.ts";
import {
  UpstreamDriftError,
  CredentialError,
  RateLimitError,
  ChallengeRequiredError,
  ProviderTimeoutError,
} from "../../src/shared/errors.ts";

const key = "__ultrarouteChatGptFirstPartyV2";
const root = globalThis as typeof globalThis & Record<string, unknown>;
const input = {
  prompt: "fixture",
  selection: { model: "future-native-model", thinkingEffort: "opaque-effort" },
  attachments: [],
};
function fakePage(
  converse: (id: string, body: Record<string, unknown>) => Promise<string>,
  catalog: {
    identity?: () => string;
    models?: (id: string, signal: AbortSignal) => Promise<unknown>;
  } = {},
) {
  const controllers = new Map<string, AbortController>();
  root[key] = {
    requestClient: { safeGet() {}, safePost() {}, postResponse() {} },
    integrity() {},
    begin(id: string) {
      controllers.set(id, new AbortController());
    },
    abort(id: string) {
      controllers.get(id)?.abort();
    },
    cleanup(id: string) {
      controllers.delete(id);
    },
    register: async () => [],
    process: async () => {},
    converse,
    accountIdentity:
      catalog.identity ??
      (() => JSON.stringify(["fixture-user", "fixture-workspace"])),
    models: async (id: string) =>
      catalog.models
        ? catalog.models(id, controllers.get(id)!.signal)
        : { models: [{ slug: "future-native-model" }] },
  };
  const page = {
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
  } as unknown as Page;
  return { page, controllers };
}

test("catalog operations use a ready bridge and preserve account identity and upstream payload", async () => {
  const catalog = {
    models: [{ slug: "opaque-future-slug", reasoning: ["unusual-level"] }],
    default_model: "opaque-future-slug",
  };
  const { page, controllers } = fakePage(async () => "unused", {
    models: async () => catalog,
  });
  try {
    assert.equal(
      await getChatGptWebAccountIdentity(page),
      JSON.stringify(["fixture-user", "fixture-workspace"]),
    );
    assert.deepEqual(await fetchChatGptWebModels(page), catalog);
    assert.equal(controllers.size, 0);
  } finally {
    delete root[key];
  }
});

test("catalog failures classify logged-out, challenge, and rate-limit responses without disclosure", async () => {
  for (const [status, ErrorType] of [
    [401, CredentialError],
    [403, ChallengeRequiredError],
    [429, RateLimitError],
  ] as const) {
    const { page, controllers } = fakePage(async () => "unused", {
      models: async () => {
        throw { status, message: "SECRET", category: "PRIVATE" };
      },
    });
    try {
      await assert.rejects(fetchChatGptWebModels(page), (error: unknown) => {
        assert(error instanceof ErrorType);
        assert(!JSON.stringify(error).includes("SECRET"));
        assert(!JSON.stringify(error).includes("PRIVATE"));
        return true;
      });
      assert.equal(controllers.size, 0);
    } finally {
      delete root[key];
    }
  }
});

test("cancelling a model fetch aborts its native scope and releases serialization", async () => {
  const started = Promise.withResolvers<void>();
  let calls = 0;
  let nativeSignal: AbortSignal | undefined;
  const { page, controllers } = fakePage(async () => "unused", {
    models: async (_id, signal) => {
      if (++calls > 1) return { models: [{ slug: "after-cancellation" }] };
      nativeSignal = signal;
      started.resolve();
      const stopped = Promise.withResolvers<unknown>();
      signal.addEventListener(
        "abort",
        () => stopped.reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
      return stopped.promise;
    },
  });
  const controller = new AbortController();
  try {
    const fetching = fetchChatGptWebModels(page, controller.signal);
    const rejected = assert.rejects(fetching, { name: "AbortError" });
    await started.promise;
    controller.abort();
    await rejected;
    assert.equal(nativeSignal?.aborted, true);
    assert.equal(controllers.size, 0);
    assert.deepEqual(await fetchChatGptWebModels(page), {
      models: [{ slug: "after-cancellation" }],
    });
  } finally {
    delete root[key];
  }
});

test("an already cancelled model fetch does not open a native scope", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const { page, controllers } = fakePage(async () => "unused", {
    models: async () => {
      calls++;
      return {};
    },
  });
  try {
    await assert.rejects(fetchChatGptWebModels(page, controller.signal), {
      name: "AbortError",
    });
    assert.equal(calls, 0);
    assert.equal(controllers.size, 0);
  } finally {
    delete root[key];
  }
});

test("native error metadata is allowlisted without leaking upstream messages or arbitrary categories", async () => {
  for (const [failure, ErrorType] of [
    [{ status: 429, message: "SECRET", category: "PRIVATE" }, RateLimitError],
    [{ name: "TimeoutError", message: "SECRET" }, ProviderTimeoutError],
    [{ message: "turnstile SECRET" }, ChallengeRequiredError],
  ] as const) {
    const { page, controllers } = fakePage(async () => {
      throw failure;
    });
    try {
      await assert.rejects(
        executeChatGptWebFirstPartyTurn(page, input),
        (error: unknown) => {
          assert(error instanceof ErrorType);
          assert.equal(error.cause, undefined);
          assert(!JSON.stringify(error).includes("SECRET"));
          assert(!JSON.stringify(error).includes("PRIVATE"));
          return true;
        },
      );
      assert.equal(controllers.size, 0);
    } finally {
      delete root[key];
    }
  }
});

test("an already cancelled turn never opens a browser request scope", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const { page, controllers } = fakePage(async () => {
    calls++;
    return "unexpected";
  });
  try {
    await assert.rejects(
      executeChatGptWebFirstPartyTurn(page, input, {
        signal: controller.signal,
      }),
      { name: "AbortError" },
    );
    assert.equal(calls, 0);
    assert.equal(controllers.size, 0);
  } finally {
    delete root[key];
  }
});

test("signed upload destinations reject credentialed or hostile URLs without disclosure", () => {
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
