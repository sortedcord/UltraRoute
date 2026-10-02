import { acquireChatGptProfile } from "../providers/chatgpt/profile.ts";
import { CHATGPT_WEB_CONSTANTS } from "../providers/chatgpt/constants.ts";

const directory = process.env.CHATGPT_BROWSER_PROFILE;
if (!directory) {
  console.error(
    "Set CHATGPT_BROWSER_PROFILE to an absolute dedicated directory outside the repository.",
  );
  process.exitCode = 1;
} else {
  try {
    const lease = await acquireChatGptProfile(directory, true);
    try {
      const page = lease.context.pages()[0] ?? (await lease.context.newPage());
      await page.goto(CHATGPT_WEB_CONSTANTS.TEMPORARY_CHAT_URL, {
        waitUntil: "domcontentloaded",
        timeout: CHATGPT_WEB_CONSTANTS.BROWSER_ACQUIRE_TIMEOUT_MS,
      });
      console.log(
        "Dedicated ChatGPT browser opened. Complete login or verification manually. No prompt will be submitted.",
      );
      console.log(
        "Close the browser when finished; then start UltraRoute with the same CHATGPT_BROWSER_PROFILE.",
      );
      const { promise, resolve } = Promise.withResolvers<void>();
      lease.context.once("close", () => resolve());
      const close = () => {
        void lease.close().finally(resolve);
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
      if (page.isClosed()) close();
      await promise;
      process.removeListener("SIGINT", close);
      process.removeListener("SIGTERM", close);
    } finally {
      await lease.close();
    }
    console.log(
      "Browser closed. Profile state retained locally; no credential values exported.",
    );
  } catch {
    console.error(
      "Session preparation failed. Check dedicated profile ownership, DISPLAY, Chromium path, and whether another browser has the profile open.",
    );
    process.exitCode = 1;
  }
}
