/**
 * Drift-sensitive constants and routes for ChatGPT Web.
 */

export const CHATGPT_WEB_CONSTANTS = {
  BASE_URL: "https://chatgpt.com",
  TEMPORARY_CHAT_URL: "https://chatgpt.com/?temporary-chat=true",

  // Allowed cookie & origin domains for security enclosure
  ALLOWED_COOKIE_HOSTS: ["chatgpt.com", "openai.com"] as const,
  ALLOWED_ORIGINS: ["https://chatgpt.com", "https://openai.com"] as const,

  // Timeouts
  DEFAULT_TURN_TIMEOUT_MS: 180_000,
  BROWSER_ACQUIRE_TIMEOUT_MS: 30_000,
  MAX_SOCKET_FRAMES: 2048,
  MAX_RESPONSE_BYTES: 16 * 1024 * 1024,

  // Maximum sizes
  MAX_PROMPT_BYTES: 4 * 1024 * 1024,
};
