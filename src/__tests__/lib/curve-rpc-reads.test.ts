// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A private node first in the list, exactly like the consumer tests that
// exercise the fallback chain.
const PRIVATE = "https://private.node.example/rpc/secret-key";

// Lower-case literals keep the EIP-55 lint rule happy. The upper-case variant is
// built at runtime by the cache-key test because a mixed-case address literal
// would have to be checksummed.
const POOL = "0x" + "ab".repeat(20);
const POOL_UPPER = "0x" + "AB".repeat(20);
const VAULT = "0x" + "cd".repeat(20);

/** A 32-byte ABI word, as an RPC result (`0x`-prefixed). */
const word = (value: bigint) => "0x" + value.toString(16).padStart(64, "0");
/** The same word as calldata: appended to a selector, so it has no `0x`. */
const arg = (value: bigint) => value.toString(16).padStart(64, "0");

const ok = (reply: unknown) => ({ ok: true, json: async () => reply }) as unknown as Response;
const httpError = (status = 502) => ({ ok: false, status, json: async () => ({}) }) as unknown as Response;

const bodyOf = (init?: RequestInit): unknown => JSON.parse(String(init?.body));

interface BatchEntry {
  id: number;
  method: string;
  params: [{ to: string; data: string }, string];
}

const asBatch = (body: unknown) => body as BatchEntry[];
const asSingle = (body: unknown) => body as BatchEntry;

type RpcModule = typeof import("@/lib/curve/rpc");

describe("server-side curve pool/vault read helpers", () => {
  let rpc: RpcModule;
  let fetchMock: ReturnType<typeof vi.fn>;
  let unexpectedUrls: string[];

  beforeEach(async () => {
    // Production retry settings (live mode), with a private node first in the
    // list so fall-through is observable. The delays are advanced with fake timers.
    vi.stubEnv("ENSO_API_KEY", "test-key");
    vi.stubEnv("DEBUG_RPC_URL", PRIVATE);
    vi.stubEnv("DEBUG_RPC_AUTH", "user:pass");
    vi.useFakeTimers();
    vi.resetModules();
    // The same fresh module instance the helpers import (module-level provider cooldowns).
    const health = await import("@/lib/rpc-health");
    health.resetRpcHealth();
    // The helpers log every exhausted fallback; keep the output clean and let
    // the one test that cares assert on the call count.
    vi.spyOn(console, "error").mockImplementation(() => {});
    unexpectedUrls = [];
    rpc = await import("@/lib/curve/rpc");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    // A URL the mock does not know about means the test asserted on a fallback
    // path it did not model; the helper's try/catch would otherwise hide it.
    expect(unexpectedUrls).toEqual([]);
  });

  /** Install a fetch mock that answers per URL; the chainlist probe always fails. */
  function installFetch(
    respond: (url: string, init?: RequestInit) => Response | undefined,
  ): void {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("chainid.network")) return { ok: false, json: async () => [] } as unknown as Response;
      const reply = respond(String(url), init);
      if (!reply) {
        unexpectedUrls.push(String(url));
        throw new Error(`unexpected RPC URL: ${String(url)}`);
      }
      return reply;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  }

  const rpcCalls = () => fetchMock.mock.calls.filter(([url]) => !String(url).includes("chainid.network"));
  const privateCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(PRIVATE));

  describe("batchRpcCalls", () => {
    const CALL_A = { to: POOL, data: "0xaaaa" };
    const CALL_B = { to: POOL, data: "0xbbbb" };
    const CALL_C = { to: POOL, data: "0xcccc" };

    it("returns an empty array for no calls without touching the network", async () => {
      installFetch(() => undefined);

      await expect(rpc.batchRpcCalls([])).resolves.toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("maps a reply sorted out of order back onto the call order", async () => {
      installFetch((url, init) => {
        if (!url.startsWith(PRIVATE)) return undefined;
        const body = asBatch(bodyOf(init));
        const values: Record<number, bigint> = { 0: 11n, 1: 22n, 2: 33n };
        // Answer 2, 0, 1: the helper has to sort by id.
        return ok([body[2], body[0], body[1]].map((entry) => ({ id: entry.id, result: word(values[entry.id]) })));
      });

      await expect(rpc.batchRpcCalls([CALL_A, CALL_B, CALL_C])).resolves.toEqual([11n, 22n, 33n]);
    });

    it("posts one JSON-RPC array with indexed ids and latest-block eth_calls", async () => {
      let body: unknown;
      installFetch((url, init) => {
        if (!url.startsWith(PRIVATE)) return undefined;
        body = bodyOf(init);
        return ok(asBatch(body).map((entry) => ({ id: entry.id, result: word(1n) })));
      });

      await rpc.batchRpcCalls([CALL_A, CALL_B, CALL_C]);

      expect(body).toEqual([
        { jsonrpc: "2.0", id: 0, method: "eth_call", params: [{ to: CALL_A.to, data: CALL_A.data }, "latest"] },
        { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: CALL_B.to, data: CALL_B.data }, "latest"] },
        { jsonrpc: "2.0", id: 2, method: "eth_call", params: [{ to: CALL_C.to, data: CALL_C.data }, "latest"] },
      ]);
    });

    it("re-requests a failed entry on its own and merges that value", async () => {
      installFetch((url, init) => {
        if (!url.startsWith(PRIVATE)) return undefined;
        const body = bodyOf(init);
        if (Array.isArray(body)) {
          return ok(
            asBatch(body).map((entry) =>
              entry.id === 1
                ? { id: entry.id, error: { message: "header not found" } }
                : { id: entry.id, result: word(BigInt(10 + entry.id)) },
            ),
          );
        }
        return ok({ id: 0, result: word(99n) });
      });

      const result = await rpc.batchRpcCalls([CALL_A, CALL_B, CALL_C]);

      expect(result).toEqual([10n, 99n, 12n]);
      const singles = privateCalls().filter(([, init]) => !Array.isArray(bodyOf(init as RequestInit)));
      expect(singles).toHaveLength(1);
      const singleBody = asSingle(bodyOf(singles[0][1] as RequestInit));
      expect(singleBody).toMatchObject({ jsonrpc: "2.0", id: 0, method: "eth_call" });
      expect(singleBody.params[0]).toEqual({ to: CALL_B.to, data: CALL_B.data });
      expect(singleBody.params[1]).toBe("latest");
    });

    it("moves to the next URL when a single-entry retry still returns nothing", async () => {
      installFetch((url, init) => {
        const body = bodyOf(init);
        if (url.startsWith(PRIVATE)) {
          if (Array.isArray(body)) {
            return ok(
              asBatch(body).map((entry) =>
                entry.id === 1
                  ? { id: entry.id, error: { message: "header not found" } }
                  : { id: entry.id, result: word(BigInt(10 + entry.id)) },
              ),
            );
          }
          return ok({ id: 0, error: { message: "header not found" } });
        }
        // Only the whole batch may reach the public URL here.
        if (!Array.isArray(body)) return undefined;
        return ok(asBatch(body).map((entry) => ({ id: entry.id, result: word(BigInt(20 + entry.id)) })));
      });

      await expect(rpc.batchRpcCalls([CALL_A, CALL_B, CALL_C])).resolves.toEqual([20n, 21n, 22n]);
      // Two batches and the two single-entry retries all hit the first URL.
      expect(privateCalls()).toHaveLength(4);
    });

    it("falls through to the next URL after an HTTP error", async () => {
      installFetch((url, init) => {
        if (url.startsWith(PRIVATE)) return httpError(502);
        return ok(asBatch(bodyOf(init)).map((entry) => ({ id: entry.id, result: word(BigInt(5 + entry.id)) })));
      });

      const pending = rpc.batchRpcCalls([CALL_A, CALL_B]);
      await vi.runAllTimersAsync();

      await expect(pending).resolves.toEqual([5n, 6n]);
    });

    it("falls through when the reply is not an array", async () => {
      installFetch((url, init) => {
        if (url.startsWith(PRIVATE)) return ok({ id: 0, result: word(1n) });
        return ok(asBatch(bodyOf(init)).map((entry) => ({ id: entry.id, result: word(BigInt(7 + entry.id)) })));
      });

      const pending = rpc.batchRpcCalls([CALL_A, CALL_B]);
      await vi.runAllTimersAsync();

      await expect(pending).resolves.toEqual([7n, 8n]);
    });

    it("returns nulls and logs once when every URL fails", async () => {
      installFetch(() => httpError(502));

      const pending = rpc.batchRpcCalls([CALL_A, CALL_B]);
      await vi.runAllTimersAsync();

      await expect(pending).resolves.toEqual([null, null]);
      expect(vi.mocked(console.error)).toHaveBeenCalledTimes(1);
    });
  });

  describe("previewRedeem", () => {
    it("encodes the shares and returns the amount as a decimal string", async () => {
      let body: BatchEntry | undefined;
      installFetch((url, init) => {
        if (!url.startsWith(PRIVATE)) return undefined;
        body = asBatch(bodyOf(init))[0];
        return ok([{ id: 0, result: word(1_500_000_000_000_000_000n) }]);
      });

      await expect(rpc.previewRedeem(VAULT, "1000000000000000000")).resolves.toBe("1500000000000000000");
      expect(body?.params[0]).toEqual({
        to: VAULT,
        data: rpc.SELECTORS.PREVIEW_REDEEM + arg(10n ** 18n),
      });
    });

    it("throws when every URL returns an empty result", async () => {
      installFetch((url, init) => {
        const body = bodyOf(init);
        return Array.isArray(body)
          ? ok(asBatch(body).map((entry) => ({ id: entry.id, result: "0x" })))
          : ok({ id: 0, result: "0x" });
      });

      const pending = rpc.previewRedeem(VAULT, "1").catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = await pending;

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(`Failed to preview redeem for vault ${VAULT}`);
    });
  });

  describe.each([
    ["getCurveGetDy", "GET_DY_INT128"],
    ["getCurveGetDyFactory", "GET_DY_UINT256"],
  ] as const)("%s", (fnName, selectorName) => {
    it("encodes the pool indices with the function's selector", async () => {
      installFetch((url) => (url.startsWith(PRIVATE) ? ok({ id: 1, result: word(777n) }) : undefined));

      await expect(rpc[fnName](POOL, 0, 1, "1000")).resolves.toBe(777n);

      const body = asSingle(bodyOf(privateCalls()[0][1] as RequestInit));
      expect(body).toMatchObject({ jsonrpc: "2.0", id: 1, method: "eth_call" });
      expect(body.params[0]).toEqual({
        to: POOL,
        data: rpc.SELECTORS[selectorName] + arg(0n) + arg(1n) + arg(1000n),
      });
      expect(body.params[1]).toBe("latest");
    });

    it("falls through to the next URL after a JSON-RPC error body", async () => {
      installFetch((url) =>
        url.startsWith(PRIVATE) ? ok({ id: 1, error: { message: "rate limited" } }) : ok({ id: 1, result: word(4242n) }),
      );

      const pending = rpc[fnName](POOL, 0, 1, "1000");
      await vi.runAllTimersAsync();

      await expect(pending).resolves.toBe(4242n);
      expect(privateCalls()).toHaveLength(2);
    });

    it("returns null for an empty result without asking another URL", async () => {
      installFetch((url) => (url.startsWith(PRIVATE) ? ok({ id: 1, result: "0x" }) : undefined));

      await expect(rpc[fnName](POOL, 0, 1, "1000")).resolves.toBeNull();
      expect(privateCalls()).toHaveLength(1);
    });

    it("returns null when every URL fails", async () => {
      installFetch(() => {
        throw new Error("network down");
      });

      const pending = rpc[fnName](POOL, 0, 1, "1000");
      await vi.runAllTimersAsync();

      await expect(pending).resolves.toBeNull();
      expect(rpcCalls().length).toBeGreaterThan(1);
    });
  });

  describe("getCryptoSwapParams", () => {
    beforeEach(() => {
      rpc.clearCryptoPoolParamsCache();
    });

    /** Valid pool parameters keyed by the calldata that must fetch them. */
    const cryptoValues = (): Record<string, bigint> => ({
      [rpc.CRYPTOSWAP_SELECTORS.A]: 100n,
      [rpc.CRYPTOSWAP_SELECTORS.GAMMA]: 2n,
      [rpc.CRYPTOSWAP_SELECTORS.D]: 3_000n,
      [rpc.CRYPTOSWAP_SELECTORS.MID_FEE]: 4n,
      [rpc.CRYPTOSWAP_SELECTORS.OUT_FEE]: 5n,
      [rpc.CRYPTOSWAP_SELECTORS.FEE_GAMMA]: 6n,
      [rpc.CRYPTOSWAP_SELECTORS.PRICE_SCALE]: 7n,
      [rpc.SELECTORS.BALANCES + arg(0n)]: 8n,
      [rpc.SELECTORS.BALANCES + arg(1n)]: 9n,
    });

    /** Answer the parameter batch from a calldata→value map, failing loudly on unknown calldata. */
    const installParamReader = (values: () => Record<string, bigint>) => {
      installFetch((url, init) => {
        if (!url.startsWith(PRIVATE)) return undefined;
        const body = asBatch(bodyOf(init));
        const map = values();
        return ok(
          body.map((entry) => {
            const value = map[entry.params[0].data];
            if (value === undefined) throw new Error(`unexpected calldata ${entry.params[0].data}`);
            return { id: entry.id, result: word(value) };
          }),
        );
      });
    };

    const rejected = async (promise: Promise<unknown>) => {
      const settled = promise.catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = await settled;
      expect(error).toBeInstanceOf(Error);
      return error as Error;
    };

    it("reads the nine parameters in the documented order", async () => {
      installParamReader(cryptoValues);

      await expect(rpc.getCryptoSwapParams(POOL)).resolves.toEqual({
        A: 100n,
        gamma: 2n,
        D: 3_000n,
        midFee: 4n,
        outFee: 5n,
        feeGamma: 6n,
        priceScale: 7n,
        balances: [8n, 9n],
      });

      const batch = asBatch(bodyOf(privateCalls()[0][1] as RequestInit));
      expect(batch.map((entry) => entry.params[0].data)).toEqual([
        rpc.CRYPTOSWAP_SELECTORS.A,
        rpc.CRYPTOSWAP_SELECTORS.GAMMA,
        rpc.CRYPTOSWAP_SELECTORS.D,
        rpc.CRYPTOSWAP_SELECTORS.MID_FEE,
        rpc.CRYPTOSWAP_SELECTORS.OUT_FEE,
        rpc.CRYPTOSWAP_SELECTORS.FEE_GAMMA,
        rpc.CRYPTOSWAP_SELECTORS.PRICE_SCALE,
        rpc.SELECTORS.BALANCES + arg(0n),
        rpc.SELECTORS.BALANCES + arg(1n),
      ]);
    });

    it("gives up after three attempts when A is zero", async () => {
      installParamReader(() => ({ ...cryptoValues(), [rpc.CRYPTOSWAP_SELECTORS.A]: 0n }));

      const error = await rejected(rpc.getCryptoSwapParams(POOL));

      expect(error.message).toContain("A parameter is zero");
      const batches = privateCalls().filter(([, init]) => Array.isArray(bodyOf(init as RequestInit)));
      expect(batches).toHaveLength(3);
    });

    it("rejects when gamma is zero", async () => {
      installParamReader(() => ({ ...cryptoValues(), [rpc.CRYPTOSWAP_SELECTORS.GAMMA]: 0n }));

      const error = await rejected(rpc.getCryptoSwapParams(POOL));

      expect(error.message).toContain("gamma parameter is zero");
    });

    it("rejects when D is zero but the pool has balances", async () => {
      installParamReader(() => ({ ...cryptoValues(), [rpc.CRYPTOSWAP_SELECTORS.D]: 0n }));

      const error = await rejected(rpc.getCryptoSwapParams(POOL));

      expect(error.message).toContain("D is zero but pool has balances");
    });

    it("accepts a zero D when both balances are zero", async () => {
      installParamReader(() => ({
        ...cryptoValues(),
        [rpc.CRYPTOSWAP_SELECTORS.D]: 0n,
        [rpc.SELECTORS.BALANCES + arg(0n)]: 0n,
        [rpc.SELECTORS.BALANCES + arg(1n)]: 0n,
      }));

      await expect(rpc.getCryptoSwapParams(POOL)).resolves.toMatchObject({ D: 0n, balances: [0n, 0n] });
      expect(privateCalls()).toHaveLength(1);
    });

    it("recovers when a later attempt returns valid parameters", async () => {
      let attempts = 0;
      installFetch((url, init) => {
        if (!url.startsWith(PRIVATE)) return undefined;
        const body = asBatch(bodyOf(init));
        const map = cryptoValues();
        if (attempts++ === 0) map[rpc.CRYPTOSWAP_SELECTORS.A] = 0n;
        return ok(body.map((entry) => ({ id: entry.id, result: word(map[entry.params[0].data]) })));
      });

      const pending = rpc.getCryptoSwapParams(POOL);
      await vi.runAllTimersAsync();

      await expect(pending).resolves.toMatchObject({ A: 100n, gamma: 2n, balances: [8n, 9n] });
      expect(privateCalls()).toHaveLength(2);
    });

    it("caches a valid result per lower-cased address for 12 seconds", async () => {
      installParamReader(cryptoValues);

      await rpc.getCryptoSwapParams(POOL);
      expect(rpcCalls()).toHaveLength(1);

      // Same pool, different letter case: served from the cache.
      await expect(rpc.getCryptoSwapParams(POOL_UPPER)).resolves.toMatchObject({ A: 100n });
      expect(rpcCalls()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(12_001);
      await rpc.getCryptoSwapParams(POOL);
      expect(rpcCalls()).toHaveLength(2);
    });

    it("does not cache a failed fetch", async () => {
      let failing = true;
      installFetch((url, init) => {
        if (!url.startsWith(PRIVATE)) return undefined;
        const body = asBatch(bodyOf(init));
        const map = cryptoValues();
        if (failing) map[rpc.CRYPTOSWAP_SELECTORS.A] = 0n;
        return ok(body.map((entry) => ({ id: entry.id, result: word(map[entry.params[0].data]) })));
      });

      const error = await rejected(rpc.getCryptoSwapParams(POOL));
      expect(error.message).toContain("A parameter is zero");

      failing = false;
      await expect(rpc.getCryptoSwapParams(POOL)).resolves.toMatchObject({ A: 100n });
    });
  });
});
