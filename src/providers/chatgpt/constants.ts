/**
 * Drift-sensitive constants and routes for ChatGPT Web.
 */

export const CHATGPT_WEB_CONSTANTS = {
  BASE_URL: "https://chatgpt.com",
  TEMPORARY_CHAT_URL: "https://chatgpt.com/?temporary-chat=true",
  CONVERSATION_URL: "https://chatgpt.com/backend-api/conversation",
  FILES_URL: "https://chatgpt.com/backend-api/files",
  SENTINEL_REQUIREMENTS_URL:
    "https://chatgpt.com/backend-api/sentinel/chat-requirements",
  WS_URL: "wss://chatgpt.com/backend-api/lat/r",
  DIRECT_SSE_PATH: "/f/conversation",

  // Allowed cookie & origin domains for security enclosure
  ALLOWED_COOKIE_HOSTS: ["chatgpt.com", "openai.com"] as const,
  ALLOWED_ORIGINS: ["https://chatgpt.com", "https://openai.com"] as const,

  // Timeouts
  DEFAULT_TURN_TIMEOUT_MS: 180_000,
  POLL_INTERVAL_MS: 100,
  BROWSER_ACQUIRE_TIMEOUT_MS: 30_000,
  COMPOSER_SELECTOR:
    '[contenteditable="true"][role="textbox"], #prompt-textarea, textarea',
  MAX_SOCKET_FRAMES: 2048,
  MAX_RESPONSE_BYTES: 16 * 1024 * 1024,

  // Maximum sizes
  MAX_PROMPT_BYTES: 4 * 1024 * 1024,
  MAX_ATTACHMENT_BYTES: 20 * 1024 * 1024,
};

export const CHATGPT_WEB_MODELS = [
  {
    id: "gpt-5-6",
    name: "GPT-5.6 Sol — Instant",
    aliases: ["gpt-5.6", "sol-instant"],
    uiKind: "picker",
    uiLabel: "GPT-5.6 Sol",
    reasoningEffortIndex: 0,
    supportsVision: true,
  },
  {
    id: "gpt-5-6-thinking",
    name: "GPT-5.6 Sol — Thinking",
    aliases: ["gpt-5.6-thinking", "gpt-5-6-sol"],
    uiKind: "picker",
    uiLabel: "GPT-5.6 Sol",
    reasoningEffortIndex: 2, // default medium/high
    supportsVision: true,
  },
  {
    id: "gpt-5-6-pro",
    name: "GPT-5.6 Sol — Pro",
    aliases: ["gpt-5.6-pro"],
    uiKind: "picker",
    uiLabel: "GPT-5.6 Sol",
    reasoningEffortIndex: 4,
    supportsVision: true,
  },
  {
    id: "gpt-5.6-luna-free",
    name: "GPT-5.6 Luna — Free",
    aliases: ["gpt-5-luna", "luna-free"],
    uiKind: "free",
    uiLabel: "Free",
    thinkEnabled: false,
    supportsVision: true,
  },
  {
    id: "gpt-5.6-luna-free-thinking",
    name: "GPT-5.6 Luna — Free Thinking",
    aliases: ["luna-thinking"],
    uiKind: "free",
    uiLabel: "Free",
    thinkEnabled: true,
    supportsVision: true,
  },
  {
    id: "gpt-5-5-instant",
    name: "GPT-5.5 — Instant",
    aliases: ["gpt-5.5-instant"],
    uiKind: "picker",
    uiLabel: "GPT-5.5",
    reasoningEffortIndex: 0,
    supportsVision: true,
  },
  {
    id: "gpt-5-5-thinking",
    name: "GPT-5.5 — Thinking",
    aliases: ["gpt-5-5", "gpt-5.5"],
    uiKind: "picker",
    uiLabel: "GPT-5.5",
    reasoningEffortIndex: 2,
    supportsVision: true,
  },
  {
    id: "gpt-5-5-pro",
    name: "GPT-5.5 — Pro",
    aliases: ["gpt-5.5-pro"],
    uiKind: "picker",
    uiLabel: "GPT-5.5",
    reasoningEffortIndex: 4,
    supportsVision: true,
  },
] as const;

export const REASONING_EFFORT_MAP: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 3,
  max: 4,
};
