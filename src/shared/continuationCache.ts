import { createHash } from "node:crypto";
import type { ChatMessage } from "./types.ts";

export interface ContinuationEntry<TState> {
  key: string;
  scope: string; // account + org + model
  transcriptHash: string;
  state: TState;
  createdAt: number;
  lastUsedAt: number;
}

export interface ContinuationCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
}

export class AccountScopedContinuationCache<TState> {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly store = new Map<string, ContinuationEntry<TState>>();

  constructor(options: ContinuationCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1000; // 30 minutes default
    this.maxEntries = options.maxEntries ?? 500;
  }

  static computeTranscriptHash(messages: readonly ChatMessage[]): string {
    const canonical = messages.map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      tool_calls: m.tool_calls?.map((tc) => ({
        name: tc.function.name,
        arguments: tc.function.arguments,
      })),
    }));
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  }

  static buildKey(scope: string, transcriptHash: string): string {
    return `${scope}::${transcriptHash}`;
  }

  get(scope: string, transcriptHash: string): TState | null {
    this.evictExpired();
    const key = AccountScopedContinuationCache.buildKey(scope, transcriptHash);
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.store.delete(key);
      return null;
    }
    entry.lastUsedAt = Date.now();
    return entry.state;
  }

  commit(scope: string, transcriptHash: string, state: TState): void {
    this.evictExpired();
    if (this.store.size >= this.maxEntries) {
      // LRU eviction
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.store.entries()) {
        if (v.lastUsedAt < oldestTime) {
          oldestTime = v.lastUsedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) this.store.delete(oldestKey);
    }

    const key = AccountScopedContinuationCache.buildKey(scope, transcriptHash);
    const now = Date.now();
    this.store.set(key, {
      key,
      scope,
      transcriptHash,
      state,
      createdAt: now,
      lastUsedAt: now,
    });
  }

  invalidate(scope: string, transcriptHash?: string): void {
    if (transcriptHash) {
      const key = AccountScopedContinuationCache.buildKey(scope, transcriptHash);
      this.store.delete(key);
    } else {
      for (const [k, v] of this.store.entries()) {
        if (v.scope === scope) {
          this.store.delete(k);
        }
      }
    }
  }

  size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now - entry.createdAt > this.ttlMs) {
        this.store.delete(key);
      }
    }
  }
}
