import type { IClaudeWebTransport } from "./adapter.ts";
import type { ClaudeWebWirePayload } from "./payload.ts";
import { CLAUDE_WEB_CONSTANTS } from "./constants.ts";
import { classifyHttpError } from "../../shared/errors.ts";

export class LiveClaudeWebTransport implements IClaudeWebTransport {
  async fetchOrganizations(cookieHeader: string, signal?: AbortSignal) {
    const res = await fetch(CLAUDE_WEB_CONSTANTS.ORGS_URL, {
      headers: {
        Cookie: cookieHeader,
        "User-Agent": CLAUDE_WEB_CONSTANTS.USER_AGENT,
        Accept: "application/json",
      },
      signal,
    });
    if (!res.ok)
      throw classifyHttpError(res.status, await res.text(), "Claude Web");
    const data = (await res.json()) as Array<{ uuid: string; name: string }>;
    return data.map((org) => ({ id: org.uuid, name: org.name }));
  }

  async fetchBootstrap(
    orgId: string,
    cookieHeader: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const query =
      "statsig_hashing_algorithm=djb2&growthbook_format=sdk&cache_bust=1&include_system_prompts=false";
    const res = await fetch(
      `${CLAUDE_WEB_CONSTANTS.BASE_URL}/edge-api/bootstrap/${encodeURIComponent(orgId)}/app_start?${query}`,
      {
        headers: {
          Cookie: cookieHeader,
          "User-Agent": CLAUDE_WEB_CONSTANTS.USER_AGENT,
          Accept: "application/json",
          "anthropic-client-platform": "web_claude_ai",
        },
        signal,
      },
    );
    if (!res.ok)
      throw classifyHttpError(res.status, await res.text(), "Claude Web");
    return res.json();
  }

  async sendTurn(
    orgId: string,
    conversationUuid: string,
    payload: ClaudeWebWirePayload,
    cookieHeader: string,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const headers = {
      Cookie: cookieHeader,
      "Content-Type": "application/json",
      "User-Agent": CLAUDE_WEB_CONSTANTS.USER_AGENT,
      "anthropic-client-platform": "web_claude_ai",
    };
    const base = `${CLAUDE_WEB_CONSTANTS.API_BASE}/organizations/${encodeURIComponent(orgId)}/chat_conversations`;
    if (!payload.parent_message_uuid) {
      try {
        await fetch(base, {
          method: "POST",
          headers: { ...headers, Accept: "application/json" },
          body: JSON.stringify({ uuid: conversationUuid, name: "" }),
          signal,
        });
      } catch {
        // Existing transport tolerates an already-created conversation.
      }
    }
    const res = await fetch(`${base}/${conversationUuid}/completion`, {
      method: "POST",
      headers: { ...headers, Accept: "text/event-stream" },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok)
      throw classifyHttpError(res.status, await res.text(), "Claude Web");
    if (!res.body) throw new Error("No response body received from Claude Web");
    return res.body;
  }
}
