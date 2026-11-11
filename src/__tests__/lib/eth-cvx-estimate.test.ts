// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RpcModule = typeof import("@/lib/curve/rpc");

// A deliberately non-linear pool: doubling `dx` buys strictly less than twice
// as much CVX, so a rate cached from one size cannot price another.
const K = 10n ** 21n;
const poolDy = (dx: bigint): bigint => (dx * 1000n * K) / (K + dx);

const encodeUint256Result = (value: bigint): string =>
  "0x" + value.toString(16).padStart(64, "0");

describe("getEthToCvxEstimate", () => {
  let rpc: RpcModule;
  let fetchMock: ReturnType<typeof vi.fn>;

  const rpcCalls = () =>
    fetchMock.mock.calls.filter(([url]) => !String(url).includes("chainid.network"));

  beforeEach(async () => {
    vi.stubEnv("ENSO_API_KEY", "test-key");
    vi.resetModules();
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("chainid.network")) {
        return { ok: false, json: async () => [] } as unknown as Response;
      }
      const body = JSON.parse(String(init?.body));
      // get_dy(uint256,uint256,uint256): the last 32-byte word is `dx`.
      const dx = BigInt("0x" + String(body.params[0].data).slice(-64));
      return {
        ok: true,
        json: async () => ({ id: body.id, result: encodeUint256Result(poolDy(dx)) }),
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    rpc = await import("@/lib/curve/rpc");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("quotes each amount at its own size", async () => {
    const oneEth = 10n ** 18n;
    const hundredEth = 100n * oneEth;

    const first = BigInt(await rpc.getEthToCvxEstimate(oneEth.toString()));
    const second = BigInt(await rpc.getEthToCvxEstimate(hundredEth.toString()));

    expect(second).toBe(poolDy(hundredEth));
    expect(second).toBeLessThan(100n * first);
  });

  it("does not reuse a large quote's rate for a small one", async () => {
    const oneEth = 10n ** 18n;
    const hundredEth = 100n * oneEth;

    await rpc.getEthToCvxEstimate(hundredEth.toString());
    const small = BigInt(await rpc.getEthToCvxEstimate(oneEth.toString()));

    expect(small).toBe(poolDy(oneEth));
  });

  it("asks the pool once per call", async () => {
    const oneEth = 10n ** 18n;

    await rpc.getEthToCvxEstimate(oneEth.toString());
    await rpc.getEthToCvxEstimate((100n * oneEth).toString());

    expect(rpcCalls()).toHaveLength(2);
  });

  it("throws when the pool returns zero", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("chainid.network")) {
        return { ok: false, json: async () => [] } as unknown as Response;
      }
      const body = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ id: body.id, result: "0x" + "0".repeat(64) }),
      } as unknown as Response;
    });

    await expect(rpc.getEthToCvxEstimate((10n ** 18n).toString())).rejects.toThrow(
      "Failed to fetch ETH/CVX price"
    );
  });
});
