import { decodeString } from "micromark-util-decode-string";
import type { Root } from "mdast";
import type { CitationSource } from "../shared/types.ts";

export interface InlineCitation extends CitationSource {
  startIndex: number;
  endIndex: number;
  citationNumber: number;
}

export function inlineCitations(parts: readonly unknown[], text: string): InlineCitation[] {
  const citations: InlineCitation[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object" || !("type" in part) || part.type !== "source" || !("url" in part) || typeof part.url !== "string" || !("id" in part) || typeof part.id !== "string") continue;
    let url: URL;
    try { url = new URL(part.url); } catch { continue; }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    if (!("providerMetadata" in part) || !part.providerMetadata || typeof part.providerMetadata !== "object" || !("gemini" in part.providerMetadata)) continue;
    const geminiRaw = part.providerMetadata.gemini;
    if (!geminiRaw || typeof geminiRaw !== "object") continue;
    const meta = geminiRaw as Record<string, unknown>;
    const start = meta.startIndex;
    const end = meta.endIndex;
    if (typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) continue;
    const number = typeof meta.citationNumber === "number" ? meta.citationNumber : citations.length + 1;
    const favicon = typeof meta.favicon === "string" ? meta.favicon : undefined;
    const title = "title" in part && typeof part.title === "string" ? part.title : url.hostname.replace(/^www\./, "");
    citations.push({ id: part.id, url: part.url, title, favicon, startIndex: start, endIndex: end, citationNumber: number });
  }
  return citations;
}

interface Node {
  type: string;
  value?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hName?: string; hProperties?: Record<string, unknown> };
  url?: string;
}

// Resolve Markdown escapes/entities without confusing raw-source offsets with
// displayed character positions. Bold/italic nodes keep their original structure.
function textOffsets(raw: string, start: number) {
  const spans: Array<{ start: number; end: number }> = [];
  let decoded = "";
  const tokens = /\\[!-/:-@\[-`{-~]|&(?:#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);/g;
  let cursor = 0;
  for (const match of raw.matchAll(tokens)) {
    for (let i = cursor; i < match.index; i++) { decoded += raw[i]; spans.push({ start: start + i, end: start + i + 1 }); }
    const value = decodeString(match[0]);
    decoded += value;
    for (let i = 0; i < value.length; i++) spans.push({ start: start + match.index, end: start + match.index + match[0].length });
    cursor = match.index + match[0].length;
  }
  for (let i = cursor; i < raw.length; i++) { decoded += raw[i]; spans.push({ start: start + i, end: start + i + 1 }); }
  return { decoded, spans };
}

export function remarkCitations(citations: readonly InlineCitation[]) {
  return () => (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    const pending = new Set(citations);
    const colorClass = (citation: InlineCitation) => `pf-citation-tone-${(citation.citationNumber - 1) % 5}`;
    const markers = (end: number): Node[] => {
      const result: Node[] = [];
      for (const citation of pending) {
        if (citation.endIndex > end) continue;
        pending.delete(citation);
        const children: Node[] = [];
        if (citation.favicon) {
          children.push({
            type: "image",
            url: citation.favicon,
            data: { hProperties: { className: ["pf-citation-favicon"], alt: "", width: 12, height: 12 } },
          });
        }
        const displayTitle = citation.title || "Source";
        const labelText = displayTitle.length > 20 ? `${displayTitle.slice(0, 18)}…` : displayTitle;
        children.push({ type: "text", value: labelText });
        result.push({
          type: "citationMarker",
          data: {
            hName: "span",
            hProperties: {
              className: ["pf-citation-marker", colorClass(citation)],
              "data-citation-num": String(citation.citationNumber),
            },
          },
          children: [
            {
              type: "link",
              url: citation.url,
              data: {
                hProperties: {
                  className: ["pf-citation-link"],
                  title: citation.title,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  ariaLabel: `Source ${citation.citationNumber}: ${citation.title}`,
                  "data-citation-num": String(citation.citationNumber),
                },
              },
              children,
            },
          ],
        });
      }
      return result;
    };
    const visit = (parent: Node, allowMarkers = true) => {
      if (!parent.children) return;
      const output: Node[] = [];
      for (const child of parent.children) {
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        if (child.type === "text" && typeof start === "number" && typeof end === "number" && child.value) {
          const mapped = textOffsets(source.slice(start, end), start);
          if (mapped.decoded === child.value) {
            let buffer = "";
            let active: InlineCitation | undefined;
            const flush = () => {
              if (!buffer) return;
              const text: Node = { type: "text", value: buffer };
              output.push(active ? { type: "citationHighlight", data: { hName: "span", hProperties: { className: ["pf-citation-highlight", colorClass(active)], "data-citation-num": String(active.citationNumber) } }, children: [text] } : text);
              buffer = "";
            };
            for (let i = 0; i < child.value.length; i++) {
              const span = mapped.spans[i];
              const next = citations.find(c => span.start < c.endIndex && span.end > c.startIndex);
              if (next !== active) { flush(); active = next; }
              buffer += child.value[i];
              if (allowMarkers && [...pending].some(c => c.endIndex <= span.end)) { flush(); output.push(...markers(span.end)); }
            }
            flush();
            continue;
          }
        }
        visit(child, allowMarkers && child.type !== "link" && child.type !== "linkReference");
        if (child.type === "inlineCode" && typeof start === "number" && typeof end === "number") {
          const citation = citations.find(c => start < c.endIndex && end > c.startIndex);
          if (citation) child.data = { ...child.data, hProperties: { ...child.data?.hProperties, className: ["pf-citation-highlight", colorClass(citation)], "data-citation-num": String(citation.citationNumber) } };
        }
        output.push(child);
        if (allowMarkers && typeof end === "number" && ["text", "strong", "emphasis", "delete", "link", "linkReference", "inlineCode"].includes(child.type)) output.push(...markers(end));
        if (allowMarkers && typeof end === "number" && child.children && ["paragraph", "heading"].includes(child.type)) child.children.push(...markers(end));
      }
      parent.children = output;
    };
    // mdast custom nodes intentionally carry hName/hProperties for remark-rehype.
    visit(tree as unknown as Node);
  };
}
