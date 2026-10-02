import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { inlineCitations, remarkCitations } from "../../src/client/citations.ts";

function render(text: string, start: number, end: number) {
  const citation = { id: "source-1", url: "https://example.com/source", title: "Example Domain", favicon: "https://example.com/fav.png", startIndex: start, endIndex: end, citationNumber: 1 };
  return renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkCitations([citation])], children: text }));
}

test("citation highlights cross bold and italic without breaking Markdown and marker precedes following prose", () => {
  const text = '**Obamna** is an *internet* meme. Uncited sentence.';
  const end = text.indexOf(' Uncited');
  const html = render(text, 0, end);
  assert.match(html, /<strong><span class="pf-citation-highlight pf-citation-tone-0" data-citation-num="1">Obamna<\/span><\/strong>/);
  assert.match(html, /<em><span class="pf-citation-highlight pf-citation-tone-0" data-citation-num="1">internet<\/span><\/em>/);
  assert.match(html, /meme\.<\/span><span class="pf-citation-marker pf-citation-tone-0" data-citation-num="1"><a href="https:\/\/example\.com\/source"[^>]*><img[^>]*class="pf-citation-favicon"[^>]*>Example Domain<\/a><\/span> Uncited sentence\./);
});

test("partial span boundaries and decoded entities preserve surrounding text", () => {
  const text = 'Before alpha &amp; beta after.';
  const start = text.indexOf('alpha');
  const end = text.indexOf(' after');
  const html = render(text, start, end);
  assert.match(html, /Before <span class="pf-citation-highlight pf-citation-tone-0" data-citation-num="1">alpha (?:&amp;|&#x26;) beta<\/span><span class="pf-citation-marker pf-citation-tone-0"/);
  assert.match(html, /<\/span> after\./);
});

test("citation links do not nest inside existing Markdown links", () => {
  const text = '[A cited page](https://example.com/page) follows.';
  const html = render(text, 0, text.indexOf(' follows'));
  assert.match(html, /<a href="https:\/\/example.com\/page"><span class="pf-citation-highlight pf-citation-tone-0" data-citation-num="1">A cited page<\/span><\/a><span class="pf-citation-marker/);
});

test("invalid or unsafe source ranges remain unanchored rather than hiding their source", () => {
  const source = { type: "source", id: "valid", url: "https://example.com", providerMetadata: { gemini: { startIndex: 0, endIndex: 5, citationNumber: 1 } } };
  assert.equal(inlineCitations([source], 'hello').length, 1);
  assert.deepEqual(inlineCitations([{ ...source, url: 'javascript:alert(1)' }], 'hello'), []);
  assert.deepEqual(inlineCitations([source], 'hi'), []);
});
