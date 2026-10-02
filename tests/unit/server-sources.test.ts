import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readUIMessageStream } from "ai";
import type { UIMessageChunk, UIMessage } from "ai";
import { createProviderUIMessageStreamResponse } from "../../src/server/uiStream.ts";
import type { ChatCompletionResponse } from "../../src/shared/types.ts";

describe("Chat server: Source-URL stream emission", () => {
  test("emits source-url events with providerMetadata for choices containing citations", async () => {
    const mockResponse: ChatCompletionResponse = {
      id: "test-id",
      object: "chat.completion",
      created: 12345,
      model: "gemini-web:test",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Here is grounded info.",
            citations: [
              {
                id: "gemini-cit-1-1",
                url: "https://en.wikipedia.org/wiki/Testing",
                title: "Software testing - Wikipedia",
                startIndex: 0,
                endIndex: 22,
                citationNumber: 1,
              },
            ],
          },
          finish_reason: "stop",
        },
      ],
    };

    const sseResponse = createProviderUIMessageStreamResponse(mockResponse);
    const raw = await sseResponse.text();
    assert.ok(raw.includes("source-url"));
    assert.ok(raw.includes("https://en.wikipedia.org/wiki/Testing"));

    const chunks: UIMessageChunk[] = raw.split("\n\n").flatMap((frame) => {
      if (!frame.startsWith("data: ") || frame === "data: [DONE]") return [];
      return [JSON.parse(frame.slice(6)) as UIMessageChunk];
    });

    let finalMessage: UIMessage | undefined;
    for await (const update of readUIMessageStream({
      stream: new ReadableStream<UIMessageChunk>({
        start(controller) {
          chunks.forEach((c) => controller.enqueue(c));
          controller.close();
        },
      }),
    })) {
      finalMessage = structuredClone(update);
    }

    assert.ok(finalMessage);
    const sourcePart = finalMessage.parts.find((p) => p.type === "source-url");
    assert.ok(sourcePart);
    if (sourcePart && sourcePart.type === "source-url") {
      assert.strictEqual(sourcePart.url, "https://en.wikipedia.org/wiki/Testing");
      assert.strictEqual(sourcePart.title, "Software testing - Wikipedia");
      const geminiMeta = sourcePart.providerMetadata?.gemini;
      const citationNumber =
        geminiMeta && typeof geminiMeta === "object" && "citationNumber" in geminiMeta
          ? geminiMeta.citationNumber
          : undefined;
      assert.strictEqual(citationNumber, 1);
    }
  });
});
