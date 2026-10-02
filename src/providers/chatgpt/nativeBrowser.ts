import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { CHATGPT_WEB_CONSTANTS } from "./constants.ts";

export interface NativeBrowserLease {
  context: BrowserContext;
  close(): Promise<void>;
}

const SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_STDERR_LINE_BYTES = 32 * 1024;

function loopbackEndpoint(
  line: string,
  expectedPort: number,
): string | undefined {
  const match = /^DevTools listening on (\S+)\s*$/.exec(line);
  if (!match) return undefined;
  const endpoint = new URL(match[1]!);
  const port = Number(endpoint.port);
  if (
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    port !== expectedPort ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(endpoint.pathname)
  )
    throw new Error("Chromium did not provide a loopback debugging endpoint");
  return endpoint.href;
}

/** Start an ordinary, owned Chromium process and attach to its existing context. */
export async function launchNativeChatGptBrowser(
  profile: string,
  headed = false,
): Promise<NativeBrowserLease> {
  const headless = headed
    ? false
    : process.env.CHATGPT_WEB_HEADLESS === "1" || !process.env.DISPLAY;
  // A normal nonzero debugging port preserves Chromium's native defaults;
  // Chromium's special port=0 mode itself enables navigator.webdriver.
  const listener = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    listener.once("error", () => {
      reject(
        new Error("Could not allocate a loopback Chromium debugging port"),
      );
    });
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      listener.close((error) => {
        if (error || !address || typeof address === "string")
          reject(
            new Error("Could not allocate a loopback Chromium debugging port"),
          );
        else resolve(address.port);
      });
    });
  });
  const args = [
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
  ];
  if (headless) args.push("--headless=new");
  const child = spawn(
    process.env.CHATGPT_CHROMIUM_PATH || "/usr/bin/chromium",
    args,
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    const finish = () => {
      exited = true;
      resolve();
    };
    child.once("exit", finish);
    child.on("error", () => {
      if (!child.pid) finish();
    });
  });
  let browser: Browser | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= Promise.resolve().then(async () => {
      // Chromium must finish writing the profile before its lease is released.
      if (!exited) {
        child.kill("SIGTERM");
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            exit,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (!exited) child.kill("SIGKILL");
        await exit;
      }
      // For connectOverCDP this disconnects our connection; only the owned PID
      // above is signalled, never an unrelated browser using the same profile.
      await browser?.close().catch(() => {});
    });
    return closing;
  };
  const deadline =
    Date.now() + CHATGPT_WEB_CONSTANTS.BROWSER_ACQUIRE_TIMEOUT_MS;
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let pending = "";
      let settled = false;
      const finish = (value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stderr?.off("data", onData);
        child.off("exit", onExit);
        child.off("error", onExit);
        child.stderr?.resume();
        if (value) resolve(value);
        else
          reject(new Error("Chromium could not start its debugging endpoint"));
      };
      const onExit = () => finish();
      const onData = (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          try {
            const value = loopbackEndpoint(line, port);
            if (value) {
              finish(value);
              return;
            }
          } catch {
            finish();
            return;
          }
        }
        if (pending.length > MAX_STDERR_LINE_BYTES) finish();
      };
      const timer = setTimeout(onExit, Math.max(1, deadline - Date.now()));
      child.stderr?.on("data", onData);
      child.once("exit", onExit);
      child.once("error", onExit);
      if (exited) finish();
    });
    if (exited || Date.now() >= deadline)
      throw new Error(
        "Chromium exited before the browser connection was ready",
      );
    browser = await chromium.connectOverCDP(endpoint, {
      timeout: Math.max(1, deadline - Date.now()),
    });
    const context = browser.contexts()[0];
    if (!context || exited || closing)
      throw new Error(
        "Chromium did not provide its persistent browser context",
      );
    context.once("close", () => {
      void close().catch(() => {});
    });
    browser.once("disconnected", () => {
      void close().catch(() => {});
    });
    void exit.then(close).catch(() => {});
    return { context, close };
  } catch {
    await close();
    throw new Error(
      "ChatGPT profile browser could not start; close other windows using this dedicated profile and check Chromium/display settings",
    );
  }
}
