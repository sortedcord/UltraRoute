import type {
  WebProviderCapabilities,
  ReasoningEffort,
} from "../../shared/types.ts";
import { UpstreamDriftError } from "../../shared/errors.ts";

export interface ClaudeModel {
  id: string;
  name: string;
  description?: string;
  section: string;
  disabled: boolean;
  disabledReason?: string;
  requiredPlan?: string;
  badge?: string;
  capabilities: WebProviderCapabilities;
}

export interface ClaudeModelCatalog {
  models: ClaudeModel[];
  defaultModel?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The chat selector, not the account's broader code/deprecated model catalog. */
export function parseClaudeModelCatalog(
  bootstrap: unknown,
): ClaudeModelCatalog {
  const data = record(bootstrap);
  const selectors = data.model_selector_config;
  const chat = Array.isArray(selectors)
    ? selectors.map(record).find((selector) => selector.id === "chat")
    : undefined;
  if (!chat || !Array.isArray(chat.models)) {
    throw new UpstreamDriftError(
      "Claude bootstrap is missing the chat model selector",
    );
  }
  const models: ClaudeModel[] = [];
  const ids = new Set<string>();
  for (const value of chat.models) {
    const model = record(value);
    if (model.section === "deprecated") continue;
    if (
      typeof model.id !== "string" ||
      !model.id ||
      typeof model.name !== "string" ||
      !model.name ||
      typeof model.section !== "string" ||
      ids.has(model.id)
    ) {
      throw new UpstreamDriftError(
        "Claude returned an invalid chat model catalog",
      );
    }
    ids.add(model.id);
    const thinking = record(model.thinking);
    const capabilities = record(model.capabilities);
    const disabledReason = record(model.disabled_reason);
    const efforts = Array.isArray(thinking.effort_options)
      ? thinking.effort_options
          .map(record)
          .map((option) => option.id)
          .filter((id): id is ReasoningEffort =>
            ["none", "low", "medium", "high", "xhigh", "max"].includes(
              id as string,
            ),
          )
      : [];
    models.push({
      id: model.id,
      name: model.name,
      description:
        typeof model.description === "string" ? model.description : undefined,
      section: model.section,
      disabled:
        model.disabled === true || typeof disabledReason.type === "string",
      disabledReason:
        typeof disabledReason.type === "string"
          ? disabledReason.type
          : undefined,
      requiredPlan:
        typeof disabledReason.required_plan === "string"
          ? disabledReason.required_plan
          : undefined,
      badge:
        typeof record(model.badge).message === "string"
          ? (record(model.badge).message as string)
          : undefined,
      capabilities: {
        supportsStreaming: true,
        supportsReasoning:
          typeof thinking.type === "string" && thinking.type !== "none",
        supportedThinkingEfforts: efforts,
        supportsToolCalling: true,
        supportsVision: capabilities.mm_images === true,
        supportsFiles: capabilities.mm_pdf === true,
        supportsContinuation: true,
        maxContextTokens:
          typeof model.hard_limit === "number" ? model.hard_limit : undefined,
      },
    });
  }
  if (models.length === 0)
    throw new UpstreamDriftError("Claude returned no chat models");
  const states = data.model_selector_state;
  const selected = Array.isArray(states)
    ? states.map(record).find((state) => state.id === "chat")?.model
    : undefined;
  return {
    models,
    defaultModel:
      typeof selected === "string" &&
      models.some((model) => model.id === selected && !model.disabled)
        ? selected
        : models.find((model) => !model.disabled)?.id,
  };
}
