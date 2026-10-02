import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import {
  parseChatGptWebFirstPartyModuleContract,
  collectChatGptWebFirstPartyAssetCandidates,
  extractChatGptWebFirstPartyAssetReferences,
  collectBridgeFailureSignals,
  describeBridgeLoadFailure,
  chatGptWebBridgeFailureDetails,
  readChatGptWebFirstPartyAssetSource,
  requireChatGptWebUploadUrl,
  executeChatGptWebFirstPartyTurn,
} from "../../src/providers/chatgpt/firstParty.ts";
import { UpstreamDriftError } from "../../src/shared/errors.ts";

const asset = "https://chatgpt.com/cdn/assets/fixture.js";
const fixture = (
  finalize: string,
  proof: string,
  turnstile: string,
  client: string,
  headers: string,
) =>
  [
    `function ${finalize}(e=!1,t=\`none\`,n=mode.current){return finish(\`finalized\`,e,t,n)}`,
    `Promise.all([${proof}.getEnforcementToken(t,{forceSync:!0}),${turnstile}.getEnforcementToken(t)])`,
    `${client}.safePost(\`/sentinel/chat-requirements/prepare\`,{})`,
    `function ${headers}(e,t,n,r,i,a){let o={};return e?.token?o[\`OpenAI-Sentinel-Chat-Requirements-Token\`]:o}`,
    `export { ${finalize} as ready, ${proof} as pow, ${turnstile} as gate, ${client} as api, ${headers} as hdr };`,
  ].join(";");

describe("ChatGPT first-party semantic contract", () => {
  test("discovers changed minified locals and exported aliases, including optional third parameter", () => {
    for (const names of [
      ["f", "p", "t", "c", "h"],
      ["$a", "xx", "yy", "zz", "_headers"],
    ]) {
      assert.deepEqual(
        parseChatGptWebFirstPartyModuleContract(
          fixture(...(names as [string, string, string, string, string])),
        ),
        {
          finalizeRequirements: "ready",
          proofManager: "pow",
          turnstileManager: "gate",
          requestClient: "api",
          buildSentinelHeaders: "hdr",
        },
      );
    }
    const old = fixture("f", "p", "t", "c", "h")
      .replace(",n=mode.current", "")
      .replace(",e,t,n)", ",e,t)");
    assert.equal(
      parseChatGptWebFirstPartyModuleContract(old).finalizeRequirements,
      "ready",
    );
  });
  test("fails closed for missing semantics or missing exports without returning source", () => {
    for (const source of [
      "<html>cookie=FAKE_SECRET</html>",
      fixture("f", "p", "t", "c", "h").replace("h as hdr", "unknown as hdr"),
    ]) {
      assert.throws(
        () => parseChatGptWebFirstPartyModuleContract(source),
        (error: unknown) => {
          assert(error instanceof UpstreamDriftError);
          assert.equal(error.cause, undefined);
          assert(!JSON.stringify(error).includes("FAKE_SECRET"));
          return true;
        },
      );
    }
  });
  test("filters candidates and references to uncredentialed first-party assets only", () => {
    assert.deepEqual(
      collectChatGptWebFirstPartyAssetCandidates(
        [
          asset,
          "https://evil.test/cdn/assets/fixture.js",
          "https://secret@chatgpt.com/cdn/assets/fixture.js",
          `${asset}?token=FAKE_SECRET`,
        ],
        [asset],
      ),
      [asset],
    );
    assert.deepEqual(
      extractChatGptWebFirstPartyAssetReferences(
        `import './child.js';import './child.js';import '../private.js';import 'https://evil.test/a.js'`,
        asset,
      ),
      ["https://chatgpt.com/cdn/assets/child.js"],
    );
  });
});

describe("ChatGPT safe bridge diagnostics", () => {
  test("captures relevant failed requests/status and detaches every handler", () => {
    const page = new EventEmitter();
    const collected = collectBridgeFailureSignals(
      page as unknown as Page,
      asset,
    );
    page.emit("requestfailed", {
      url: () => "https://irrelevant.test/FAKE_SECRET",
      failure: () => ({ errorText: "FAKE_SECRET" }),
    });
    assert.deepEqual(collected.signals, []);
    page.emit("requestfailed", {
      url: () => asset,
      failure: () => ({ errorText: "Cookie: FAKE_SECRET" }),
    });
    page.emit("pageerror", new Error("Cookie: FAKE_SECRET"));
    page.emit("response", { url: () => asset, status: () => 403 });
    assert.deepEqual(collected.signals, [
      { kind: "requestfailed" },
      { kind: "evaluation" },
      { kind: "asset-status", status: 403 },
    ]);
    assert.match(
      describeBridgeLoadFailure(collected.signals),
      /asset status: 403/,
    );
    assert.deepEqual(chatGptWebBridgeFailureDetails(collected.signals), {
      category: "bridge-load",
      reason: "asset-status",
      status: 403,
    });
    collected.dispose();
    for (const event of ["requestfailed", "pageerror", "response"])
      assert.equal(page.listenerCount(event), 0);
  });
  test("ranks CSP and never trusts arbitrary diagnostic values", () => {
    assert.match(
      describeBridgeLoadFailure([
        { kind: "requestfailed", detail: "FAKE_SECRET" },
        { kind: "csp", detail: "script-src-elem" },
      ]),
      /CSP: script-src-elem/,
    );
    assert.deepEqual(
      chatGptWebBridgeFailureDetails([
        { kind: "requestfailed" },
        { kind: "csp", detail: "script-src-elem" },
      ]),
      { category: "bridge-load", reason: "csp", directive: "script-src-elem" },
    );
    for (const signals of [
      [{ kind: "csp" as const, detail: "script-src Cookie: FAKE_SECRET" }],
      [
        {
          kind: "asset-status" as const,
          status: "FAKE_SECRET" as unknown as number,
        },
      ],
      [{ kind: "evaluation" as const, detail: "<html>FAKE_SECRET</html>" }],
    ]) {
      assert(!describeBridgeLoadFailure(signals).includes("FAKE_SECRET"));
      assert(
        !JSON.stringify(chatGptWebBridgeFailureDetails(signals)).includes(
          "FAKE_SECRET",
        ),
      );
    }
  });
});

describe("ChatGPT bounded asset loading and upload destination", () => {
  test("rejects redirects, hostile destinations, response errors and oversized streamed bodies safely", async () => {
    await assert.rejects(
      readChatGptWebFirstPartyAssetSource(asset, async (_url, init) => {
        assert.equal(init?.redirect, "error");
        assert.equal(init?.credentials, "omit");
        throw new Error("redirect URL contains FAKE_SECRET");
      }),
      (error: unknown) =>
        error instanceof UpstreamDriftError &&
        error.details?.category === "asset-request" &&
        error.cause === undefined &&
        !error.message.includes("FAKE_SECRET"),
    );
    await assert.rejects(
      readChatGptWebFirstPartyAssetSource(
        asset,
        async () => new Response("<html>FAKE_SECRET</html>", { status: 403 }),
      ),
      (error: unknown) =>
        error instanceof UpstreamDriftError &&
        error.details?.status === 403 &&
        !error.message.includes("FAKE_SECRET"),
    );
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(24 * 1024 * 1024 + 1));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    await assert.rejects(
      readChatGptWebFirstPartyAssetSource(asset, async () => response),
      /size limit/,
    );
    assert.equal(cancelled, true);
    await assert.rejects(
      readChatGptWebFirstPartyAssetSource(
        asset,
        () => Promise.withResolvers<Response>().promise,
        5,
      ),
      (error: unknown) =>
        error instanceof UpstreamDriftError &&
        error.details?.category === "asset-timeout",
    );
    for (const url of [
      "invalid FAKE_SECRET",
      "http://files.oaiusercontent.com/x",
      "https://evil-oaiusercontent.com/x",
      "https://oaiusercontent.com.evil.test/x",
      "https://FAKE_SECRET@files.oaiusercontent.com/x",
      "https://files.oaiusercontent.com:8443/x",
    ]) {
      assert.throws(
        () => requireChatGptWebUploadUrl(url),
        (error: unknown) =>
          error instanceof UpstreamDriftError &&
          !error.message.includes("FAKE_SECRET") &&
          error.cause === undefined,
      );
    }
    assert.equal(
      requireChatGptWebUploadUrl(
        "https://files.oaiusercontent.com/x?signature=fixture",
      ),
      "https://files.oaiusercontent.com/x?signature=fixture",
    );
  });
});

test("first-party turns use normal page functions, temporary multimodal drafts and clean every request scope", async () => {
  const root = globalThis as typeof globalThis & Record<string, unknown>;
  const bridgeKey = "__ultrarouteChatGptFirstPartyV1";
  const abortKey = "__ultrarouteChatGptAbortV1";
  const requestKey = "__ultrarouteChatGptRequestV1";
  const bodies: Record<string, unknown>[] = [];
  root[bridgeKey] = {
    finalizeRequirements: async () => ({ token: "fixture-requirements" }),
    proofManager: { getEnforcementToken: async () => "fixture-proof" },
    turnstileManager: { getEnforcementToken: async () => "fixture-page-token" },
    buildSentinelHeaders: () => ({
      "OpenAI-Sentinel-Chat-Requirements-Token": "fixture-requirements",
    }),
    requestClient: {
      safePost: async (path: string, options: Record<string, unknown>) => {
        assert.equal(path, "/f/conversation");
        bodies.push(options.requestBody as Record<string, unknown>);
        return new Response('data: {"answer":"fixture"}\n\ndata: [DONE]\n\n');
      },
    },
  };
  const page = {
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
  } as unknown as Page;
  try {
    const result = await executeChatGptWebFirstPartyTurn(page, {
      prompt: "hello",
      attachments: [],
      selection: { kind: "picker", modelLabel: "GPT-5.6 Sol", effortIndex: 4 },
    });
    assert.equal(result, 'data: {"answer":"fixture"}\n\ndata: [DONE]\n\n');
    assert.equal(bodies[0].model, "gpt-5-6-pro");
    assert.equal(bodies[0].history_and_training_disabled, true);
    assert.deepEqual(bodies[0].system_hints, []);
    await executeChatGptWebFirstPartyTurn(page, {
      prompt: "think",
      attachments: [],
      selection: { kind: "free", thinkEnabled: true },
    });
    assert.equal(bodies[1].model, "auto");
    assert.deepEqual(bodies[1].system_hints, ["reason"]);
    assert.deepEqual(root[abortKey], {});
    assert.deepEqual(root[requestKey], {});
    const bridge = root[bridgeKey];
    assert(bridge && typeof bridge === "object" && "requestClient" in bridge);
    bridge.requestClient = {
      safePost: async () => {
        throw new Error("cookie=FAKE_SECRET internal-id=FAKE_SECRET");
      },
    };
    await assert.rejects(
      executeChatGptWebFirstPartyTurn(page, {
        prompt: "failure",
        attachments: [],
        selection: { kind: "free", thinkEnabled: false },
      }),
      (error: unknown) =>
        error instanceof UpstreamDriftError &&
        error.cause === undefined &&
        !error.message.includes("FAKE_SECRET"),
    );
    assert.deepEqual(root[abortKey], {});
    assert.deepEqual(root[requestKey], {});
  } finally {
    delete root[bridgeKey];
    delete root[abortKey];
    delete root[requestKey];
  }
});
