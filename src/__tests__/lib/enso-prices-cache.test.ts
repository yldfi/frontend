import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ENSO_PRICES_CACHE_TTL_SECONDS,
  clearMemoryEnsoPrices,
  dedupeEnsoPrices,
  ensoPricesCacheKey,
  readCachedEnsoPrices,
  writeCachedEnsoPrices,
} from "@/lib/enso-prices-cache";

const A = "0x0000000000000000000000000000000000000001";
const B = "0x0000000000000000000000000000000000000002";

describe("enso prices cache", () => {
  beforeEach(() => {
    clearMemoryEnsoPrices();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMemoryEnsoPrices();
  });

  describe("ensoPricesCacheKey", () => {
    it("is insensitive to order, case and duplicates", () => {
      const key = ensoPricesCacheKey([A, B]);
      expect(ensoPricesCacheKey([B, A])).toBe(key);
      expect(ensoPricesCacheKey([A.toUpperCase(), B, A])).toBe(key);
    });

    it("does not collide across disjoint address sets", () => {
      expect(ensoPricesCacheKey([A])).not.toBe(ensoPricesCacheKey([B]));
      expect(ensoPricesCacheKey([A, B])).not.toBe(ensoPricesCacheKey([A]));
    });
  });

  it("serves a second read from the in-isolate map without touching the edge cache", async () => {
    const store = { match: vi.fn(), put: vi.fn() };
    vi.stubGlobal("caches", { default: store });

    await writeCachedEnsoPrices("k", [{ price: 1 }]);
    expect(await readCachedEnsoPrices("k")).toEqual([{ price: 1 }]);
    expect(store.match).not.toHaveBeenCalled();
    expect(store.put).toHaveBeenCalledTimes(1);
  });

  it("falls back to the edge cache when the in-isolate entry is gone", async () => {
    const store = {
      match: vi.fn().mockResolvedValue(new Response(JSON.stringify([{ price: 2 }]))),
      put: vi.fn(),
    };
    vi.stubGlobal("caches", { default: store });

    expect(await readCachedEnsoPrices("k")).toEqual([{ price: 2 }]);
    expect(store.match).toHaveBeenCalledTimes(1);
  });

  it("ignores cache API failures and still works in-isolate", async () => {
    const store = {
      match: vi.fn().mockRejectedValue(new Error("no cache")),
      put: vi.fn().mockRejectedValue(new Error("no cache")),
    };
    vi.stubGlobal("caches", { default: store });

    await expect(writeCachedEnsoPrices("k", [{ price: 3 }])).resolves.toBeUndefined();
    expect(await readCachedEnsoPrices("k")).toEqual([{ price: 3 }]);
  });

  it("expires in-isolate entries after the TTL", async () => {
    vi.useFakeTimers();
    await writeCachedEnsoPrices("k", [{ price: 4 }]);

    vi.advanceTimersByTime((ENSO_PRICES_CACHE_TTL_SECONDS + 1) * 1000);
    expect(await readCachedEnsoPrices("k")).toBeNull();
  });

  it("works when the Cache API is unavailable", async () => {
    vi.stubGlobal("caches", undefined);
    await writeCachedEnsoPrices("k", [{ price: 5 }]);
    expect(await readCachedEnsoPrices("k")).toEqual([{ price: 5 }]);
  });

  describe("dedupeEnsoPrices", () => {
    it("collapses concurrent calls with the same key onto one producer", async () => {
      let resolve!: (value: number[]) => void;
      const produce = vi.fn(() => new Promise<number[]>((r) => {
        resolve = r;
      }));

      const a = dedupeEnsoPrices("k", produce);
      const b = dedupeEnsoPrices("k", produce);
      resolve([1]);

      expect(await Promise.all([a, b])).toEqual([[1], [1]]);
      expect(produce).toHaveBeenCalledTimes(1);
    });

    it("runs again once the previous call settles", async () => {
      const produce = vi.fn(async () => [1]);
      await dedupeEnsoPrices("k", produce);
      await dedupeEnsoPrices("k", produce);
      expect(produce).toHaveBeenCalledTimes(2);
    });

    it("does not share across different keys", async () => {
      const produce = vi.fn(async () => [1]);
      await Promise.all([dedupeEnsoPrices("a", produce), dedupeEnsoPrices("b", produce)]);
      expect(produce).toHaveBeenCalledTimes(2);
    });
  });
});
