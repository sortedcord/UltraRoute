/**
 * Drift-sensitive constants and routes for Claude Web.
 */

export const CLAUDE_WEB_CONSTANTS = {
  BASE_URL: "https://claude.ai",
  API_BASE: "https://claude.ai/api",
  ORGS_URL: "https://claude.ai/api/organizations",
  CONVERSATIONS_BASE: "https://claude.ai/api/organizations",

  // Cookie name
  SESSION_COOKIE_NAME: "sessionKey",

  // Default browser fingerprint constants
  USER_AGENT:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  SEC_CH_UA: '"Chromium";v="146", "Not?A_Brand";v="24"',
  SEC_CH_UA_PLATFORM: '"Linux"',

  // Bounded idle finish timeout in ms for custom browser-side tool execution
  DEFAULT_TOOL_USE_IDLE_FINISH_MS: 3000,

  // Cache configuration
  CACHE_TTL_MS: 30 * 60 * 1000, // 30 minutes
  CACHE_MAX_ENTRIES: 500,

  // Stream limits
  MAX_ERROR_BODY_BYTES: 64 * 1024,
};

export const CLAUDE_REASONING_EFFORT_MAP: Record<
  string,
  { effort: string; thinking_mode: string }
> = {
  low: { effort: "low", thinking_mode: "adaptive" },
  medium: { effort: "medium", thinking_mode: "adaptive" },
  high: { effort: "high", thinking_mode: "enabled" },
  xhigh: { effort: "high", thinking_mode: "enabled" },
  max: { effort: "max", thinking_mode: "enabled" },
};
