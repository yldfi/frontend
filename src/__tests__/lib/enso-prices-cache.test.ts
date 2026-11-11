import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ENSO_PRICES_CACHE_TTL_SECONDS,
  clearMemoryEnsoPrices,
  dedupeEnsoPrices,
  ensoPricesCacheIdentity,
  ensoPricesCacheKey,
  readCachedEnsoPrices,
  writeCachedEnsoPrices,
} from "@/lib/enso-prices-cache";

const A = "0x0000000000000000000000000000000000000001";
const B = "0x0000000000000000000000000000000000000002";

function envelope(identity: string, value: unknown, expiresAt = Date.now() + 60_000): string {
  return JSON.stringify({ k: identity, exp: expiresAt, v: value });
}

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

  describe("ensoPricesCacheIdentity", () => {
    it("is the canonical joined address set", () => {
      expect(ensoPricesCacheIdentity([B, A, A.toUpperCase()])).toBe(`${A},${B}`);
    });
  });

  it("serves a second read from the in-isolate map without touching the edge cache", async () => {
    const store = { match: vi.fn(), put: vi.fn() };
    vi.stubGlobal("caches", { default: store });

    await writeCachedEnsoPrices("k", "a", [{ price: 1 }]);
    expect(await readCachedEnsoPrices("k", "a")).toEqual([{ price: 1 }]);
    expect(store.match).not.toHaveBeenCalled();
    expect(store.put).toHaveBeenCalledTimes(1);
  });

  it("falls back to the edge cache when the in-isolate entry is gone", async () => {
    const store = {
      match: vi.fn().mockResolvedValue(new Response(envelope("a", [{ price: 2 }]))),
      put: vi.fn(),
    };
    vi.stubGlobal("caches", { default: store });

    expect(await readCachedEnsoPrices("k", "a")).toEqual([{ price: 2 }]);
    expect(store.match).toHaveBeenCalledTimes(1);
  });

  it("ignores cache API failures and still works in-isolate", async () => {
    const store = {
      match: vi.fn().mockRejectedValue(new Error("no cache")),
      put: vi.fn().mockRejectedValue(new Error("no cache")),
    };
    vi.stubGlobal("caches", { default: store });

    await expect(writeCachedEnsoPrices("k", "a", [{ price: 3 }])).resolves.toBeUndefined();
    expect(await readCachedEnsoPrices("k", "a")).toEqual([{ price: 3 }]);
  });

  it("expires in-isolate entries after the TTL", async () => {
    vi.useFakeTimers();
    await writeCachedEnsoPrices("k", "a", [{ price: 4 }]);

    vi.advanceTimersByTime((ENSO_PRICES_CACHE_TTL_SECONDS + 1) * 1000);
    expect(await readCachedEnsoPrices("k", "a")).toBeNull();
  });

  it("works when the Cache API is unavailable", async () => {
    vi.stubGlobal("caches", undefined);
    await writeCachedEnsoPrices("k", "a", [{ price: 5 }]);
    expect(await readCachedEnsoPrices("k", "a")).toEqual([{ price: 5 }]);
  });

  it("does not return a memory entry written for another identity", async () => {
    vi.stubGlobal("caches", undefined);
    await writeCachedEnsoPrices("k", "a", [{ price: 6 }]);

    expect(await readCachedEnsoPrices("k", "b")).toBeNull();
    expect(await readCachedEnsoPrices("k", "a")).toEqual([{ price: 6 }]);
  });

  it("writes an edge body carrying the identity", async () => {
    const store = { match: vi.fn(), put: vi.fn() };
    vi.stubGlobal("caches", { default: store });

    await writeCachedEnsoPrices("k", ensoPricesCacheIdentity([A, B]), [{ price: 7 }]);

    const [, response] = store.put.mock.calls[0] as [Request, Response];
    const body = (await response.json()) as { k?: string; v?: unknown };
    expect(body.k).toBe(ensoPricesCacheIdentity([A, B]));
    expect(body.v).toEqual([{ price: 7 }]);
  });

  describe("edge reads", () => {
    it("treats a body stored for another identity as a miss", async () => {
      const store = {
        match: vi.fn().mockResolvedValue(new Response(envelope("other", [{ price: 2 }]))),
        put: vi.fn(),
      };
      vi.stubGlobal("caches", { default: store });

      expect(await readCachedEnsoPrices("k", "a")).toBeNull();
    });

    it("treats an expired envelope as a miss", async () => {
      const store = {
        match: vi
          .fn()
          .mockResolvedValue(new Response(envelope("a", [{ price: 2 }], Date.now() - 1))),
        put: vi.fn(),
      };
      vi.stubGlobal("caches", { default: store });

      expect(await readCachedEnsoPrices("k", "a")).toBeNull();
    });

    it("treats a bare legacy body as a miss", async () => {
      const store = {
        match: vi.fn().mockResolvedValue(new Response(JSON.stringify([{ price: 2 }]))),
        put: vi.fn(),
      };
      vi.stubGlobal("caches", { default: store });

      expect(await readCachedEnsoPrices("k", "a")).toBeNull();
    });

    it("treats an envelope with no value as a miss", async () => {
      const store = {
        match: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ k: "a", exp: Date.now() + 60_000 })),
        ),
        put: vi.fn(),
      };
      vi.stubGlobal("caches", { default: store });

      expect(await readCachedEnsoPrices("k", "a")).toBeNull();
      // Nothing is seeded into the in-isolate layer either.
      expect(await readCachedEnsoPrices("k", "a")).toBeNull();
      expect(store.match).toHaveBeenCalledTimes(2);
    });

    it("seeds memory with the envelope's expiry, not a fresh TTL", async () => {
      vi.useFakeTimers();
      const store = {
        match: vi
          .fn()
          .mockResolvedValueOnce(new Response(envelope("a", [{ price: 2 }], Date.now() + 5_000))),
        put: vi.fn(),
      };
      vi.stubGlobal("caches", { default: store });

      expect(await readCachedEnsoPrices("k", "a")).toEqual([{ price: 2 }]);
      const edgeCalls = store.match.mock.calls.length;

      // Inside the envelope's expiry the seeded memory entry serves the read.
      vi.advanceTimersByTime(4_000);
      expect(await readCachedEnsoPrices("k", "a")).toEqual([{ price: 2 }]);
      expect(store.match.mock.calls.length).toBe(edgeCalls);

      // Past it the memory entry is gone; the edge mock now misses too.
      vi.advanceTimersByTime(2_000);
      expect(await readCachedEnsoPrices("k", "a")).toBeNull();
    });
  });

  describe("dedupeEnsoPrices", () => {
    it("collapses concurrent calls with the same key onto one producer", async () => {
      let resolve!: (value: number[]) => void;
      const produce = vi.fn(() => new Promise<number[]>((r) => {
        resolve = r;
      }));

      const a = dedupeEnsoPrices("k", "id", produce);
      const b = dedupeEnsoPrices("k", "id", produce);
      resolve([1]);

      expect(await Promise.all([a, b])).toEqual([[1], [1]]);
      expect(produce).toHaveBeenCalledTimes(1);
    });

    it("runs again once the previous call settles", async () => {
      const produce = vi.fn(async () => [1]);
      await dedupeEnsoPrices("k", "id", produce);
      await dedupeEnsoPrices("k", "id", produce);
      expect(produce).toHaveBeenCalledTimes(2);
    });

    it("does not share across different keys", async () => {
      const produce = vi.fn(async () => [1]);
      await Promise.all([
        dedupeEnsoPrices("a", "id-a", produce),
        dedupeEnsoPrices("b", "id-b", produce),
      ]);
      expect(produce).toHaveBeenCalledTimes(2);
    });

    it("does not share across different identities even on the same key", async () => {
      const produce = vi.fn(async () => [1]);
      await Promise.all([
        dedupeEnsoPrices("k", "id-a", produce),
        dedupeEnsoPrices("k", "id-b", produce),
      ]);
      expect(produce).toHaveBeenCalledTimes(2);
    });
  });
});
