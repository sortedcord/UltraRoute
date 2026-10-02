import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.README_SCREENSHOT_BASE_URL ?? "http://127.0.0.1:3000";
const screenshotPath = process.env.README_SCREENSHOT_PATH ?? "docs/images/chat-workspace.png";
const readmePath = "README.md";
const screenshotStart = "<!-- README_SCREENSHOT_START -->";
const screenshotEnd = "<!-- README_SCREENSHOT_END -->";
const browser = await chromium.launch({ headless: true });

try {
  await mkdir(dirname(screenshotPath), { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  let response;
  let lastError;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      response = await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 2_000 });
      if (response?.ok()) break;
      lastError = new Error(`App returned HTTP ${response?.status() ?? "no response"}`);
    } catch (error) {
      lastError = error;
    }
    await page.waitForTimeout(1_000);
  }
  if (!response?.ok()) throw lastError ?? new Error("Screenshot app did not become ready");
  await page.waitForSelector(".pf-topbar-title", { state: "visible", timeout: 30_000 });
  await page.waitForSelector(".pf-composer", { state: "visible", timeout: 30_000 });
  await page.screenshot({ path: screenshotPath, fullPage: false });

  const readme = await readFile(readmePath, "utf8");
  const markerPattern = new RegExp(`${screenshotStart}[\\s\\S]*?${screenshotEnd}`);
  if (!markerPattern.test(readme)) throw new Error("README screenshot markers missing");
  const updated = readme.replace(
    markerPattern,
    `${screenshotStart}\n![UltraRoute chat workspace](${relative(dirname(readmePath), screenshotPath)})\n${screenshotEnd}`,
  );
  await writeFile(readmePath, updated);
  console.log(`Captured ${screenshotPath} from ${baseUrl} and updated ${readmePath}`);
} finally {
  await browser.close();
}
