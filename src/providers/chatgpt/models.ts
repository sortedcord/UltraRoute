import type {
  ReasoningEffort,
  WebProviderCapabilities,
} from "../../shared/types.ts";
import { UpstreamDriftError } from "../../shared/errors.ts";

export interface ChatGptReasoningLevel {
  value: ReasoningEffort;
  label: string;
  model: string;
  thinkingEffort?: string;
  disabled: boolean;
}

export interface ChatGptModel {
  id: string;
  name: string;
  disabled: boolean;
  disabledReason?: string;
  reasoningLevels: ChatGptReasoningLevel[];
  defaultReasoningLevel?: ReasoningEffort;
  capabilities: WebProviderCapabilities;
}

export interface ChatGptModelCatalog {
  models: ChatGptModel[];
  defaultModel?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function drift(): never {
  throw new UpstreamDriftError(
    "ChatGPT returned an invalid native model catalog",
  );
}

/** These are transport capabilities, not account/model discovery or token guesses. */
export function chatGptTransportCapabilities(): WebProviderCapabilities {
  return {
    supportsStreaming: false,
    supportsReasoning: false,
    supportedThinkingEfforts: [],
    supportsToolCalling: false,
    supportsVision: true,
    supportsFiles: true,
    supportsContinuation: false,
  };
}

/** Only versions/intelligence_presets describe the native chat picker. */
export function parseChatGptModelCatalog(
  payload: unknown,
): ChatGptModelCatalog {
  const data = record(payload);
  if (
    !Array.isArray(data.versions) ||
    !data.versions.length ||
    !Array.isArray(data.models)
  )
    drift();
  const upstreamModels = new Map<string, Record<string, unknown>>();
  for (const value of data.models) {
    const model = record(value);
    if (nonempty(model.slug)) upstreamModels.set(model.slug, model);
  }
  const models: ChatGptModel[] = [];
  const ids = new Set<string>();
  let defaultModel: string | undefined;
  for (const value of data.versions) {
    const version = record(value);
    if (
      !nonempty(version.id) ||
      !nonempty(version.display_text_for_intelligence) ||
      typeof version.enabled !== "boolean" ||
      !Array.isArray(version.slugs) ||
      !version.slugs.length ||
      !version.slugs.every(nonempty) ||
      !Array.isArray(version.intelligence_presets) ||
      !version.intelligence_presets.length
    )
      drift();
    const id = `chatgpt-web:${encodeURIComponent(version.id)}`;
    if (ids.has(id)) drift();
    ids.add(id);
    const slugs = new Set(version.slugs as string[]);
    const reasoningLevels: ChatGptReasoningLevel[] = [];
    const efforts = new Set<ReasoningEffort>();
    for (const value of version.intelligence_presets) {
      const preset = record(value);
      if (
        !nonempty(preset.title) ||
        !nonempty(preset.model_slug) ||
        !slugs.has(preset.model_slug)
      )
        drift();
      let effort: ReasoningEffort;
      if (preset.lane === "instant" && preset.thinking_effort === undefined)
        effort = "none";
      else if (
        preset.lane === "thinking" &&
        preset.thinking_effort === "standard"
      )
        effort = "medium";
      else if (
        preset.lane === "thinking" &&
        preset.thinking_effort === "extended"
      )
        effort = "high";
      else continue; // New native lanes/efforts are unsupported, never guessed from labels/slugs.
      if (efforts.has(effort)) drift();
      efforts.add(effort);
      reasoningLevels.push({
        value: effort,
        label: preset.title,
        model: preset.model_slug,
        ...(typeof preset.thinking_effort === "string"
          ? { thinkingEffort: preset.thinking_effort }
          : {}),
        disabled:
          !version.enabled ||
          preset.preset_type !== "available" ||
          (preset.enabled !== undefined && preset.enabled !== true),
      });
    }
    if (!reasoningLevels.length) drift();
    const available = reasoningLevels.filter((level) => !level.disabled);
    const defaultLevel =
      available.find((level) => level.model === data.default_model_slug) ??
      available[0];
    const disabled = !version.enabled || !available.length;
    const contextLimits = reasoningLevels
      .map((level) => upstreamModels.get(level.model)?.max_tokens)
      .filter(
        (limit): limit is number =>
          typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0,
      );
    models.push({
      id,
      name: version.display_text_for_intelligence,
      disabled,
      ...(disabled
        ? {
            disabledReason: version.enabled
              ? "All native presets are unavailable for this account"
              : "Model is unavailable for this account",
          }
        : {}),
      reasoningLevels,
      ...(defaultLevel ? { defaultReasoningLevel: defaultLevel.value } : {}),
      capabilities: {
        ...chatGptTransportCapabilities(),
        supportsReasoning: available.some((level) => level.value !== "none"),
        supportedThinkingEfforts: available.map((level) => level.value),
        ...(contextLimits.length === reasoningLevels.length
          ? { maxContextTokens: Math.min(...contextLimits) }
          : {}),
      },
    });
    if (
      !disabled &&
      typeof data.default_model_slug === "string" &&
      (slugs.has(data.default_model_slug) ||
        reasoningLevels.some(
          (level) => level.model === data.default_model_slug,
        ))
    ) {
      if (defaultModel !== undefined) drift();
      defaultModel = id;
    }
  }
  return {
    models,
    defaultModel: defaultModel ?? models.find((model) => !model.disabled)?.id,
  };
}
