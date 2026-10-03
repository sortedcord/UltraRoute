import { ModelCatalogCache } from "../../src/shared/modelCatalogCache.ts";

export function chatGptNativeCatalog() {
  return {
    models: [
      { slug: "native-fast-route", max_tokens: 52_815 },
      { slug: "native-deliberate-route", max_tokens: 262_144 },
      { slug: "hidden-mini", max_tokens: 8_000 },
    ],
    versions: [
      {
        id: "5.7",
        display_text_for_intelligence: "Future GPT 5.7 · Native",
        enabled: true,
        slugs: [
          "native-family-alias",
          "native-fast-route",
          "native-deliberate-route",
        ],
        intelligence_presets: [
          {
            id: 0,
            title: "Instant",
            model_slug: "native-fast-route",
            lane: "instant",
            preset_type: "available",
          },
          {
            id: 1,
            title: "Medium",
            model_slug: "native-deliberate-route",
            lane: "thinking",
            thinking_effort: "standard",
            preset_type: "available",
          },
          {
            id: 2,
            title: "High",
            model_slug: "native-deliberate-route",
            lane: "thinking",
            thinking_effort: "extended",
            preset_type: "available",
          },
        ],
      },
    ],
    default_model_slug: "native-family-alias",
  };
}

export function chatGptCatalogDeps(account = "fixture-account") {
  return {
    modelCatalogCache: new ModelCatalogCache(),
    modelCatalogSource: {
      async getAccountIdentity() {
        return account;
      },
      async fetchModels() {
        return chatGptNativeCatalog();
      },
    },
  };
}
