import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelCatalogCache } from "../../src/shared/modelCatalogCache.ts";

const catalog = { models: [{ id: "model-a", disabled: false }], defaultModel: "model-a" };

test("catalog cache single-flights concurrent cold loads and isolates accounts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "catalog-cache-"));
  try {
    const cache = new ModelCatalogCache(join(dir, "catalogs.json"));
    let loads = 0;
    let release!: (value: typeof catalog) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const loader = () => {
      loads++;
      signalStarted();
      return new Promise<typeof catalog>(resolve => { release = resolve; });
    };
    const first = cache.get("claude-web", "account-one", loader);
    const second = cache.get("claude-web", "account-one", loader);
    await started;
    assert.equal(loads, 1);
    release(catalog);
    assert.deepEqual((await first).catalog, catalog);
    assert.deepEqual((await second).catalog, catalog);
    const other = await cache.get("claude-web", "account-two", async () => ({ ...catalog, defaultModel: "model-b" }));
    assert.equal(other.catalog.defaultModel, "model-b");
    assert.equal(loads, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("catalog cache retains a last-good catalog on refresh failure and persists with owner-only mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "catalog-cache-"));
  try {
    const path = join(dir, "catalogs.json");
    const cache = new ModelCatalogCache(path);
    await cache.get("gemini-web", "stable-account", async () => catalog);
    const refreshed = await cache.refresh("gemini-web", "stable-account", async () => { throw new Error("upstream unavailable"); });
    assert.deepEqual(refreshed.catalog, catalog);
    assert.equal(refreshed.status.stale, true);
    assert.equal(refreshed.status.lastError, "Catalog refresh failed");
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const persisted = await readFile(path, "utf8");
    assert.equal(persisted.includes("stable-account"), false);
    const restored = await new ModelCatalogCache(path).peek<typeof catalog>("gemini-web", "stable-account");
    assert.deepEqual(restored?.catalog, catalog);
    assert.equal(restored?.status.stale, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
