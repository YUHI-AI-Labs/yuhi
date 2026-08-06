import { describe, expect, it } from "vitest";
import { GenerationCache, type GenerationCacheIdentity, type GenerationCacheEntry } from "./cache.js";

function id(overrides: Partial<GenerationCacheIdentity> = {}): GenerationCacheIdentity {
  return {
    objectId: "obj-1",
    revision: 1,
    privacyMode: "balanced",
    secretDeliveryMode: "developer-delivery",
    intent: "data-analysis",
    ...overrides,
  };
}

function entry(overrides: Partial<GenerationCacheEntry> = {}): GenerationCacheEntry {
  return {
    planKind: "structured",
    strategyVersion: "json-outline@1",
    deliveredHash: "hash-abc",
    estimatedTokens: 100,
    exactCharacters: 400,
    ...overrides,
  };
}

describe("GenerationCache", () => {
  it("same key returns the same bytes (deliveredHash) on every lookup", () => {
    const cache = new GenerationCache();
    const key = id();
    cache.set(key, entry());
    expect(cache.get(key)?.deliveredHash).toBe("hash-abc");
    expect(cache.get(key)?.deliveredHash).toBe("hash-abc");
  });

  it("a revision change is a cache miss, unconditionally", () => {
    const cache = new GenerationCache();
    cache.set(id({ revision: 1 }), entry());
    expect(cache.get(id({ revision: 2 }))).toBeUndefined();
  });

  it("a privacy mode change is a cache miss, unconditionally", () => {
    const cache = new GenerationCache();
    cache.set(id({ privacyMode: "balanced" }), entry());
    expect(cache.get(id({ privacyMode: "trusted-local" }))).toBeUndefined();
    expect(cache.get(id({ privacyMode: "strict" }))).toBeUndefined();
  });

  it("a secret delivery mode change is a cache miss, unconditionally", () => {
    const cache = new GenerationCache();
    cache.set(id({ secretDeliveryMode: "developer-delivery" }), entry());
    expect(cache.get(id({ secretDeliveryMode: "redact" }))).toBeUndefined();
  });

  it("an intent change is a cache miss, even if the underlying content is identical", () => {
    const cache = new GenerationCache();
    cache.set(id({ intent: "data-analysis" }), entry());
    expect(cache.get(id({ intent: "debug" }))).toBeUndefined();
  });

  it("getValid misses when the strategy version differs (a compressor version bump invalidates its own entries)", () => {
    const cache = new GenerationCache();
    const key = id();
    cache.set(key, entry({ strategyVersion: "json-outline@1" }));
    expect(cache.getValid(key, "json-outline@1")).toBeDefined();
    expect(cache.getValid(key, "json-outline@2")).toBeUndefined();
  });

  it("tracks hits and misses separately", () => {
    const cache = new GenerationCache();
    const key = id();
    cache.get(key); // miss
    cache.set(key, entry());
    cache.get(key); // hit
    cache.get(key); // hit
    expect(cache.stats()).toEqual({ hits: 2, misses: 1 });
  });

  it("a fresh cache instance never reuses another instance's entries (no cross-session leakage)", () => {
    const first = new GenerationCache();
    const second = new GenerationCache();
    first.set(id(), entry());
    expect(second.get(id())).toBeUndefined();
  });
});
