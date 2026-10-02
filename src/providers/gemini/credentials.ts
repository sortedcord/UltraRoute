import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { CredentialError } from "../../shared/errors.ts";
import { GEMINI_WEB_CONSTANTS } from "./constants.ts";

export interface GeminiCredentials {
  rawCookie: string;
  secure1PSID?: string;
  secure1PSIDTS?: string;
  secure1PSIDCC?: string;
  sapisid?: string;
  authUser?: string;
}

export interface ICookieSource {
  getCookie(): Promise<string>;
}

export class StaticCookieSource implements ICookieSource {
  private readonly cookie: string;
  constructor(cookie: string) {
    this.cookie = cookie;
  }
  async getCookie(): Promise<string> {
    return this.cookie;
  }
}

export class FileCookieSource implements ICookieSource {
  private readonly filePath: string;
  private cachedCookie = "";
  private lastMtime = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async getCookie(): Promise<string> {
    if (!existsSync(this.filePath)) {
      throw new CredentialError(`Configured Gemini cookie file not found: ${this.filePath}`);
    }
    const stat = statSync(this.filePath);
    if (stat.mtimeMs > this.lastMtime || !this.cachedCookie) {
      const raw = readFileSync(this.filePath, "utf-8").trim();
      if (raw.startsWith("{")) {
        try {
          const json = JSON.parse(raw) as Record<string, unknown>;
          this.cachedCookie = (json.cookie as string) || "";
        } catch {
          this.cachedCookie = raw;
        }
      } else {
        this.cachedCookie = raw;
      }
      this.lastMtime = stat.mtimeMs;
    }
    return this.cachedCookie;
  }
}

export function parseGeminiCookie(cookieStr: string): GeminiCredentials {
  if (!cookieStr || typeof cookieStr !== "string") {
    throw new CredentialError("Gemini Cookie must be a non-empty string");
  }

  const pairs = cookieStr.split(";");
  let sapisid: string | undefined;
  let secure1PSID: string | undefined;
  let secure1PSIDTS: string | undefined;
  let secure1PSIDCC: string | undefined;

  for (const p of pairs) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();

    if (k === GEMINI_WEB_CONSTANTS.SAPISID) sapisid = v;
    else if (k === GEMINI_WEB_CONSTANTS.SECURE_1PSID) secure1PSID = v;
    else if (k === GEMINI_WEB_CONSTANTS.SECURE_1PSIDTS) secure1PSIDTS = v;
    else if (k === GEMINI_WEB_CONSTANTS.SECURE_1PSIDCC) secure1PSIDCC = v;
  }

  if (!secure1PSID && !sapisid) {
    throw new CredentialError(
      `Gemini cookie missing required auth cookies (${GEMINI_WEB_CONSTANTS.SECURE_1PSID} or ${GEMINI_WEB_CONSTANTS.SAPISID})`
    );
  }

  return {
    rawCookie: cookieStr,
    secure1PSID,
    secure1PSIDTS,
    secure1PSIDCC,
    sapisid,
  };
}

export function generateSapisidHash(sapisid: string, origin = "https://gemini.google.com"): string {
  const ts = Math.floor(Date.now() / 1000);
  const data = `${ts} ${sapisid} ${origin}`;
  const sha = createHash("sha1").update(data).digest("hex");
  return `SAPISIDHASH ${ts}_${sha}`;
}
