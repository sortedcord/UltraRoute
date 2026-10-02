/**
 * Credential and sensitive parameter sanitization.
 * Enforces zero leakage of session cookies, bearer tokens, or account IDs into logs or errors.
 */

const SENSITIVE_PATTERNS = [
  /(__Secure-[a-zA-Z0-9_\-]+)=([^;]+)/gi,
  /(sessionKey)=([^;]+)/gi,
  /(SAPISID)=([^;]+)/gi,
  /(APISID)=([^;]+)/gi,
  /(HSID)=([^;]+)/gi,
  /(SSID)=([^;]+)/gi,
  /(SID)=([^;]+)/gi,
  /(Bearer\s+)[a-zA-Z0-9_\-\.]{15,}/gi,
  /(cf_clearance)=([^;]+)/gi,
  /("?(?:token|apiKey|password|secret|sessionKey|cookie|storageState)"?\s*[:=]\s*"?[^",\s}]+"?)/gi,
];

export function sanitizeCredentials(text: string): string {
  if (!text || typeof text !== "string") return "";
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, (match, prefix, val) => {
      if (prefix && val) {
        return `${prefix}=[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }
  return result;
}

export function sanitizeError(error: unknown): string {
  if (!error) return "Unknown error";
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeCredentials(raw);
}

export function sanitizeObject<T>(obj: T): T {
  if (!obj || typeof obj !== "object") return obj;
  try {
    const json = JSON.stringify(obj, (key, value) => {
      const lower = key.toLowerCase();
      if (
        lower.includes("cookie") ||
        lower.includes("secret") ||
        lower.includes("token") ||
        lower.includes("session") ||
        lower.includes("password") ||
        lower.includes("authorization")
      ) {
        return "[REDACTED]";
      }
      return value;
    });
    return JSON.parse(json) as T;
  } catch {
    return "[Unserializable Object]" as unknown as T;
  }
}
