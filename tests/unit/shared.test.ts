import { test, describe } from "node:test";
import assert from "node:assert";
import {
  sanitizeCredentials,
  sanitizeError,
  sanitizeObject,
} from "../../src/shared/sanitizer.ts";
import {
  validateAttachments,
  DEFAULT_ATTACHMENT_OPTIONS,
} from "../../src/shared/attachmentValidator.ts";
import { AccountScopedContinuationCache } from "../../src/shared/continuationCache.ts";
import { SseStreamDecoder } from "../../src/shared/sseDecoder.ts";
import { classifyHttpError, WebProviderError } from "../../src/shared/errors.ts";
import type { ChatMessage } from "../../src/shared/types.ts";

describe("Shared Abstractions: Sanitizer", () => {
  test("redacts cookies and authorization tokens from strings", () => {
    const raw = "Cookie: __Secure-next-auth.session-token=secret123; sessionKey=sk-ant-secret; SAPISID=sapi123";
    const cleaned = sanitizeCredentials(raw);
    assert(!cleaned.includes("secret123"), "Should not contain raw next-auth token");
    assert(!cleaned.includes("sk-ant-secret"), "Should not contain raw claude session key");
    assert(!cleaned.includes("sapi123"), "Should not contain raw SAPISID");
    assert(cleaned.includes("[REDACTED]"), "Should contain redaction marker");
  });

  test("redacts error messages cleanly", () => {
    const err = new Error("Failed connecting with Bearer 1234567890abcdef123456");
    const cleaned = sanitizeError(err);
    assert(!cleaned.includes("1234567890abcdef123456"));
    assert(cleaned.includes("[REDACTED]"));
  });

  test("sanitizes objects recursively", () => {
    const obj = {
      user: "alice",
      cookie: "topsecret=1",
      nested: {
        authorization: "Bearer secret",
        safe: 42,
      },
    };
    const cleaned = sanitizeObject(obj);
    assert.strictEqual(cleaned.cookie, "[REDACTED]");
    assert.strictEqual(cleaned.nested.authorization, "[REDACTED]");
    assert.strictEqual(cleaned.nested.safe, 42);
  });
});

describe("Shared Abstractions: Attachment Validator", () => {
  test("accepts valid image and text attachments", () => {
    assert.doesNotThrow(() => {
      validateAttachments([
        {
          type: "image",
          mimeType: "image/png",
          data: new Uint8Array([1, 2, 3]),
          dimensions: { width: 800, height: 600 },
        },
        {
          type: "file",
          mimeType: "text/plain",
          url: "https://example.com/data.txt",
        },
      ]);
    });
  });

  test("rejects forbidden private/local IP URLs", () => {
    assert.throws(
      () => {
        validateAttachments([
          {
            type: "file",
            mimeType: "text/plain",
            url: "http://127.0.0.1:8080/secret",
          },
        ]);
      },
      /forbidden private\/local host/
    );

    assert.throws(
      () => {
        validateAttachments([
          {
            type: "file",
            mimeType: "text/plain",
            url: "http://localhost:3000/info",
          },
        ]);
      },
      /forbidden private\/local host/
    );
  });

  test("rejects unsupported MIME types", () => {
    assert.throws(
      () => {
        validateAttachments([
          {
            type: "file",
            mimeType: "application/x-executable",
          },
        ]);
      },
      /unsupported MIME type/
    );
  });

  test("rejects exceeding max count", () => {
    const list = Array.from({ length: 15 }, () => ({
      type: "image" as const,
      mimeType: "image/png",
    }));
    assert.throws(() => validateAttachments(list), /Too many attachments/);
  });
});

describe("Shared Abstractions: Account-Scoped Continuation Cache", () => {
  test("stores and retrieves state with matching scope and transcript", () => {
    const cache = new AccountScopedContinuationCache<{ count: number }>();
    const msgs: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];
    const hash = AccountScopedContinuationCache.computeTranscriptHash(msgs);

    cache.commit("accountA::org1::model1", hash, { count: 1 });
    const hit = cache.get("accountA::org1::model1", hash);
    assert.strictEqual(hit?.count, 1);

    // Cross-account isolation: accountB cannot read accountA's continuation
    const miss = cache.get("accountB::org1::model1", hash);
    assert.strictEqual(miss, null);
  });

  test("evicts on invalidation", () => {
    const cache = new AccountScopedContinuationCache<string>();
    const hash = "testhash";
    cache.commit("scope1", hash, "val1");
    cache.invalidate("scope1");
    assert.strictEqual(cache.get("scope1", hash), null);
  });
});

describe("Shared Abstractions: SSE Stream Decoder", () => {
  test("decodes single and multiline SSE data", () => {
    const decoder = new SseStreamDecoder();
    const raw = "event: message\ndata: line1\ndata: line2\n\nevent: done\ndata: [DONE]\n\n";
    const events = Array.from(decoder.feed(raw));
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].event, "message");
    assert.strictEqual(events[0].data, "line1\nline2");
    assert.strictEqual(events[1].event, "done");
    assert.strictEqual(events[1].data, "[DONE]");
  });

  test("handles split frame chunks cleanly", () => {
    const decoder = new SseStreamDecoder();
    const p1 = "event: ping\ndata: 1";
    const p2 = "23\n\n";

    const evts1 = Array.from(decoder.feed(p1));
    assert.strictEqual(evts1.length, 0);

    const evts2 = Array.from(decoder.feed(p2));
    assert.strictEqual(evts2.length, 1);
    assert.strictEqual(evts2[0].event, "ping");
    assert.strictEqual(evts2[0].data, "123");
  });
});

describe("Shared Abstractions: Error Classification", () => {
  test("classifies Cloudflare challenge response", () => {
    const err = classifyHttpError(403, "<title>Just a moment...</title>", "Claude Web");
    assert.strictEqual(err.code, "CHALLENGE_REQUIRED");
    assert.strictEqual(err.httpStatus, 403);
  });

  test("classifies rate limit response", () => {
    const err = classifyHttpError(429, "rate limit reached", "ChatGPT Web");
    assert.strictEqual(err.code, "RATE_LIMIT_EXCEEDED");
    assert.strictEqual(err.httpStatus, 429);
  });

  test("classifies session expiration", () => {
    const err = classifyHttpError(401, "unauthorized session expired", "Gemini Web");
    assert.strictEqual(err.code, "CREDENTIAL_FAILURE");
    assert.strictEqual(err.httpStatus, 401);
  });
});
