import { UpstreamDriftError } from "../../shared/errors.ts";
import type { CitationSource } from "../../shared/types.ts";

export interface GeminiContinuationToken {
  conversationId: string;
  responseId: string;
  choiceId: string;
}

export interface GeminiParsedChunk {
  text: string;
  isFinal: boolean;
  continuation?: GeminiContinuationToken;
  citations?: CitationSource[];
}
/**
 * Parses Google's framed StreamGenerate response chunks (wrb.fr format).
 * Chunks arrive prefixed by byte lengths and anti-XSSI prefixes `)]}'\n`.
 */
export class GeminiRpcDecoder {
  private buffer = "";

  /**
   * Feed raw wire chunk and return parsed text increments and metadata.
   */
  *feed(chunk: string): Generator<GeminiParsedChunk> {
    this.buffer += chunk;

    // Split lines and parse each wrb.fr line
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(")]}'") || /^\d+$/.test(trimmed)) {
        continue;
      }
      const parsed = this.parseJsonPayload(trimmed);
      if (parsed) yield parsed;
    }
  }

  private parseJsonPayload(payloadStr: string): GeminiParsedChunk | null {
    if (!payloadStr.trim()) return null;
    let outer: unknown;
    try {
      outer = JSON.parse(payloadStr);
    } catch {
      return null;
    }

    if (!Array.isArray(outer)) return null;

    // RPC structure is typically [["wrb.fr", null, "JSON_INNER_STRING", ...]]
    for (const item of outer) {
      if (Array.isArray(item) && item[0] === "wrb.fr" && typeof item[2] === "string") {
        try {
          const inner = JSON.parse(item[2]);
          return this.extractFromInner(inner);
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  private extractFromInner(inner: unknown): GeminiParsedChunk | null {
    if (!Array.isArray(inner)) return null;

    // inner[4] typically holds candidate choices: [[choiceId, [textParts], ...]]
    let text = "";
    let continuation: GeminiContinuationToken | undefined;
    let citations: CitationSource[] | undefined;
    const candidates = inner[4];
    if (Array.isArray(candidates) && candidates.length > 0) {
      const firstChoice = candidates[0];
      if (Array.isArray(firstChoice)) {
        const choiceId = String(firstChoice[0] ?? "");
        const contentParts = firstChoice[1];
        if (Array.isArray(contentParts) && contentParts.length > 0) {
          text = String(contentParts[0] ?? "");
        }

        // Extract citations from candidate[2][1] (span-based citations)
        const candidateCitationContainer = firstChoice[2];
        if (Array.isArray(candidateCitationContainer) && Array.isArray(candidateCitationContainer[1])) {
          const rawGroups = candidateCitationContainer[1];
          const parsedCitations: CitationSource[] = [];
          let citNum = 0;
          for (const group of rawGroups) {
            if (!Array.isArray(group)) continue;
            citNum++;
            const anchor = Array.isArray(group[0]) ? group[0] : null;
            const rangePair = anchor && Array.isArray(anchor[3]) && Array.isArray(anchor[3][0])
              ? anchor[3][0]
              : null;
            const startIndex = typeof rangePair?.[0] === "number" ? rangePair[0] : undefined;
            const endIndex = typeof rangePair?.[1] === "number" ? rangePair[1] : undefined;
            const sourceRows = Array.isArray(group[2]) ? group[2] : [];
            for (const src of sourceRows) {
              if (!Array.isArray(src)) continue;
              const url = typeof src[0] === "string" ? src[0] : null;
              if (!url) continue;
              const title = typeof src[1] === "string" ? src[1] : (typeof src[6] === "string" ? src[6] : undefined);
              const favicon = typeof src[2] === "string" ? src[2] : undefined;
              const snippet = typeof src[3] === "string" ? src[3] : undefined;
              parsedCitations.push({
                id: `gemini-cit-${citNum}-${parsedCitations.length + 1}`,
                url,
                title,
                favicon,
                startIndex,
                endIndex,
                snippet,
                citationNumber: citNum,
              });
            }
          }
          if (parsedCitations.length > 0) {
            citations = parsedCitations;
          }
        }

        // Fallback: candidate[12] field 43 or sparse bundle "44"
        if (!citations) {
          const richBlock = firstChoice[12];
          if (Array.isArray(richBlock)) {
            let rawGroups = richBlock[43];
            if (!rawGroups && richBlock.length > 0 && typeof richBlock[richBlock.length - 1] === "object" && richBlock[richBlock.length - 1] !== null) {
              const bundle = richBlock[richBlock.length - 1] as Record<string, unknown>;
              rawGroups = bundle["44"];
            }
            if (Array.isArray(rawGroups)) {
              const parsedCitations: CitationSource[] = [];
              for (const group of rawGroups) {
                if (!Array.isArray(group)) continue;
                const marker = Array.isArray(group[0]) ? group[0][0] : (typeof group[0] === "string" ? group[0] : undefined);
                const entries = Array.isArray(group[1]) ? group[1] : undefined;
                if (typeof marker === "string" && Array.isArray(entries)) {
                  const nums = [...marker.matchAll(/\d+/g)].map(m => parseInt(m[0], 10));
                  for (let i = 0; i < nums.length && i < entries.length; i++) {
                    const entry = entries[i];
                    let meta = Array.isArray(entry) ? entry[3] : undefined;
                    if (Array.isArray(meta) && Array.isArray(meta[0])) {
                      meta = meta[0];
                    }
                    const url = typeof meta?.[1] === "string" ? meta[1] : undefined;
                    const title = typeof meta?.[2] === "string" ? meta[2] : undefined;
                    const favicon = typeof meta?.[0] === "string" ? meta[0] : undefined;
                    if (typeof url === "string") {
                      parsedCitations.push({
                        id: `gemini-cit-${nums[i]}`,
                        url,
                        title: typeof title === "string" ? title : undefined,
                        favicon: typeof favicon === "string" ? favicon : undefined,
                        citationNumber: nums[i],
                      });
                    }
                  }
                }
              }
              if (parsedCitations.length > 0) {
                citations = parsedCitations;
              }
            }
          }
        }
        const convId = typeof inner[1] === "string" ? inner[1] : (Array.isArray(inner[1]) ? String(inner[1][0]) : "");
        const respId = typeof inner[2] === "string" ? inner[2] : (Array.isArray(inner[2]) ? String(inner[2][0]) : "");

        if (convId && respId && choiceId) {
          continuation = {
            conversationId: convId,
            responseId: respId,
            choiceId,
          };
        }
      }
    }

    if (!text && !continuation && !citations) return null;

    return {
      text,
      isFinal: false,
      continuation,
      citations,
    };
  }
}
