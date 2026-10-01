import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeModelCatalog } from "../../src/providers/claude/models.ts";
import {
  ClaudeWebAdapter,
  MockClaudeWebTransport,
} from "../../src/providers/claude/adapter.ts";
import {
  InvalidRequestError,
  UpstreamDriftError,
} from "../../src/shared/errors.ts";

const bootstrap = {
  model_selector_config: [
    {
      id: "code",
      models: [{ id: "code-only", name: "Code", section: "main" }],
    },
    {
      id: "chat",
      models: [
        {
          id: "claude-future",
          name: "Future",
          section: "main",
          disabled: true,
          disabled_reason: { type: "upgrade_required", required_plan: "pro" },
          badge: { message: "Pro or Max" },
        },
        {
          id: "claude-next",
          name: "Next",
          section: "main",
          capabilities: { mm_images: true, mm_pdf: true },
          hard_limit: 950000,
          thinking: {
            type: "effort_and_mode",
            effort_options: [{ id: "high" }],
          },
        },
        { id: "claude-older", name: "Older", section: "overflow" },
        {
          id: "claude-retired",
          name: "Retired",
          section: "deprecated",
          disabled: true,
        },
      ],
    },
  ],
  model_selector_state: [{ id: "chat", model: "claude-next" }],
};

test("discovers new IDs and preserves paywalls and overflow while excluding deprecated/code models", () => {
  const catalog = parseClaudeModelCatalog(bootstrap);
  assert.deepEqual(
    catalog.models.map((model) => model.id),
    ["claude-future", "claude-next", "claude-older"],
  );
  assert.equal(catalog.defaultModel, "claude-next");
  assert.equal(catalog.models[0].disabled, true);
  assert.equal(catalog.models[0].requiredPlan, "pro");
  assert.equal(catalog.models[0].badge, "Pro or Max");
  assert.equal(catalog.models[1].capabilities.supportsVision, true);
  assert.equal(catalog.models[1].capabilities.maxContextTokens, 950000);
  assert.deepEqual(catalog.models[1].capabilities.supportedThinkingEfforts, [
    "high",
  ]);
  assert.equal(catalog.models[2].section, "overflow");
});

test("upstream shape drift fails rather than substituting a static catalog", () => {
  assert.throws(() => parseClaudeModelCatalog({}), UpstreamDriftError);
  assert.throws(
    () =>
      parseClaudeModelCatalog({
        model_selector_config: [{ id: "chat", models: [] }],
      }),
    UpstreamDriftError,
  );
});

test("unknown and account-locked IDs cannot silently execute a different model", async () => {
  const adapter = new ClaudeWebAdapter({
    transport: new MockClaudeWebTransport(
      async () => [{ id: "org", name: "Org" }],
      async () => {
        throw new Error("A rejected model must never send a turn");
      },
      async () => bootstrap,
    ),
  });
  for (const model of ["claude-future", "claude-missing"]) {
    await assert.rejects(
      adapter.execute(
        { model, messages: [{ role: "user", content: "Hi" }] },
        "sessionKey=test",
      ),
      InvalidRequestError,
    );
  }
});
