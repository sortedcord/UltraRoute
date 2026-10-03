import { globalProviderRegistry } from "./registry/providers.ts";
import { ChatGptWebAdapter } from "./providers/chatgpt/index.ts";
import { ClaudeWebAdapter } from "./providers/claude/index.ts";
import { GeminiWebAdapter } from "./providers/gemini/index.ts";
import {
  ModelCatalogCache,
  getDefaultModelCatalogCache,
} from "./shared/modelCatalogCache.ts";

export * from "./shared/index.ts";
export * from "./registry/index.ts";
export * from "./providers/chatgpt/index.ts";
export * from "./providers/claude/index.ts";
export * from "./providers/gemini/index.ts";

/**
 * Registers missing web providers without replacing caller-configured adapters.
 * Executable ChatGPT hosts must supply a browser transport and catalog source.
 */
export function initializeWebProviders(
  modelCatalogCache: ModelCatalogCache = getDefaultModelCatalogCache(),
): void {
  if (!globalProviderRegistry.get("chatgpt-web")) {
    globalProviderRegistry.register(
      new ChatGptWebAdapter({ modelCatalogCache }),
    );
  }

  // 2. Claude Web
  if (!globalProviderRegistry.get("claude-web")) {
    globalProviderRegistry.register(
      new ClaudeWebAdapter({ modelCatalogCache }),
    );
  }

  // 3. Gemini Web
  if (!globalProviderRegistry.get("gemini-web")) {
    globalProviderRegistry.register(
      new GeminiWebAdapter({ modelCatalogCache }),
    );
  }
}
