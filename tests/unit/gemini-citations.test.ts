import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { GeminiRpcDecoder } from "../../src/providers/gemini/rpcDecoder.ts";
import { readFileSync, existsSync } from "node:fs";

describe("Gemini Web: Citation and Provenance Decoding", () => {
  test("extracts citations from candidate[2][1] span-based groups", () => {
    const decoder = new GeminiRpcDecoder();
    const candidate = [
      "rc_choice_123",
      ["This is a grounded statement with provenance."],
      [
        null,
        [
          [
            ["This is a grounded statement", null, null, [[0, 28]]],
            [1],
            [
              [
                "https://en.wikipedia.org/wiki/Test",
                "Wikipedia - Test Page",
                "https://example.com/favicon.ico",
                "Snippet of text from Wikipedia source...",
                null,
                null,
                "Wikipedia",
              ],
            ],
            "spp_id_1",
          ],
        ],
      ],
    ];

    const inner = [null, "c_conv_id", "r_resp_id", null, [candidate]];
    const envelope = JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
    const wire = `)]}'\n${envelope.length}\n${envelope}\n`;

    const chunks = [...decoder.feed(wire)];
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].text, "This is a grounded statement with provenance.");
    assert.ok(chunks[0].citations);
    assert.strictEqual(chunks[0].citations.length, 1);

    const cit = chunks[0].citations[0];
    assert.strictEqual(cit.url, "https://en.wikipedia.org/wiki/Test");
    assert.strictEqual(cit.title, "Wikipedia - Test Page");
    assert.strictEqual(cit.favicon, "https://example.com/favicon.ico");
    assert.strictEqual(cit.startIndex, 0);
    assert.strictEqual(cit.endIndex, 28);
    assert.strictEqual(cit.snippet, "Snippet of text from Wikipedia source...");
    assert.strictEqual(cit.citationNumber, 1);
  });

  test("extracts citations from rich content block field 43 / sparse bundle fallback", () => {
    const decoder = new GeminiRpcDecoder();
    const richBlock = Array(44).fill(null);
    richBlock[43] = [
      [
        [" [cite: 1, 2]"],
        [
          [null, null, null, ["https://example.com/fav1.ico", "https://example.com/source1", "Source One"]],
          [null, null, null, ["https://example.com/fav2.ico", "https://example.com/source2", "Source Two"]],
        ],
      ],
    ];

    const candidate = [
      "rc_choice_fallback",
      ["Answer text [cite: 1, 2]"],
      null, // No candidate[2]
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      richBlock, // candidate[12]
    ];

    const inner = [null, "c_conv_id", "r_resp_id", null, [candidate]];
    const envelope = JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
    const wire = `)]}'\n${envelope.length}\n${envelope}\n`;

    const chunks = [...decoder.feed(wire)];
    assert.strictEqual(chunks.length, 1);
    assert.ok(chunks[0].citations);
    assert.strictEqual(chunks[0].citations.length, 2);
    assert.strictEqual(chunks[0].citations[0].url, "https://example.com/source1");
    assert.strictEqual(chunks[0].citations[0].title, "Source One");
    assert.strictEqual(chunks[0].citations[0].citationNumber, 1);
    assert.strictEqual(chunks[0].citations[1].url, "https://example.com/source2");
    assert.strictEqual(chunks[0].citations[1].title, "Source Two");
    assert.strictEqual(chunks[0].citations[1].citationNumber, 2);
  });

  test("correctly decodes real captured response body if available", () => {
    const captureFile = "/tmp/ultraroute-gemini-capture-40uXaN/0002-StreamGenerate.body";
    if (!existsSync(captureFile)) return;

    const wire = readFileSync(captureFile, "utf8");
    const decoder = new GeminiRpcDecoder();
    const chunks = [...decoder.feed(wire)];

    assert.ok(chunks.length > 0);
    const chunkWithCitations = chunks.find(c => c.citations && c.citations.length > 0);
    assert.ok(chunkWithCitations, "Must extract citations from captured StreamGenerate body");
    assert.strictEqual(chunkWithCitations.citations!.length, 5);

    const firstCit = chunkWithCitations.citations![0];
    assert.ok(firstCit.url.includes("wiktionary.org"));
    assert.strictEqual(firstCit.startIndex, 0);
    assert.strictEqual(firstCit.endIndex, 98);
    assert.strictEqual(firstCit.citationNumber, 1);
  });
});
