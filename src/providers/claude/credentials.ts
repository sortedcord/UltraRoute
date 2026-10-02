import { CredentialError } from "../../shared/errors.ts";
import { CLAUDE_WEB_CONSTANTS } from "./constants.ts";

export interface ClaudeWebCredentials {
  sessionKey: string;
  organizationId?: string;
  deviceId?: string;
}

export function normalizeClaudeSessionCookie(raw: unknown): ClaudeWebCredentials {
  if (typeof raw === "object" && raw !== null) {
    const rec = raw as Record<string, unknown>;
    const sessionKey = typeof rec.sessionKey === "string" ? rec.sessionKey : typeof rec.apiKey === "string" ? rec.apiKey : undefined;
    if (sessionKey && sessionKey.trim()) {
      return {
        sessionKey: sessionKey.trim(),
        organizationId: typeof rec.organizationId === "string" ? rec.organizationId.trim() : undefined,
        deviceId: typeof rec.deviceId === "string" ? rec.deviceId.trim() : undefined,
      };
    }
  }

  if (typeof raw !== "string" || !raw.trim()) {
    throw new CredentialError("Claude Web credentials must be a session key or Cookie header string");
  }

  const str = raw.trim();
  // Case 1: Cookie header contains sessionKey=sk-ant-sid...
  if (str.includes("=")) {
    const parts = str.split(";");
    let sessionKey: string | undefined;
    let deviceId: string | undefined;

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();

      if (key === CLAUDE_WEB_CONSTANTS.SESSION_COOKIE_NAME) {
        sessionKey = val;
      } else if (key.toLowerCase() === "device-id" || key.toLowerCase() === "device_id") {
        deviceId = val;
      }
    }

    if (!sessionKey) {
      throw new CredentialError(`Claude Cookie header missing "${CLAUDE_WEB_CONSTANTS.SESSION_COOKIE_NAME}" cookie`);
    }
    return { sessionKey, deviceId };
  }

  // Case 2: raw session key value directly passed
  return { sessionKey: str };
}

export function buildClaudeCookieHeader(creds: ClaudeWebCredentials): string {
  const parts = [`${CLAUDE_WEB_CONSTANTS.SESSION_COOKIE_NAME}=${creds.sessionKey}`];
  if (creds.deviceId) {
    parts.push(`device-id=${creds.deviceId}`);
  }
  return parts.join("; ");
}
