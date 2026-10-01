import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { CredentialError, UpstreamDriftError } from "../../shared/errors.ts";

export interface GeminiModel {
  id: string;
  upstreamId: string;
  name: string;
  description: string;
  disabled: boolean;
  availability: string;
}
export interface GeminiModelCatalog {
  models: GeminiModel[];
  defaultModel?: string;
}

/** GetUserStatus supplies names/IDs; the picker applies account and quota policy. */
export function parseGeminiModelRows(response: string): Map<string, { name: string; description: string }> {
  try {
    const frames = response.split("\n").filter(line => line.startsWith("[[")).flatMap(line => JSON.parse(line));
    const frame = frames.find(row => row[0] === "wrb.fr" && row[1] === "otAQ7b");
    const payload = JSON.parse(frame[2]);
    if (!Array.isArray(payload[15]) || !payload[15].length) throw new Error();
    const models = new Map<string, { name: string; description: string }>();
    for (const row of payload[15]) {
      if (!Array.isArray(row) || typeof row[0] !== "string" || typeof row[11] !== "string" || typeof row[12] !== "string") throw new Error();
      models.set(row[0], { name: row[11], description: row[12] });
    }
    return models;
  } catch {
    throw new UpstreamDriftError("Gemini GetUserStatus model catalog changed");
  }
}

export async function discoverGeminiModels(cookieHeader: string, signal?: AbortSignal): Promise<GeminiModelCatalog> {
  signal?.throwIfAborted();
  const executablePath = process.env.GEMINI_CHROMIUM_PATH || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 30_000 });
  const onAbort = () => { void browser.close(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    const context = await browser.newContext();
    await context.addCookies(cookieHeader.split(";").flatMap(part => {
      const index = part.indexOf("=");
      if (index <= 0) return [];
      return [{ name: part.slice(0, index).trim(), value: part.slice(index + 1).trim(), url: "https://gemini.google.com", secure: true }];
    }));
    const page = await context.newPage();
    const responsePromise = page.waitForResponse(response => response.url().includes("/batchexecute") && new URL(response.url()).searchParams.get("rpcids")?.split(",").includes("otAQ7b") === true, { timeout: 30_000 });
    // Attach the rejection handler immediately if navigation fails before the RPC.
    void responsePromise.catch(() => {});
    await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 30_000 });
    const response = await responsePromise;
    if (!response.ok()) throw new CredentialError("Gemini model discovery requires a valid session");
    const rows = parseGeminiModelRows(await response.text());
    const picker = page.locator('button[aria-label^="Open mode picker"]');
    await picker.click({ timeout: 30_000 });
    await page.locator('[role="menuitem"][data-mode-id]').first().waitFor();
    const entries = await page.locator('[role="menuitem"][data-mode-id]').evaluateAll(elements => elements.map(element => ({
      id: element.getAttribute("data-mode-id")!,
      disabled: element.getAttribute("aria-disabled") === "true" || element.hasAttribute("disabled"),
      selected: !!element.querySelector('[aria-label="Selected"]'),
      text: element.textContent?.trim() ?? "",
    })));
    const models = entries.map(entry => {
      const row = rows.get(entry.id);
      if (!row) throw new UpstreamDriftError("Gemini picker model missing from GetUserStatus");
      return { id: `gemini-web:${entry.id}`, upstreamId: entry.id, ...row, disabled: entry.disabled,
        availability: entry.disabled ? entry.text : "Available" };
    });
    if (!models.length) throw new UpstreamDriftError("Gemini returned no picker models");
    const selected = entries.find(entry => entry.selected && !entry.disabled);
    return { models, defaultModel: selected ? `gemini-web:${selected.id}` : models.find(model => !model.disabled)?.id };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await browser.close();
  }
}
