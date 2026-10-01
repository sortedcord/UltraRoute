import { globalModelRegistry } from "./registry/models.ts";
import { globalProviderRegistry } from "./registry/providers.ts";
import {
  ChatGptWebAdapter,
  CHATGPT_WEB_MODELS,
} from "./providers/chatgpt/index.ts";
import { ClaudeWebAdapter } from "./providers/claude/index.ts";
import { GeminiWebAdapter } from "./providers/gemini/index.ts";

export * from "./shared/index.ts";
export * from "./registry/index.ts";
export * from "./providers/chatgpt/index.ts";
export * from "./providers/claude/index.ts";
export * from "./providers/gemini/index.ts";

/**
 * Registers web providers and the static ChatGPT catalog; Claude and Gemini discover models per account.
 */
export function initializeWebProviders(): void {
  // 1. ChatGPT Web
  const chatgptAdapter = new ChatGptWebAdapter();
  globalProviderRegistry.register(chatgptAdapter);
  for (const model of CHATGPT_WEB_MODELS) {
    globalModelRegistry.register({
      id: model.id,
      name: model.name,
      providerId: chatgptAdapter.id,
      aliases: model.aliases,
      capabilities: chatgptAdapter.getCapabilities(model.id),
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
    });
  }

  // 2. Claude Web
  const claudeAdapter = new ClaudeWebAdapter();
  globalProviderRegistry.register(claudeAdapter);

  // 3. Gemini Web
  const geminiAdapter = new GeminiWebAdapter();
  globalProviderRegistry.register(geminiAdapter);
}
