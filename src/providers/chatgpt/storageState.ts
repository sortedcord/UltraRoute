import { CredentialError } from "../../shared/errors.ts";
import { CHATGPT_WEB_CONSTANTS } from "./constants.ts";

export interface ChatGptStorageCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface ChatGptStorageOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

export interface ChatGptStorageState {
  cookies: ChatGptStorageCookie[];
  origins: ChatGptStorageOrigin[];
}

function isAllowedHost(host: string): boolean {
  const clean = host.toLowerCase().replace(/^\./, "");
  return CHATGPT_WEB_CONSTANTS.ALLOWED_COOKIE_HOSTS.some(
    (allowed) => clean === allowed || clean.endsWith(`.${allowed}`),
  );
}

function isAllowedOrigin(originStr: string): boolean {
  try {
    const parsed = new URL(originStr);
    return (
      !parsed.username &&
      !parsed.password &&
      parsed.href === `${parsed.origin}/` &&
      CHATGPT_WEB_CONSTANTS.ALLOWED_ORIGINS.some(
        (allowed) => parsed.origin === allowed,
      )
    );
  } catch {
    return false;
  }
}

export function parseCookieHeaderToStorageState(
  cookieHeader: string,
): ChatGptStorageState {
  if (!cookieHeader || typeof cookieHeader !== "string") {
    throw new CredentialError(
      "ChatGPT Web Cookie header must be a non-empty string",
    );
  }

  const cookies: ChatGptStorageCookie[] = [];
  const parts = cookieHeader.split(";");

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;

    const name = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();

    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\0]/.test(value))
      throw new CredentialError("ChatGPT Cookie header is malformed");
    cookies.push({
      name,
      value,
      domain: name.startsWith("__Host-") ? "chatgpt.com" : ".chatgpt.com",
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 86400 * 30, // 30 days
      httpOnly: name.startsWith("__Secure-"),
      secure: true,
      sameSite: "Lax",
    });
  }

  if (cookies.length === 0) {
    throw new CredentialError(
      "ChatGPT Web Cookie header did not contain any valid cookies",
    );
  }

  return {
    cookies,
    origins: [
      {
        origin: "https://chatgpt.com",
        localStorage: [],
      },
    ],
  };
}

export function validateAndNormalizeStorageState(
  raw: unknown,
): ChatGptStorageState {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        return validateAndNormalizeStorageState(parsed);
      } catch {
        throw new CredentialError("Invalid ChatGPT storage state JSON");
      }
    }
    return parseCookieHeaderToStorageState(trimmed);
  }

  if (!raw || typeof raw !== "object") {
    throw new CredentialError(
      "ChatGPT Web credentials must be a storage state object or Cookie header",
    );
  }

  const candidate = raw as Record<string, unknown>;
  const cookiesInput = candidate.cookies;
  if (!Array.isArray(cookiesInput) || cookiesInput.length === 0) {
    throw new CredentialError(
      "ChatGPT Web storage state must contain a non-empty cookies array",
    );
  }

  const normalizedCookies: ChatGptStorageCookie[] = [];
  for (let i = 0; i < cookiesInput.length; i++) {
    const c = cookiesInput[i] as Record<string, unknown>;
    if (!c || typeof c.name !== "string" || typeof c.value !== "string") {
      throw new CredentialError(
        `Cookie at index ${i} is missing name or value`,
      );
    }
    const domain = typeof c.domain === "string" ? c.domain : ".chatgpt.com";
    if (!isAllowedHost(domain)) {
      throw new CredentialError(
        "Cookie domain is not an allowed OpenAI/ChatGPT host",
      );
    }

    normalizedCookies.push({
      name: c.name,
      value: c.value,
      domain,
      path: typeof c.path === "string" && c.path.startsWith("/") ? c.path : "/",
      expires:
        typeof c.expires === "number"
          ? c.expires
          : Math.floor(Date.now() / 1000) + 86400 * 30,
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: ["Strict", "Lax", "None"].includes(String(c.sameSite))
        ? (c.sameSite as "Strict" | "Lax" | "None")
        : "Lax",
    });
  }

  const originsInput = Array.isArray(candidate.origins)
    ? candidate.origins
    : [];
  const normalizedOrigins: ChatGptStorageOrigin[] = [];

  for (const o of originsInput) {
    if (!o || typeof o !== "object") continue;
    const originRec = o as Record<string, unknown>;
    if (
      typeof originRec.origin !== "string" ||
      !isAllowedOrigin(originRec.origin)
    ) {
      throw new CredentialError(
        "Storage state contains a forbidden or invalid origin",
      );
    }
    const ls = Array.isArray(originRec.localStorage)
      ? (originRec.localStorage as Array<{ name: string; value: string }>)
      : [];
    normalizedOrigins.push({
      origin: originRec.origin,
      localStorage: ls.filter(
        (item) =>
          item &&
          typeof item.name === "string" &&
          typeof item.value === "string",
      ),
    });
  }

  if (normalizedOrigins.length === 0) {
    normalizedOrigins.push({
      origin: "https://chatgpt.com",
      localStorage: [],
    });
  }

  return {
    cookies: normalizedCookies,
    origins: normalizedOrigins,
  };
}
