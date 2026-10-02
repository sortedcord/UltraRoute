import { chromium, type BrowserContext } from "playwright";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import {
  CredentialError,
  GenericUpstreamError,
  InvalidRequestError,
} from "../../shared/errors.ts";
import { CHATGPT_WEB_CONSTANTS } from "./constants.ts";
import { launchNativeChatGptBrowser } from "./nativeBrowser.ts";

export interface ChatGptProfileCredential {
  browserProfile: string;
}
export interface ChatGptProfileLease {
  context: BrowserContext;
  close(): Promise<void>;
}
export interface ChatGptProfileDeps {
  launch?: typeof chromium.launchPersistentContext;
}
const activeProfiles = new Set<string>();

export function isChatGptProfileCredential(
  value: unknown,
): value is ChatGptProfileCredential {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as ChatGptProfileCredential).browserProfile === "string"
  );
}

/** Never take ownership of the operator's ordinary Chromium profile. */
export async function validateChatGptProfile(
  directory: string,
): Promise<string> {
  if (!isAbsolute(directory))
    throw new InvalidRequestError(
      "ChatGPT profile directory must be an absolute dedicated path",
    );
  const target = resolve(directory);
  const defaultProfile = resolve(homedir(), ".config/chromium");
  const child = relative(defaultProfile, target);
  const parent = relative(target, defaultProfile);
  if (
    !child ||
    (!child.startsWith("..") && !isAbsolute(child)) ||
    (!parent.startsWith("..") && !isAbsolute(parent))
  )
    throw new InvalidRequestError(
      "Use a dedicated ChatGPT profile, not the ordinary Chromium profile or its parent directories",
    );
  try {
    await mkdir(target, { recursive: true, mode: 0o700 });
    const info = await lstat(target);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Invalid directory ownership");
    const canonical = await realpath(target);
    const ordinary = existsSync(defaultProfile)
      ? await realpath(defaultProfile)
      : defaultProfile;
    const within = relative(ordinary, canonical);
    const above = relative(canonical, ordinary);
    if (
      !within ||
      (!within.startsWith("..") && !isAbsolute(within)) ||
      (!above.startsWith("..") && !isAbsolute(above))
    )
      throw new Error("Ordinary browser profile");
    await chmod(canonical, 0o700);
    return canonical;
  } catch {
    throw new CredentialError(
      "ChatGPT dedicated profile is inaccessible or unsafe",
    );
  }
}

/** The owned native Chromium process persists account/browser state before release. */
export async function acquireChatGptProfile(
  directory: string,
  headed = false,
  deps: ChatGptProfileDeps = {},
): Promise<ChatGptProfileLease> {
  const path = await validateChatGptProfile(directory);
  if (activeProfiles.has(path))
    throw new GenericUpstreamError(
      "ChatGPT profile is already in use; close session preparation before sending a request",
      503,
      false,
    );
  activeProfiles.add(path);
  let lease: ChatGptProfileLease;
  try {
    if (deps.launch) {
      const context = await deps.launch(path, {
        executablePath:
          process.env.CHATGPT_CHROMIUM_PATH ||
          (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
        headless: headed
          ? false
          : process.env.CHATGPT_WEB_HEADLESS === "1" || !process.env.DISPLAY,
        timeout: CHATGPT_WEB_CONSTANTS.BROWSER_ACQUIRE_TIMEOUT_MS,
      });
      lease = { context, close: () => context.close() };
    } else {
      lease = await launchNativeChatGptBrowser(path, headed);
    }
  } catch {
    activeProfiles.delete(path);
    throw new GenericUpstreamError(
      "ChatGPT profile browser could not start; close other windows using this dedicated profile and check Chromium/display settings",
      503,
      false,
    );
  }
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= Promise.resolve()
      .then(() => lease.close())
      .finally(() => activeProfiles.delete(path));
    return closing;
  };
  lease.context.once("close", () => {
    void close().catch(() => {});
  });
  return { context: lease.context, close };
}
