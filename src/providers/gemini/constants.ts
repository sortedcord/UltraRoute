/**
 * Drift-sensitive constants and routes for Gemini Web.
 */

export const GEMINI_WEB_CONSTANTS = {
  BASE_URL: "https://gemini.google.com",
  STREAM_GENERATE_RPC: "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
  IMAGE_UPLOAD_URL: "https://content-push.googleapis.com/upload/",
  RPC_ID: "wrb.fr",


  // Cookie keys
  SECURE_1PSID: "__Secure-1PSID",
  SECURE_1PSIDTS: "__Secure-1PSIDTS",
  SECURE_1PSIDCC: "__Secure-1PSIDCC",
  SAPISID: "SAPISID",

  // Internal Google payload indices
  PAYLOAD_SLOT_INPUT: 0,
  PAYLOAD_SLOT_CONTEXT: 2,
  PAYLOAD_SLOT_IMAGE: 4,
  PAYLOAD_SLOT_THINK_SETTING: 17,
  PAYLOAD_SLOT_MODEL_CATEGORY: 79,

  // Timeouts
  DEFAULT_TIMEOUT_MS: 120_000,
};


export const GEMINI_REASONING_MAP: Record<string, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 3,
  max: 3,
};
