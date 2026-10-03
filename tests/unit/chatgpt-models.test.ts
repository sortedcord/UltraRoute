import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ChatGptWebAdapter,
  type ChatGptAdapterDeps,
} from "../../src/providers/chatgpt/adapter.ts";
import { parseChatGptModelCatalog } from "../../src/providers/chatgpt/models.ts";
import {
  CredentialError,
  InvalidRequestError,
  UpstreamDriftError,
} from "../../src/shared/errors.ts";
import { ModelCatalogCache } from "../../src/shared/modelCatalogCache.ts";
import {
  chatGptNativeCatalog,
  chatGptCatalogDeps,
} from "../fixtures/chatgptModels.ts";
import type { ChatGptWebSelection } from "../../src/providers/chatgpt/firstParty.ts";

const success =
  'event: delta_encoding\ndata: "v1"\n\nevent: delta\ndata: {"p":"","o":"add","v":{"message":{"author":{"role":"assistant"},"content":{"parts":["Done"]},"status":"finished_successfully","end_turn":true}}}\n\ndata: [DONE]\n\n';

test("native versions preserve future family, display labels, order and exact preset slugs", () => {
  const upstream = chatGptNativeCatalog();
  upstream.versions.push({
    ...structuredClone(upstream.versions[0]),
    id: "5.5",
    display_text_for_intelligence: "Earlier native family",
    slugs: ["older-fast", "older-think"],
    intelligence_presets: [
      {
        id: 0,
        title: "Instant",
        model_slug: "older-fast",
        lane: "instant",
        preset_type: "available",
      },
      {
        id: 1,
        title: "Medium",
        model_slug: "older-think",
        lane: "thinking",
        thinking_effort: "standard",
        preset_type: "available",
      },
      {
        id: 2,
        title: "High",
        model_slug: "older-think",
        lane: "thinking",
        thinking_effort: "extended",
        preset_type: "available",
      },
    ],
  });
  const catalog = parseChatGptModelCatalog(upstream);
  assert.deepEqual(
    catalog.models.map((model) => [model.id, model.name]),
    [
      ["chatgpt-web:5.7", "Future GPT 5.7 · Native"],
      ["chatgpt-web:5.5", "Earlier native family"],
    ],
  );
  assert.deepEqual(catalog.models[0].reasoningLevels, [
    {
      value: "none",
      label: "Instant",
      model: "native-fast-route",
      disabled: false,
    },
    {
      value: "medium",
      label: "Medium",
      model: "native-deliberate-route",
      thinkingEffort: "standard",
      disabled: false,
    },
    {
      value: "high",
      label: "High",
      model: "native-deliberate-route",
      thinkingEffort: "extended",
      disabled: false,
    },
  ]);
  assert.equal(catalog.defaultModel, "chatgpt-web:5.7");
  assert.equal(catalog.models[0].defaultReasoningLevel, "none");
  assert.equal(catalog.models[0].capabilities.maxContextTokens, 52_815);
  assert.deepEqual(catalog.models[0].capabilities.supportedThinkingEfforts, [
    "none",
    "medium",
    "high",
  ]);
});

test("native defaults choose exact matching preset then first available for base alias", () => {
  const upstream = chatGptNativeCatalog();
  upstream.default_model_slug = "native-deliberate-route";
  assert.equal(
    parseChatGptModelCatalog(upstream).models[0].defaultReasoningLevel,
    "medium",
  );
  upstream.versions[0].intelligence_presets[1].preset_type = "locked";
  assert.equal(
    parseChatGptModelCatalog(upstream).models[0].defaultReasoningLevel,
    "high",
  );
  upstream.default_model_slug = "native-family-alias";
  assert.equal(
    parseChatGptModelCatalog(upstream).models[0].defaultReasoningLevel,
    "none",
  );
});

test("locked and unknown availability presets stay visible but cannot become available defaults", () => {
  const upstream = chatGptNativeCatalog();
  upstream.versions[0].intelligence_presets[0].preset_type =
    "future-availability";
  upstream.versions[0].intelligence_presets[2].preset_type = "locked";
  const family = parseChatGptModelCatalog(upstream).models[0];
  assert.deepEqual(
    family.reasoningLevels.map((level) => level.disabled),
    [true, false, true],
  );
  assert.equal(family.defaultReasoningLevel, "medium");
  assert.deepEqual(family.capabilities.supportedThinkingEfforts, ["medium"]);
  upstream.versions[0].intelligence_presets[1].preset_type = "locked";
  const locked = parseChatGptModelCatalog(upstream);
  assert.equal(locked.models[0].disabled, true);
  assert.equal(locked.models[0].defaultReasoningLevel, undefined);
  assert.equal(locked.defaultModel, undefined);
  upstream.versions[0].enabled = false;
  assert.equal(parseChatGptModelCatalog(upstream).models[0].disabled, true);
});

test("unknown native effort is unsupported rather than inferred from label or slug", () => {
  const upstream = chatGptNativeCatalog();
  upstream.versions[0].intelligence_presets[2].thinking_effort =
    "future-extreme";
  assert.deepEqual(
    parseChatGptModelCatalog(upstream).models[0].reasoningLevels.map(
      (level) => level.value,
    ),
    ["none", "medium"],
  );
});

test("malformed and empty versions fail without unrelated or deprecated models fallback", () => {
  for (const payload of [
    {},
    { models: chatGptNativeCatalog().models },
    { models: chatGptNativeCatalog().models, versions: [] },
  ])
    assert.throws(() => parseChatGptModelCatalog(payload), UpstreamDriftError);
  const upstream = chatGptNativeCatalog();
  upstream.versions[0].intelligence_presets[0].model_slug = "hidden-mini";
  assert.throws(() => parseChatGptModelCatalog(upstream), UpstreamDriftError);
  upstream.versions[0].intelligence_presets[0].model_slug = "native-fast-route";
  assert.throws(
    () =>
      parseChatGptModelCatalog({
        ...upstream,
        versions: [{ ...upstream.versions[0], enabled: "true" }],
      }),
    UpstreamDriftError,
  );
  assert.throws(
    () =>
      parseChatGptModelCatalog({
        ...upstream,
        versions: [upstream.versions[0], upstream.versions[0]],
      }),
    UpstreamDriftError,
  );
  assert.throws(
    () =>
      parseChatGptModelCatalog({
        ...upstream,
        versions: [{ ...upstream.versions[0], intelligence_presets: [] }],
      }),
    UpstreamDriftError,
  );
  upstream.versions[0].intelligence_presets.forEach((preset) => {
    preset.lane = "unsupported";
  });
  assert.throws(() => parseChatGptModelCatalog(upstream), UpstreamDriftError);
});

test("execution sends native slug and effort for all available levels and omitted native default", async () => {
  const selections: ChatGptWebSelection[] = [];
  const adapter = new ChatGptWebAdapter({
    ...chatGptCatalogDeps(),
    transportSession: {
      async executeDirectTurn(payload) {
        assert.ok(
          payload && typeof payload === "object" && "selection" in payload,
        );
        const selection = payload.selection;
        assert.ok(
          selection &&
            typeof selection === "object" &&
            "model" in selection &&
            typeof selection.model === "string",
        );
        selections.push({
          model: selection.model,
          ...("thinkingEffort" in selection &&
          typeof selection.thinkingEffort === "string"
            ? { thinkingEffort: selection.thinkingEffort }
            : {}),
        });
        return success;
      },
      async executeWebSocketTurn() {
        throw new Error("Unexpected handoff");
      },
    },
  });
  for (const effort of [undefined, "none", "medium", "high"] as const) {
    const result = await adapter.execute(
      {
        model: "chatgpt-web:5.7",
        reasoning_effort: effort,
        messages: [{ role: "user", content: "Native choice" }],
      },
      "session=fixture",
    );
    assert.ok("choices" in result);
    assert.equal(result.model, "chatgpt-web:5.7");
    assert.equal(result.choices[0].message.content, "Done");
  }
  assert.deepEqual(selections, [
    { model: "native-fast-route" },
    { model: "native-fast-route" },
    { model: "native-deliberate-route", thinkingEffort: "standard" },
    { model: "native-deliberate-route", thinkingEffort: "extended" },
  ]);
});

test("unknown, unsupported and locked requests reject before attachment fetch and turn acquisition", async () => {
  const upstream = chatGptNativeCatalog();
  upstream.versions[0].intelligence_presets[2].preset_type = "locked";
  let acquired = 0;
  const deps = chatGptCatalogDeps();
  deps.modelCatalogSource.fetchModels = async () => upstream;
  const adapter = new ChatGptWebAdapter({
    ...deps,
    transportFactory: async () => {
      acquired++;
      throw new Error("Must not acquire");
    },
  });
  for (const choice of [
    { model: "gpt-5-6", reasoning_effort: "none" },
    { model: "chatgpt-web:5.7", reasoning_effort: "low" },
    { model: "chatgpt-web:5.7", reasoning_effort: "high" },
  ] as const) {
    await assert.rejects(
      adapter.execute(
        {
          ...choice,
          messages: [{ role: "user", content: "Invalid choice" }],
          attachments: [
            {
              type: "image",
              mimeType: "image/png",
              url: "https://invalid.example/must-not-fetch",
            },
          ],
        },
        "session=fixture",
      ),
      InvalidRequestError,
    );
  }
  upstream.versions[0].enabled = false;
  await adapter.refreshCatalog("session=fixture");
  await assert.rejects(
    adapter.execute(
      {
        model: "chatgpt-web:5.7",
        messages: [{ role: "user", content: "Disabled family" }],
      },
      "session=fixture",
    ),
    InvalidRequestError,
  );
  assert.equal(acquired, 0);
});

test("catalog requires discovery source with no static fallback and empty identity never caches", async () => {
  await assert.rejects(
    new ChatGptWebAdapter().discoverModels("session=fixture"),
    /catalog source is not configured/,
  );
  const deps = chatGptCatalogDeps();
  deps.modelCatalogSource.getAccountIdentity = async () => "";
  deps.modelCatalogSource.fetchModels = async () => {
    throw new Error("Must not fetch without identity");
  };
  await assert.rejects(
    new ChatGptWebAdapter(deps).getCatalog("session=fixture"),
    UpstreamDriftError,
  );
});

test("ChatGPT native catalogs reuse cache across restart, retain stale values and isolate account identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatgpt-catalog-"));
  try {
    const path = join(directory, "catalogs.json");
    let account = "account-first";
    let loads = 0;
    let fail = false;
    const source = {
      async getAccountIdentity() {
        return account;
      },
      async fetchModels() {
        loads++;
        if (fail) throw new Error("session=secret-fixture upstream failure");
        const payload = chatGptNativeCatalog();
        if (account === "account-second")
          payload.versions[0].id = "other/family";
        return payload;
      },
    };
    const adapter = new ChatGptWebAdapter({
      modelCatalogSource: source,
      modelCatalogCache: new ModelCatalogCache(path),
    });
    const initial = await adapter.getCatalog("session=fixture");
    assert.equal(initial.catalog.defaultModel, "chatgpt-web:5.7");
    await adapter.getCatalog("session=rotated-fixture");
    assert.equal(loads, 1);
    fail = true;
    const stale = await adapter.refreshCatalog("session=fixture");
    assert.deepEqual(stale.catalog, initial.catalog);
    assert.equal(stale.status.stale, true);
    assert.equal(stale.status.lastError, "Catalog refresh failed");
    const restarted = new ChatGptWebAdapter({
      modelCatalogSource: source,
      modelCatalogCache: new ModelCatalogCache(path),
    });
    const restored = await restarted.getCatalog("session=changed-again");
    assert.deepEqual(restored, stale);
    assert.equal(loads, 2);
    account = "account-second";
    await assert.rejects(
      restarted.getCatalog("session=fixture"),
      /upstream failure/,
    );
    fail = false;
    const other = await restarted.getCatalog("session=fixture");
    assert.equal(other.catalog.defaultModel, "chatgpt-web:other%2Ffamily");
    account = "account-first";
    assert.equal(
      (await restarted.getCatalog("session=fixture")).catalog.defaultModel,
      "chatgpt-web:5.7",
    );
    assert.equal(loads, 4);
    const serialized = await readFile(path, "utf8");
    for (const secret of [
      "account-first",
      "account-second",
      "session=",
      "secret-fixture",
    ])
      assert.equal(serialized.includes(secret), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("account changes during discovery cannot commit a foreign catalog under the original scope", async () => {
  const cache = new ModelCatalogCache();
  let account = "account-before";
  let switchDuringFetch = true;
  const source: NonNullable<ChatGptAdapterDeps["modelCatalogSource"]> = {
    async getAccountIdentity() {
      return account;
    },
    async fetchModels(_state, _signal, expectedIdentity) {
      if (switchDuringFetch) account = "account-after";
      if (account !== expectedIdentity)
        throw new CredentialError(
          "ChatGPT account changed during catalog discovery",
        );
      const payload = chatGptNativeCatalog();
      payload.versions[0].id = account;
      return payload;
    },
  };
  const adapter = new ChatGptWebAdapter({
    modelCatalogCache: cache,
    modelCatalogSource: source,
  });
  await assert.rejects(adapter.getCatalog("session=fixture"), CredentialError);
  assert.equal(await cache.peek("chatgpt-web", "account-before"), undefined);
  assert.equal(await cache.peek("chatgpt-web", "account-after"), undefined);
  switchDuringFetch = false;
  const after = await adapter.getCatalog("session=fixture");
  assert.equal(after.catalog.defaultModel, "chatgpt-web:account-after");
  account = "account-before";
  const before = await adapter.getCatalog("session=fixture");
  assert.equal(before.catalog.defaultModel, "chatgpt-web:account-before");
  assert.equal(
    (await cache.peek<typeof after.catalog>("chatgpt-web", "account-after"))
      ?.catalog.defaultModel,
    "chatgpt-web:account-after",
  );
});
