import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedUpstreamJson, clearUpstreamJsonCache } from "@/lib/upstream-json-cache";

describe("upstream json cache", () => {
  beforeEach(() => {
    clearUpstreamJsonCache();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearUpstreamJsonCache();
    vi.useRealTimers();
  });

  it("produces once, then serves the second call from the in-isolate map", async () => {
    vi.stubGlobal("caches", undefined);
    const produce = vi.fn(async () => ({ tvl: "1" }));

    const first = await cachedUpstreamJson("kong", "k", 60, produce);
    const second = await cachedUpstreamJson("kong", "k", 60, produce);

    expect(first).toEqual({ value: { tvl: "1" }, status: "miss" });
    expect(second).toEqual({ value: { tvl: "1" }, status: "memory" });
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("produces again after the TTL has elapsed", async () => {
    vi.stubGlobal("caches", undefined);
    vi.useFakeTimers();
    const produce = vi.fn(async () => ({ n: produce.mock.calls.length }));

    expect((await cachedUpstreamJson("kong", "k", 60, produce)).status).toBe("miss");
    vi.advanceTimersByTime(61_000);
    expect((await cachedUpstreamJson("kong", "k", 60, produce)).status).toBe("miss");
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent calls with the same key onto one producer", async () => {
    vi.stubGlobal("caches", undefined);
    const gate = Promise.withResolvers<{ n: number }>();
    const produce = vi.fn(() => gate.promise);

    const a = cachedUpstreamJson("kong", "k", 60, produce);
    const b = cachedUpstreamJson("kong", "k", 60, produce);
    // Let both calls get past the edge-cache lookup before the producer settles.
    await Promise.resolve();
    await Promise.resolve();
    gate.resolve({ n: 1 });

    expect(await Promise.all([a, b])).toEqual([
      { value: { n: 1 }, status: "miss" },
      { value: { n: 1 }, status: "miss" },
    ]);
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("does not cache errors and rethrows them", async () => {
    vi.stubGlobal("caches", undefined);
    const failing = vi.fn(async () => {
      throw new Error("upstream 500");
    });

    await expect(cachedUpstreamJson("kong", "k", 60, failing)).rejects.toThrow("upstream 500");

    const produce = vi.fn(async () => ({ ok: true }));
    expect(await cachedUpstreamJson("kong", "k", 60, produce)).toEqual({
      value: { ok: true },
      status: "miss",
    });
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("keeps entries separate across namespaces", async () => {
    vi.stubGlobal("caches", undefined);
    const kong = vi.fn(async () => ({ from: "kong" }));
    const vaults = vi.fn(async () => ({ from: "vaults" }));

    expect((await cachedUpstreamJson("kong", "all", 60, kong)).value).toEqual({ from: "kong" });
    expect((await cachedUpstreamJson("vaults", "all", 60, vaults)).value).toEqual({
      from: "vaults",
    });
    expect(kong).toHaveBeenCalledTimes(1);
    expect(vaults).toHaveBeenCalledTimes(1);
  });

  it("serves a cold isolate from the edge cache", async () => {
    const exp = Date.now() + 300_000;
    const store = {
      match: vi.fn(async () =>
        new Response(JSON.stringify({ k: "merkl:v4/opportunities", exp, v: { from: "edge" } })),
      ),
      put: vi.fn(async () => undefined),
    };
    vi.stubGlobal("caches", { default: store });
    const produce = vi.fn(async () => ({ from: "upstream" }));

    expect(await cachedUpstreamJson("merkl", "v4/opportunities", 300, produce)).toEqual({
      value: { from: "edge" },
      status: "edge",
    });
    expect(produce).not.toHaveBeenCalled();
    expect(store.match).toHaveBeenCalledTimes(1);
  });

  it("treats an edge body for a different key as a miss", async () => {
    const store = {
      match: vi.fn(async () =>
        new Response(
          JSON.stringify({ k: "merkl:some-other-key", exp: Date.now() + 60_000, v: { bad: true } }),
        ),
      ),
      put: vi.fn(async () => undefined),
    };
    vi.stubGlobal("caches", { default: store });
    const produce = vi.fn(async () => ({ from: "upstream" }));

    expect(await cachedUpstreamJson("merkl", "v4/opportunities", 300, produce)).toEqual({
      value: { from: "upstream" },
      status: "miss",
    });
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("treats an edge body whose expiry has passed as a miss", async () => {
    vi.useFakeTimers();
    const store = {
      match: vi.fn(async () =>
        new Response(
          JSON.stringify({ k: "kong:k", exp: Date.now() - 1, v: { from: "edge" } }),
        ),
      ),
      put: vi.fn(async () => undefined),
    };
    vi.stubGlobal("caches", { default: store });
    const produce = vi.fn(async () => ({ from: "upstream" }));

    expect((await cachedUpstreamJson("kong", "k", 60, produce)).status).toBe("miss");
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("seeds memory from an edge hit with the envelope expiry, not a fresh TTL", async () => {
    vi.useFakeTimers();
    const exp = Date.now() + 2_000;
    const store = {
      match: vi.fn(async () =>
        new Response(JSON.stringify({ k: "merkl:v4/opportunities", exp, v: { from: "edge" } })),
      ),
      put: vi.fn(async () => undefined),
    };
    vi.stubGlobal("caches", { default: store });
    const produce = vi.fn(async () => ({ from: "upstream" }));

    // The envelope's TTL is 2s even though the caller asks for 300s.
    expect((await cachedUpstreamJson("merkl", "v4/opportunities", 300, produce)).status).toBe(
      "edge",
    );
    vi.advanceTimersByTime(1_000);
    expect((await cachedUpstreamJson("merkl", "v4/opportunities", 300, produce)).status).toBe(
      "memory",
    );
    vi.advanceTimersByTime(1_500);
    expect((await cachedUpstreamJson("merkl", "v4/opportunities", 300, produce)).status).toBe(
      "miss",
    );
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("treats a legacy edge body without an envelope as a miss", async () => {
    const store = {
      match: vi.fn(async () => new Response(JSON.stringify({ from: "legacy" }))),
      put: vi.fn(async () => undefined),
    };
    vi.stubGlobal("caches", { default: store });
    const produce = vi.fn(async () => ({ from: "upstream" }));

    expect((await cachedUpstreamJson("vaults", "all", 60, produce)).value).toEqual({
      from: "upstream",
    });
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("writes an edge envelope carrying the full key and the TTL", async () => {
    const store = {
      match: vi.fn(async () => null),
      put: vi.fn(async (_request: Request, _response: Response) => undefined),
    };
    vi.stubGlobal("caches", { default: store });
    const produce = vi.fn(async () => ({ ok: true }));

    await cachedUpstreamJson("kong", "vault:1", 60, produce);

    expect(store.put).toHaveBeenCalledTimes(1);
    const written = store.put.mock.calls[0][1] as Response;
    expect(written.headers.get("Cache-Control")).toBe("max-age=60");
    expect(await written.json()).toEqual({
      k: "kong:vault:1",
      exp: expect.any(Number),
      v: { ok: true },
    });
  });

  it("evicts the oldest memory entry once the count bound is reached", async () => {
    vi.stubGlobal("caches", undefined);
    for (let i = 0; i < 257; i++) {
      const produce = vi.fn(async () => ({ n: i }));
      expect((await cachedUpstreamJson("kong", `k${i}`, 60, produce)).status).toBe("miss");
    }

    const again = vi.fn(async () => ({ n: 0 }));
    expect((await cachedUpstreamJson("kong", "k0", 60, again)).status).toBe("miss");
    expect(again).toHaveBeenCalledTimes(1);
    // The newest entry is still held.
    const newest = vi.fn(async () => ({ n: 256 }));
    expect((await cachedUpstreamJson("kong", "k256", 60, newest)).status).toBe("memory");
    expect(newest).not.toHaveBeenCalled();
  });

  it("returns a value larger than 512 KB without keeping it in memory", async () => {
    vi.stubGlobal("caches", undefined);
    const big = { blob: "x".repeat(600 * 1024) };
    const produce = vi.fn(async () => big);

    const first = await cachedUpstreamJson("vaults", "big", 60, produce);
    expect(first.status).toBe("miss");
    expect(first.value).toBe(big);

    const second = await cachedUpstreamJson("vaults", "big", 60, produce);
    expect(second.status).toBe("miss");
    expect(second.value).toBe(big);
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it("ignores cache API failures and still returns the produced value", async () => {
    const store = {
      match: vi.fn().mockRejectedValue(new Error("no cache")),
      put: vi.fn().mockRejectedValue(new Error("no cache")),
    };
    vi.stubGlobal("caches", { default: store });
    const produce = vi.fn(async () => ({ ok: true }));

    expect(await cachedUpstreamJson("history", "k:tvl", 60, produce)).toEqual({
      value: { ok: true },
      status: "miss",
    });
    expect(produce).toHaveBeenCalledTimes(1);
    // The in-isolate layer still works even when the edge cache is broken.
    expect((await cachedUpstreamJson("history", "k:tvl", 60, produce)).status).toBe("memory");
  });

  it("works when the Cache API is unavailable", async () => {
    vi.stubGlobal("caches", undefined);
    const produce = vi.fn(async () => ({ ok: true }));

    expect((await cachedUpstreamJson("vaults", "all", 60, produce)).value).toEqual({ ok: true });
    expect((await cachedUpstreamJson("vaults", "all", 60, produce)).status).toBe("memory");
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("treats every malformed edge body as a miss without throwing", async () => {
    const exp = Date.now() + 60_000;
    const bodies = [
      // Not JSON at all.
      "not json",
      // JSON, but not an envelope object.
      JSON.stringify([{ k: "kong:k", exp, v: { from: "array" } }]),
      JSON.stringify("a string"),
      // Envelope-shaped but with a non-numeric expiry.
      JSON.stringify({ k: "kong:k", exp: String(exp), v: { from: "string-exp" } }),
      // Envelope-shaped but missing the key.
      JSON.stringify({ exp, v: { from: "no-key" } }),
    ];

    for (const body of bodies) {
      clearUpstreamJsonCache();
      const store = {
        match: vi.fn(async () => new Response(body)),
        put: vi.fn(async () => undefined),
      };
      vi.stubGlobal("caches", { default: store });
      const produce = vi.fn(async () => ({ from: "upstream" }));

      await expect(cachedUpstreamJson("kong", "k", 60, produce)).resolves.toEqual({
        value: { from: "upstream" },
        status: "miss",
      });
      expect(produce).toHaveBeenCalledTimes(1);
    }
  });

  it("uses one expiry for the memory entry and the edge envelope", async () => {
    vi.useFakeTimers();
    const store = {
      match: vi.fn(async () => null),
      put: vi.fn(async (_request: Request, _response: Response) => undefined),
    };
    vi.stubGlobal("caches", { default: store });
    const produce = vi.fn(async () => ({ ok: true }));

    const startedAt = Date.now();
    await cachedUpstreamJson("kong", "k", 60, produce);

    const written = store.put.mock.calls[0][1] as Response;
    const envelope = (await written.json()) as { exp: number };
    expect(envelope.exp).toBe(startedAt + 60_000);

    // The memory entry lives exactly as long as the envelope, not longer.
    vi.advanceTimersByTime(59_999);
    expect((await cachedUpstreamJson("kong", "k", 60, produce)).status).toBe("memory");
    vi.advanceTimersByTime(1);
    expect((await cachedUpstreamJson("kong", "k", 60, produce)).status).toBe("miss");
    expect(produce).toHaveBeenCalledTimes(2);
  });
});
