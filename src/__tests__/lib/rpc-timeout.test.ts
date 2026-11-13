// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PRIVATE = "https://private.node.example/rpc/secret-key";
const timeoutError = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

type RpcModule = typeof import("@/lib/curve/rpc");

describe("server-side RPC timeouts", () => {
  let rpc: RpcModule;
  let health: typeof import("@/lib/rpc-health");
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Production-like retry settings (live mode), with a private node first in the list.
    vi.stubEnv("ENSO_API_KEY", "test-key");
    vi.stubEnv("DEBUG_RPC_URL", PRIVATE);
    vi.stubEnv("DEBUG_RPC_AUTH", "user:pass");
    vi.resetModules();
    // The same fresh module instance the loops above import (module-level state).
    health = await import("@/lib/rpc-health");
    health.resetRpcHealth();
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith(PRIVATE)) throw timeoutError();
      if (url.includes("chainid.network")) return { ok: false, json: async () => [] } as unknown as Response;
      const body = JSON.parse(String(init?.body));
      const result = "0x" + (1234n).toString(16).padStart(64, "0");
      return {
        ok: true,
        json: async () => (Array.isArray(body) ? body.map((r: { id: number }) => ({ id: r.id, result })) : { id: body.id, result }),
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    rpc = await import("@/lib/curve/rpc");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const privateCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(PRIVATE));

  it("gives every RPC fetch a timeout signal", async () => {
    await rpc.batchRpcCalls([{ to: "0x0000000000000000000000000000000000000001", data: "0x" }]);
    const rpcCalls = fetchMock.mock.calls.filter(([url]) => !String(url).includes("chainid.network"));
    expect(rpcCalls.length).toBeGreaterThan(0);
    for (const [, init] of rpcCalls) expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("batchRpcCalls tries a timed-out node once, then falls back to the public list", async () => {
    const results = await rpc.batchRpcCalls([{ to: "0x0000000000000000000000000000000000000001", data: "0x" }]);
    expect(results).toEqual([1234n]);
    expect(privateCalls()).toHaveLength(1);
  });

  it("getCurveGetDy does not retry a timed-out node (was up to 5 attempts)", async () => {
    const out = await rpc.getCurveGetDy("0x0000000000000000000000000000000000000002", 0, 1, "1000");
    expect(out).toBe(1234n);
    expect(privateCalls()).toHaveLength(1);
  });

  it("sends the basic-auth header to the private node only", async () => {
    const headers: Array<[string, Record<string, string>]> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("chainid.network")) return { ok: false, json: async () => [] } as unknown as Response;
      headers.push([target, ((init as RequestInit).headers ?? {}) as Record<string, string>]);
      if (target.startsWith(PRIVATE)) return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      return { ok: true, json: async () => [{ id: 0, result: "0x4d2" }] } as unknown as Response;
    }));

    const results = await rpc.batchRpcCalls([{ to: "0x0000000000000000000000000000000000000001", data: "0x" }]);

    expect(results).toEqual([1234n]);
    expect(headers[0][0].startsWith(PRIVATE)).toBe(true);
    expect(headers[0][1].Authorization).toBe("Basic user:pass");
    const publicCall = headers.find(([url]) => !url.startsWith(PRIVATE));
    expect(publicCall).toBeDefined();
    expect(publicCall![1]).not.toHaveProperty("Authorization");
  });

  describe("provider cooldown", () => {
    const CALLS = [{ to: "0x0000000000000000000000000000000000000001", data: "0x" }];
    const single = { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] };

    /** URL of the first non-probe request since `from`. */
    const firstRpcUrlSince = (from: number) =>
      String(fetchMock.mock.calls.slice(from).find(([url]) => !String(url).includes("chainid.network"))?.[0]);

    it("skips a just-timed-out node on the next batch read", async () => {
      await rpc.batchRpcCalls(CALLS);
      expect(privateCalls()).toHaveLength(1);

      const afterFirst = fetchMock.mock.calls.length;
      await rpc.batchRpcCalls(CALLS);

      expect(firstRpcUrlSince(afterFirst).startsWith(PRIVATE)).toBe(false);
      // The cooled-down node was not needed this time.
      expect(privateCalls()).toHaveLength(1);
    });

    it("still tries a cooled-down node, last, when every public provider fails", async () => {
      vi.useFakeTimers();
      try {
        let privateFails = true;
        let publicFails = false;
        const result = "0x" + (1234n).toString(16).padStart(64, "0");
        const flaggedFetch = vi.fn(async (url: string, init?: RequestInit) => {
          const target = String(url);
          if (target.includes("chainid.network")) return { ok: false, json: async () => [] } as unknown as Response;
          if (target.startsWith(PRIVATE)) {
            if (privateFails) throw timeoutError();
          } else if (publicFails) {
            return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
          }
          const body = JSON.parse(String(init?.body)) as { id: number } | Array<{ id: number }>;
          return {
            ok: true,
            json: async () =>
              Array.isArray(body)
                ? body.map((entry) => ({ id: entry.id, result }))
                : { id: body.id, result },
          } as unknown as Response;
        });
        globalThis.fetch = flaggedFetch as unknown as typeof fetch;

        // First read: the private node times out and a public provider answers.
        await rpc.batchRpcCalls(CALLS);
        expect(flaggedFetch.mock.calls.some(([url]) => String(url).startsWith(PRIVATE))).toBe(true);

        // From now on every public provider fails and only the private node answers.
        privateFails = false;
        publicFails = true;
        const afterFirst = flaggedFetch.mock.calls.length;

        const pending = rpc.batchRpcCalls(CALLS);
        await vi.runAllTimersAsync();
        await expect(pending).resolves.toEqual([1234n]);

        const attempted = flaggedFetch.mock.calls
          .slice(afterFirst)
          .map(([url]) => String(url))
          .filter((url) => !url.includes("chainid.network"));
        expect(attempted[attempted.length - 1]).toBe(PRIVATE);
        expect(attempted.slice(0, -1).every((url) => !url.startsWith(PRIVATE))).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("tries the private node first again after the cooldown", async () => {
      vi.useFakeTimers();
      try {
        await rpc.batchRpcCalls(CALLS);
        expect(privateCalls()).toHaveLength(1);

        const afterFirst = fetchMock.mock.calls.length;
        await rpc.batchRpcCalls(CALLS);
        expect(firstRpcUrlSince(afterFirst).startsWith(PRIVATE)).toBe(false);

        vi.advanceTimersByTime(health.RPC_COOLDOWN_MS);

        const afterSecond = fetchMock.mock.calls.length;
        await rpc.batchRpcCalls(CALLS);
        expect(firstRpcUrlSince(afterSecond).startsWith(PRIVATE)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a provider that answers after its cooldown resets to a 60 second cooldown", async () => {
      vi.useFakeTimers();
      try {
        let privateFails = true;
        const result = "0x" + (1234n).toString(16).padStart(64, "0");
        const flaggedFetch = flaggedRpcMock((url, init) => {
          if (url.startsWith(PRIVATE) && privateFails) throw timeoutError();
          const body = JSON.parse(String(init?.body)) as { id: number } | Array<{ id: number }>;
          return {
            ok: true,
            json: async () =>
              Array.isArray(body)
                ? body.map((entry) => ({ id: entry.id, result }))
                : { id: body.id, result },
          } as unknown as Response;
        });
        globalThis.fetch = flaggedFetch as unknown as typeof fetch;

        // First read: the private node times out.
        await rpc.batchRpcCalls(CALLS);
        expect(attemptedUrls(flaggedFetch, 0)).toContain(PRIVATE);

        // Inside the cooldown it is tried last.
        const afterFirst = flaggedFetch.mock.calls.length;
        await rpc.batchRpcCalls(CALLS);
        expect(attemptedUrls(flaggedFetch, afterFirst)[0].startsWith(PRIVATE)).toBe(false);

        // After the cooldown it is first again, and this time it answers.
        vi.advanceTimersByTime(health.RPC_COOLDOWN_MS);
        privateFails = false;
        const afterCooldown = flaggedFetch.mock.calls.length;
        await rpc.batchRpcCalls(CALLS);
        expect(attemptedUrls(flaggedFetch, afterCooldown)[0]).toBe(PRIVATE);

        // A new timeout after that success starts at 60 s, not at 120 s.
        privateFails = true;
        const afterSuccess = flaggedFetch.mock.calls.length;
        await rpc.batchRpcCalls(CALLS);
        expect(attemptedUrls(flaggedFetch, afterSuccess)[0]).toBe(PRIVATE);

        vi.advanceTimersByTime(health.RPC_COOLDOWN_MS);
        const afterSecondTimeout = flaggedFetch.mock.calls.length;
        await rpc.batchRpcCalls(CALLS);
        expect(attemptedUrls(flaggedFetch, afterSecondTimeout)[0]).toBe(PRIVATE);
      } finally {
        vi.useRealTimers();
      }
    });

    it("two timeouts with no success between grow the cooldown past a minute", async () => {
      vi.useFakeTimers();
      try {
        const result = "0x" + (1234n).toString(16).padStart(64, "0");
        const flaggedFetch = flaggedRpcMock((url, init) => {
          if (url.startsWith(PRIVATE)) throw timeoutError();
          const body = JSON.parse(String(init?.body)) as { id: number } | Array<{ id: number }>;
          return {
            ok: true,
            json: async () =>
              Array.isArray(body)
                ? body.map((entry) => ({ id: entry.id, result }))
                : { id: body.id, result },
          } as unknown as Response;
        });
        globalThis.fetch = flaggedFetch as unknown as typeof fetch;

        // First read: timeout, so a 60 s cooldown.
        await rpc.batchRpcCalls(CALLS);

        // After the first cooldown the node is first and times out again, with
        // no successful attempt in between.
        vi.advanceTimersByTime(health.RPC_COOLDOWN_MS);
        const afterFirstCooldown = flaggedFetch.mock.calls.length;
        await rpc.batchRpcCalls(CALLS);
        expect(attemptedUrls(flaggedFetch, afterFirstCooldown)[0]).toBe(PRIVATE);

        // The second cooldown is 120 s: still last a minute and a second later.
        vi.advanceTimersByTime(health.RPC_COOLDOWN_MS + 1_000);
        const afterSecondTimeout = flaggedFetch.mock.calls.length;
        await rpc.batchRpcCalls(CALLS);
        expect(attemptedUrls(flaggedFetch, afterSecondTimeout)[0].startsWith(PRIVATE)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a batch whose per-entry retries all time out at once cools the node for 60 seconds, not 10 minutes", async () => {
      vi.useFakeTimers();
      try {
        const N = 6;
        const calls = Array.from({ length: N }, (_, index) => ({
          to: "0x" + (index + 1).toString(16).padStart(40, "0"),
          data: "0x",
        }));
        const expected = calls.map(() => 1234n);
        const result = "0x" + (1234n).toString(16).padStart(64, "0");
        const flaggedFetch = flaggedRpcMock((url, init) => {
          const body = JSON.parse(String(init?.body)) as { id: number } | Array<{ id: number }>;
          if (url.startsWith(PRIVATE)) {
            // The batch answers with empty entries, then every per-entry retry times out.
            if (Array.isArray(body)) {
              return {
                ok: true,
                json: async () => body.map((entry) => ({ id: entry.id, result: "0x" })),
              } as unknown as Response;
            }
            throw timeoutError();
          }
          return {
            ok: true,
            json: async () =>
              Array.isArray(body)
                ? body.map((entry) => ({ id: entry.id, result }))
                : { id: body.id, result },
          } as unknown as Response;
        });
        globalThis.fetch = flaggedFetch as unknown as typeof fetch;

        await expect(rpc.batchRpcCalls(calls)).resolves.toEqual(expected);
        // The node is retried once, and each attempt retries every entry alone.
        const privateAttempts = attemptedUrls(flaggedFetch, 0).filter((url) => url.startsWith(PRIVATE));
        expect(privateAttempts.length).toBeGreaterThanOrEqual(N + 1);

        // Inside the cooldown the node is tried last, so the public providers answer.
        const afterFirst = flaggedFetch.mock.calls.length;
        await expect(rpc.batchRpcCalls(calls)).resolves.toEqual(expected);
        expect(attemptedUrls(flaggedFetch, afterFirst)[0].startsWith(PRIVATE)).toBe(false);

        // One minute later it is first again: the strikes did not add up to the cap.
        vi.advanceTimersByTime(health.RPC_COOLDOWN_MS);
        const afterCooldown = flaggedFetch.mock.calls.length;
        await expect(rpc.batchRpcCalls(calls)).resolves.toEqual(expected);
        expect(attemptedUrls(flaggedFetch, afterCooldown)[0]).toBe(PRIVATE);
      } finally {
        vi.useRealTimers();
      }
    });

    const RESET_READS = ["getCurveGetDy", "getCurveGetDyFactory", "rpcWithFallback"] as const;

    it.each(RESET_READS)(
      "%s resets the strikes when the node answers after its cooldown",
      async (fnName) => {
        vi.useFakeTimers();
        try {
          const ensoRpc = await import("@/lib/enso/api");
          const result = "0x" + (1234n).toString(16).padStart(64, "0");
          let privateFails = true;
          const flaggedFetch = flaggedRpcMock((url, init) => {
            const body = JSON.parse(String(init?.body)) as { id: number } | Array<{ id: number }>;
            if (url.startsWith(PRIVATE) && privateFails) throw timeoutError();
            return {
              ok: true,
              json: async () =>
                Array.isArray(body)
                  ? body.map((entry) => ({ id: entry.id, result }))
                  : { id: body.id, result },
            } as unknown as Response;
          });
          globalThis.fetch = flaggedFetch as unknown as typeof fetch;
          const read = async (): Promise<unknown> => {
            if (fnName === "rpcWithFallback") return ensoRpc.rpcWithFallback(single);
            if (fnName === "getCurveGetDy") return rpc.getCurveGetDy(POOL, 0, 1, "1000");
            return rpc.getCurveGetDyFactory(POOL, 0, 1, "1000");
          };

          // First timeout: a 60 s cooldown.
          await read();
          const afterTimeout = flaggedFetch.mock.calls.length;
          await read();
          expect(attemptedUrls(flaggedFetch, afterTimeout)[0].startsWith(PRIVATE)).toBe(false);

          // After the cooldown the node is first again and answers through this function.
          vi.advanceTimersByTime(health.RPC_COOLDOWN_MS);
          privateFails = false;
          const afterCooldown = flaggedFetch.mock.calls.length;
          await read();
          expect(attemptedUrls(flaggedFetch, afterCooldown)[0]).toBe(PRIVATE);

          // A timeout after that success starts at 60 s, not at 120 s.
          privateFails = true;
          const afterSuccess = flaggedFetch.mock.calls.length;
          await read();
          expect(attemptedUrls(flaggedFetch, afterSuccess)[0]).toBe(PRIVATE);

          vi.advanceTimersByTime(health.RPC_COOLDOWN_MS - 1);
          const afterSecondTimeout = flaggedFetch.mock.calls.length;
          await read();
          expect(attemptedUrls(flaggedFetch, afterSecondTimeout)[0].startsWith(PRIVATE)).toBe(false);

          vi.advanceTimersByTime(1);
          const afterSecondCooldown = flaggedFetch.mock.calls.length;
          await read();
          expect(attemptedUrls(flaggedFetch, afterSecondCooldown)[0]).toBe(PRIVATE);
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it("rpcWithFallback skips a node that just timed out on its previous read", async () => {
      const ensoRpc = await import("@/lib/enso/api");

      await ensoRpc.rpcWithFallback(single);
      expect(privateCalls()).toHaveLength(1);

      const afterFirst = fetchMock.mock.calls.length;
      await ensoRpc.rpcWithFallback(single);

      expect(firstRpcUrlSince(afterFirst).startsWith(PRIVATE)).toBe(false);
    });

    it("a timeout in rpcWithFallback reorders the curve batch list", async () => {
      const ensoRpc = await import("@/lib/enso/api");

      await ensoRpc.rpcWithFallback(single);
      const afterFirst = fetchMock.mock.calls.length;

      await rpc.batchRpcCalls(CALLS);

      expect(firstRpcUrlSince(afterFirst).startsWith(PRIVATE)).toBe(false);
    });

    it("a timeout in batchRpcCalls reorders rpcWithFallback", async () => {
      const ensoRpc = await import("@/lib/enso/api");

      await rpc.batchRpcCalls(CALLS);
      const afterFirst = fetchMock.mock.calls.length;

      await ensoRpc.rpcWithFallback(single);

      expect(firstRpcUrlSince(afterFirst).startsWith(PRIVATE)).toBe(false);
    });

    // The two pool-rate reads (get_dy on old-style and factory pools) build
    // their URL list the same way, so both are covered by every case below.
    const POOL_RATE_READS = ["getCurveGetDy", "getCurveGetDyFactory"] as const;
    const POOL = "0x0000000000000000000000000000000000000002";
    const readPoolRate = (fnName: (typeof POOL_RATE_READS)[number]) => rpc[fnName](POOL, 0, 1, "1000");

    /** Every RPC URL a flagged mock was asked for, in order, minus the chainlist probe. */
    const attemptedUrls = (mock: ReturnType<typeof vi.fn>, from: number) =>
      mock.mock.calls
        .slice(from)
        .map(([url]) => String(url))
        .filter((url) => !url.includes("chainid.network"));

    const flaggedRpcMock = (
      respond: (url: string, init?: RequestInit) => Promise<Response> | Response,
    ) =>
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("chainid.network")) return { ok: false, json: async () => [] } as unknown as Response;
        return respond(String(url), init);
      });

    it.each(POOL_RATE_READS)("%s skips a just-timed-out node on the next read", async (fnName) => {
      await expect(readPoolRate(fnName)).resolves.toBe(1234n);
      expect(privateCalls()).toHaveLength(1);

      const afterFirst = fetchMock.mock.calls.length;
      await expect(readPoolRate(fnName)).resolves.toBe(1234n);

      expect(firstRpcUrlSince(afterFirst).startsWith(PRIVATE)).toBe(false);
      // The cooled-down node was not needed this time.
      expect(privateCalls()).toHaveLength(1);
    });

    it.each(POOL_RATE_READS)("%s reorders batchRpcCalls after a timeout", async (fnName) => {
      await readPoolRate(fnName);
      const afterFirst = fetchMock.mock.calls.length;

      await rpc.batchRpcCalls(CALLS);

      expect(firstRpcUrlSince(afterFirst).startsWith(PRIVATE)).toBe(false);
      expect(privateCalls()).toHaveLength(1);
    });

    it.each(POOL_RATE_READS)("%s is itself reordered by a timeout in batchRpcCalls", async (fnName) => {
      await rpc.batchRpcCalls(CALLS);
      const afterFirst = fetchMock.mock.calls.length;

      await readPoolRate(fnName);

      expect(firstRpcUrlSince(afterFirst).startsWith(PRIVATE)).toBe(false);
      expect(privateCalls()).toHaveLength(1);
    });

    it.each(POOL_RATE_READS)(
      "%s still tries a cooled-down node, last, when every public provider fails",
      async (fnName) => {
        vi.useFakeTimers();
        try {
          let privateFails = true;
          let publicFails = false;
          const result = "0x" + (1234n).toString(16).padStart(64, "0");
          const flaggedFetch = flaggedRpcMock((url) => {
            if (url.startsWith(PRIVATE)) {
              if (privateFails) throw timeoutError();
            } else if (publicFails) {
              return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
            }
            return { ok: true, json: async () => ({ id: 1, result }) } as unknown as Response;
          });
          globalThis.fetch = flaggedFetch as unknown as typeof fetch;

          // First read: the private node times out and a public provider answers.
          await expect(readPoolRate(fnName)).resolves.toBe(1234n);
          expect(attemptedUrls(flaggedFetch, 0).some((url) => url.startsWith(PRIVATE))).toBe(true);

          // From now on every public provider fails and only the private node answers.
          privateFails = false;
          publicFails = true;
          const afterFirst = flaggedFetch.mock.calls.length;

          const pending = readPoolRate(fnName);
          await vi.runAllTimersAsync();
          await expect(pending).resolves.toBe(1234n);

          const attempted = attemptedUrls(flaggedFetch, afterFirst);
          expect(attempted[attempted.length - 1]).toBe(PRIVATE);
          expect(attempted.slice(0, -1).every((url) => !url.startsWith(PRIVATE))).toBe(true);
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it.each(POOL_RATE_READS)("%s tries the private node first again after the cooldown", async (fnName) => {
      vi.useFakeTimers();
      try {
        await readPoolRate(fnName);
        expect(privateCalls()).toHaveLength(1);

        const afterFirst = fetchMock.mock.calls.length;
        await readPoolRate(fnName);
        expect(firstRpcUrlSince(afterFirst).startsWith(PRIVATE)).toBe(false);

        vi.advanceTimersByTime(health.RPC_COOLDOWN_MS);

        const afterSecond = fetchMock.mock.calls.length;
        await readPoolRate(fnName);
        expect(firstRpcUrlSince(afterSecond).startsWith(PRIVATE)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a timed-out single-call retry puts the node in cooldown", async () => {
      const result = "0x" + (1234n).toString(16).padStart(64, "0");
      const flaggedFetch = flaggedRpcMock((url, init) => {
        const body = JSON.parse(String(init?.body)) as unknown;
        if (url.startsWith(PRIVATE)) {
          // The batch answers with a null entry, so the helper retries that call alone.
          if (Array.isArray(body)) return { ok: true, json: async () => [{ id: 0, result: "0x" }] } as unknown as Response;
          throw timeoutError();
        }
        return {
          ok: true,
          json: async () => (Array.isArray(body) ? [{ id: 0, result }] : { id: 0, result }),
        } as unknown as Response;
      });
      globalThis.fetch = flaggedFetch as unknown as typeof fetch;

      await expect(rpc.batchRpcCalls(CALLS)).resolves.toEqual([1234n]);

      const afterFirst = flaggedFetch.mock.calls.length;
      await expect(rpc.batchRpcCalls(CALLS)).resolves.toEqual([1234n]);

      expect(attemptedUrls(flaggedFetch, afterFirst)[0].startsWith(PRIVATE)).toBe(false);
    });

    it.each(POOL_RATE_READS)("%s logs no ok line when the result cannot be parsed", async (fnName) => {
      vi.useFakeTimers();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const result = "0x" + (1234n).toString(16).padStart(64, "0");
        const flaggedFetch = flaggedRpcMock((url) => {
          if (url.startsWith(PRIVATE)) {
            // Slow enough that a successful attempt would be logged.
            vi.setSystemTime(Date.now() + health.RPC_SLOW_LOG_MS);
            return { ok: true, json: async () => ({ id: 1, result: "0xnot-hex" }) } as unknown as Response;
          }
          return { ok: true, json: async () => ({ id: 1, result }) } as unknown as Response;
        });
        globalThis.fetch = flaggedFetch as unknown as typeof fetch;

        const pending = readPoolRate(fnName);
        await vi.runAllTimersAsync();
        await expect(pending).resolves.toBe(1234n);

        const lines = logSpy.mock.calls.map((parts) => parts.map((part) => String(part)).join(" "));
        const privateLines = lines.filter((line) => line.includes("private.node.example"));
        expect(privateLines.some((line) => line.includes('"outcome":"ok"'))).toBe(false);
        expect(privateLines.some((line) => line.includes('"outcome":"error"'))).toBe(true);
      } finally {
        logSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });
});
