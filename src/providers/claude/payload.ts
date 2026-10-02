import { randomUUID } from "node:crypto";
import { InvalidRequestError } from "../../shared/errors.ts";
import type { ChatCompletionRequest, ChatMessage, ToolDefinition } from "../../shared/types.ts";
import { CLAUDE_REASONING_EFFORT_MAP } from "./constants.ts";

export interface ClaudeWebWireTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface ClaudeWebWirePayload {
  prompt: string;
  timezone: string;
  model: string;
  tools?: ClaudeWebWireTool[];
  parent_message_uuid?: string;
  rendering_mode?: string;
  thinking_mode?: string;
  effort?: string;
}

export function transformToolsToClaude(tools?: ToolDefinition[]): ClaudeWebWireTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters ?? { type: "object", properties: {} },
  }));
}

export function buildClaudePrompt(messages: ChatMessage[]): string {
  if (messages.length === 1 && typeof messages[0].content === "string") {
    return messages[0].content;
  }

  // Multi-message transcript canonicalization into standard XML boundary turn structure
  const formattedParts: string[] = [];
  for (const msg of messages) {
    const role = msg.role;
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .map((p) => {
          if (p.type === "text") return p.text ?? "";
          if (p.type === "image_url") return `[Image: ${p.image_url?.url ?? ""}]`;
          return "";
        })
        .join(" ");
    }

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        text += `\n<tool_call id="${tc.id}" name="${tc.function.name}">\n${tc.function.arguments}\n</tool_call>`;
      }
    }
    if (role === "tool") {
      text = `<tool_result id="${msg.tool_call_id ?? ""}">\n${text}\n</tool_result>`;
    }

    formattedParts.push(`<message role="${role}">\n${text}\n</message>`);
  }

  return formattedParts.join("\n\n");
}

export function transformToClaudePayload(
  request: ChatCompletionRequest,
  resolvedModel: string,
  parentMessageUuid?: string
): ClaudeWebWirePayload {
  if (!request.messages || request.messages.length === 0) {
    throw new InvalidRequestError("Request messages cannot be empty");
  }

  const prompt = buildClaudePrompt(request.messages);
  const tools = transformToolsToClaude(request.tools);

  let effort: string | undefined;
  let thinking_mode: string | undefined;

  if (request.reasoning_effort && request.reasoning_effort in CLAUDE_REASONING_EFFORT_MAP) {
    const mapping = CLAUDE_REASONING_EFFORT_MAP[request.reasoning_effort];
    effort = mapping?.effort;
    thinking_mode = mapping?.thinking_mode;
  }

  return {
    prompt,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    model: resolvedModel,
    tools,
    parent_message_uuid: parentMessageUuid,
    effort,
    thinking_mode,
  };
}
