import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, rm, symlink } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  acquireChatGptProfile,
  validateChatGptProfile,
} from "../../src/providers/chatgpt/profile.ts";
import type { ChatGptProfileDeps } from "../../src/providers/chatgpt/profile.ts";
import {
  GenericUpstreamError,
  InvalidRequestError,
  CredentialError,
} from "../../src/shared/errors.ts";

test("dedicated profile rejects ordinary profile, relative paths, and symlink roots", async () => {
  await assert.rejects(
    validateChatGptProfile("relative-profile"),
    InvalidRequestError,
  );
  await assert.rejects(
    validateChatGptProfile(join(homedir(), ".config/chromium/Default")),
    InvalidRequestError,
  );
  const root = await mkdtemp(join(tmpdir(), "ultra-profile-"));
  try {
    await symlink(root, join(root, "link"));
    await assert.rejects(
      validateChatGptProfile(join(root, "link")),
      CredentialError,
    );
    const path = await validateChatGptProfile(join(root, "dedicated"));
    assert.equal((await stat(path)).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile lease prevents concurrent account context use and releases after failure/close", async () => {
  const path = await mkdtemp(join(tmpdir(), "ultra-profile-"));
  let closeHandler: (() => void) | undefined;
  const launch = async () => ({
    once: (_event: string, handler: () => void) => {
      closeHandler = handler;
    },
    close: async () => {
      closeHandler?.();
    },
  });
  try {
    const first = await acquireChatGptProfile(path, false, {
      launch: launch as any,
    });
    await assert.rejects(
      acquireChatGptProfile(path, false, { launch: launch as any }),
      GenericUpstreamError,
    );
    await first.close();
    const second = await acquireChatGptProfile(path, false, {
      launch: launch as any,
    });
    await second.close();
    await assert.rejects(
      acquireChatGptProfile(path, false, {
        launch: async () => {
          throw new Error("SECRET");
        },
      } as any),
      (error) =>
        error instanceof GenericUpstreamError &&
        !error.message.includes("SECRET"),
    );
    const third = await acquireChatGptProfile(path, false, {
      launch: launch as any,
    });
    await third.close();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("profile stays locked until asynchronous shutdown finishes and concurrent close joins it", async () => {
  const path = await mkdtemp(join(tmpdir(), "ultra-profile-"));
  let closeHandler: (() => void) | undefined;
  let finishShutdown!: () => void;
  let closeCalls = 0;
  const shutdown = new Promise<void>((resolve) => {
    finishShutdown = resolve;
  });
  const launch = async () => ({
    once: (_event: string, handler: () => void) => {
      closeHandler = handler;
    },
    close: async () => {
      closeCalls++;
      await shutdown;
    },
  });
  // The fake implements only the persistent-context lease surface under test.
  const injectedLaunch = launch as unknown as NonNullable<
    ChatGptProfileDeps["launch"]
  >;
  try {
    const lease = await acquireChatGptProfile(path, false, {
      launch: injectedLaunch,
    });
    closeHandler?.();
    const firstClose = lease.close();
    const secondClose = lease.close();
    assert.equal(firstClose, secondClose);
    await assert.rejects(
      acquireChatGptProfile(path, false, { launch: injectedLaunch }),
      GenericUpstreamError,
    );
    finishShutdown();
    await firstClose;
    assert.equal(closeCalls, 1);
    const next = await acquireChatGptProfile(path, false, {
      launch: injectedLaunch,
    });
    await next.close();
  } finally {
    finishShutdown();
    await rm(path, { recursive: true, force: true });
  }
});
