import React, { useMemo } from "react";
import { MessagePartPrimitive, useAuiState } from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { inlineCitations, remarkCitations } from "./citations.ts";

export function CitationText() {
  const parts = useAuiState(s => s.message.parts);
  const text = useAuiState(s => s.part.type === "text" ? s.part.text : "");
  const citations = useMemo(() => inlineCitations(parts, text), [parts, text]);
  const plugins = useMemo(() => citations.length ? [remarkCitations(citations)] : [], [citations]);

  const handlePointerOver = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement)?.closest("[data-citation-num]") as HTMLElement | null;
    if (!target) return;
    const num = target.getAttribute("data-citation-num");
    if (!num) return;
    const container = e.currentTarget;
    const highlights = container.querySelectorAll<HTMLElement>(`.pf-citation-highlight[data-citation-num="${num}"]`);
    highlights.forEach(h => h.classList.add("is-active"));
  };

  const handlePointerOut = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement)?.closest("[data-citation-num]") as HTMLElement | null;
    if (!target) return;
    const num = target.getAttribute("data-citation-num");
    if (!num) return;
    const container = e.currentTarget;
    const highlights = container.querySelectorAll<HTMLElement>(`.pf-citation-highlight[data-citation-num="${num}"]`);
    highlights.forEach(h => h.classList.remove("is-active"));
  };

  return (
    <div
      className="pf-markdown"
      onMouseEnter={handlePointerOver}
      onMouseLeave={handlePointerOut}
      onMouseOver={handlePointerOver}
      onMouseOut={handlePointerOut}
    >
      <MarkdownTextPrimitive remarkPlugins={plugins} smooth={citations.length ? false : true} />
      <MessagePartPrimitive.InProgress>
        <span className="pf-running-inline"><span className="pf-status-dot" /><span>Working on your response…</span></span>
      </MessagePartPrimitive.InProgress>
    </div>
  );
}

export function useInlineSourceIds() {
  const parts = useAuiState(s => s.message.parts);
  return useMemo(() => {
    const text = parts.filter(part => part.type === "text").map(part => part.text).join("");
    return new Set(inlineCitations(parts, text).map(citation => citation.id));
  }, [parts]);
}
