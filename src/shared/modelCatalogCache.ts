import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type CatalogProvider = "claude-web" | "gemini-web";
export interface CatalogStatus {
  fetchedAt: number;
  lastError?: string;
  stale: boolean;
}
interface CacheEntry<T> extends CatalogStatus { catalog: T; }
type Snapshot = Record<string, Record<string, CacheEntry<unknown>>>;

export function catalogAccountKey(provider: CatalogProvider, material: string): string {
  return createHash("sha256").update(`ultraroute:model-catalog:${provider}:`).update(material).digest("hex");
}

let defaultModelCatalogCache: ModelCatalogCache | undefined;

export function getDefaultModelCatalogCache(): ModelCatalogCache {
  defaultModelCatalogCache ??= new ModelCatalogCache();
  return defaultModelCatalogCache;
}

export class ModelCatalogCache {
  private readonly entries = new Map<string, Map<string, CacheEntry<unknown>>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private loaded?: Promise<void>;
  private readonly filePath?: string;

  constructor(filePath?: string) {
    this.filePath = filePath;
  }

  private async load(): Promise<void> {
    if (!this.loaded) this.loaded = this.readSnapshot();
    await this.loaded;
  }

  private async readSnapshot(): Promise<void> {
    if (!this.filePath) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      for (const [provider, records] of Object.entries(parsed as Snapshot)) {
        if (provider !== "claude-web" && provider !== "gemini-web") continue;
        if (!records || typeof records !== "object" || Array.isArray(records)) continue;
        const providerEntries = new Map<string, CacheEntry<unknown>>();
        for (const [scope, entry] of Object.entries(records)) {
          if (!/^[a-f0-9]{64}$/.test(scope) || !entry || typeof entry !== "object" || !Number.isFinite(entry.fetchedAt) || !("catalog" in entry)) continue;
          providerEntries.set(scope, { catalog: entry.catalog, fetchedAt: entry.fetchedAt, ...(typeof entry.lastError === "string" ? { lastError: "Catalog refresh failed" } : {}), stale: typeof entry.lastError === "string" });
        }
        if (providerEntries.size) this.entries.set(provider, providerEntries);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.entries.clear();
    }
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return;
    const snapshot: Snapshot = {};
    for (const [provider, entries] of this.entries) snapshot[provider] = Object.fromEntries(entries);
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(snapshot), { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  async peek<T>(provider: CatalogProvider, accountMaterial: string): Promise<{ catalog: T; status: CatalogStatus } | undefined> {
    await this.load();
    const entry = this.entries.get(provider)?.get(catalogAccountKey(provider, accountMaterial)) as CacheEntry<T> | undefined;
    return entry ? { catalog: entry.catalog, status: { fetchedAt: entry.fetchedAt, lastError: entry.lastError, stale: Boolean(entry.lastError) } } : undefined;
  }

  async get<T>(provider: CatalogProvider, accountMaterial: string, loader: () => Promise<T>): Promise<{ catalog: T; status: CatalogStatus }> {
    await this.load();
    const scope = catalogAccountKey(provider, accountMaterial);
    const existing = this.entries.get(provider)?.get(scope) as CacheEntry<T> | undefined;
    if (existing) return { catalog: existing.catalog, status: { fetchedAt: existing.fetchedAt, lastError: existing.lastError, stale: Boolean(existing.lastError) } };
    return this.refresh(provider, accountMaterial, loader);
  }

  async refresh<T>(provider: CatalogProvider, accountMaterial: string, loader: () => Promise<T>): Promise<{ catalog: T; status: CatalogStatus }> {
    await this.load();
    const scope = catalogAccountKey(provider, accountMaterial);
    const key = `${provider}:${scope}`;
    const pending = this.inFlight.get(key) as Promise<{ catalog: T; status: CatalogStatus }> | undefined;
    if (pending) return pending;
    const work = (async () => {
      try {
        const catalog = await loader();
        const entry: CacheEntry<T> = { catalog, fetchedAt: Date.now(), stale: false };
        let providerEntries = this.entries.get(provider);
        if (!providerEntries) this.entries.set(provider, providerEntries = new Map());
        providerEntries.set(scope, entry);
        await this.persist();
        return { catalog, status: { fetchedAt: entry.fetchedAt, stale: false } };
      } catch (error) {
        const entry = this.entries.get(provider)?.get(scope) as CacheEntry<T> | undefined;
        if (!entry) throw error;
        entry.lastError = "Catalog refresh failed";
        entry.stale = true;
        await this.persist().catch(() => {});
        return { catalog: entry.catalog, status: { fetchedAt: entry.fetchedAt, lastError: entry.lastError, stale: true } };
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, work);
    return work;
  }
}
