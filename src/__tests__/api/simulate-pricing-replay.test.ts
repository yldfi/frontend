// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SimulationAssetChange } from "@/types/enso";
import fixture from "@/__tests__/fixtures/simulation-pricing-yscvx-pxcvx.json";

type Result = { success: boolean; assetChanges: SimulationAssetChange[] };

const mocks = vi.hoisted(() => ({ prices: vi.fn(), readContract: vi.fn() }));
vi.mock("@/lib/enso", () => ({
  fetchTokenPricesDirect: mocks.prices,
  ENSO_ROUTER_V2: "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf",
  MORPHO_BUNDLER3_ADDRESS: "0x6566194141eefa99af43bb5aa71460ca2dc90245",
}));
vi.mock("viem", async (importOriginal) => ({
  ...await importOriginal<typeof import("viem")>(),
  createPublicClient: () => ({ readContract: mocks.readContract }),
}));
import { POST } from "@/app/api/simulate/route";
import { GET as nonce } from "@/app/api/simulate/nonce/route";

beforeEach(() => {
  vi.stubEnv("TENDERLY_ACCOUNT_SLUG", "fixture");
  vi.stubEnv("TENDERLY_PROJECT_SLUG", "fixture");
  vi.stubEnv("TENDERLY_ACCESS_KEY", "fixture-only");
  vi.stubEnv("SIMULATION_NONCE_SECRET", "fixture-only-local-secret");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(fixture.tenderly)));
  mocks.prices.mockImplementation(async (addresses: string[]) => fixture.prices.filter(p => addresses.includes(p.address.toLowerCase())));
  mocks.readContract.mockImplementation(async ({ functionName, args }) => {
    if (functionName === "convertToAssets") return BigInt(args[0]); // Replay redeems 1746 shares for 1746 CVX.
    throw new Error("not ERC4626");
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

async function simulate() {
  const headers = { "origin": "http://localhost:3000", "x-forwarded-for": `fixture-${crypto.randomUUID()}` };
  const credentials = await (await nonce(new NextRequest("http://localhost:3000/api/simulate/nonce", { headers }))).json() as { nonce: string; expires: number; sig: string };
  return POST(new NextRequest("http://localhost:3000/api/simulate", {
    method: "POST", headers,
    body: JSON.stringify({ from: fixture.wallet, to: "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf", data: "0x21025a06", ...credentials }),
  }));
}

describe("actual simulation route with captured Tenderly/Enso pricing", () => {
  it("fills both zero Tenderly values from Enso plus vault conversion", async () => {
    const response = await simulate(); const result = await response.json() as Result;
    expect(response.status).toBe(200); expect(result.success).toBe(true);
    expect(result.assetChanges.map((c: { symbol: string }) => c.symbol)).toEqual(["ysCVX", "pxCVX"]);
    expect(Number(result.assetChanges[0].dollarValue)).toBeCloseTo(1746 * 1.9291830487595751, 6);
    expect(Number(result.assetChanges[1].dollarValue)).toBeCloseTo(1854.1818614601252 * 1.9433860215757002, 6);
  });

  it("preserves pxCVX pricing when vault RPC fails", async () => {
    mocks.readContract.mockRejectedValue(new Error("rpc unavailable"));
    const result = await (await simulate()).json() as Result;
    expect(result.assetChanges[0]).not.toHaveProperty("dollarValue");
    expect(Number(result.assetChanges[1].dollarValue)).toBeGreaterThan(0);
  });

  it("omits both dollar fields when neither source can price them", async () => {
    mocks.prices.mockRejectedValue(new Error("price service unavailable"));
    const result = await (await simulate()).json() as Result;
    expect(result.success).toBe(true);
    expect(result.assetChanges).toHaveLength(2);
    for (const c of result.assetChanges) expect(c).not.toHaveProperty("dollarValue");
  });
  it("retries a rate-limited batch once without fanning out requests", async () => {
    mocks.prices.mockRejectedValueOnce(Object.assign(new Error("limited"), { statusCode: 429 }));
    const result = await (await simulate()).json() as Result;
    expect(result.assetChanges.every(c => Number(c.dollarValue) > 0)).toBe(true);
    expect(mocks.prices).toHaveBeenCalledTimes(2);
    expect(mocks.prices.mock.calls[0][0]).toHaveLength(2);
    expect(mocks.prices.mock.calls[1][0]).toEqual(mocks.prices.mock.calls[0][0]);
  });

  it("keeps the priced token when an unsupported batch needs isolated lookups and one hangs", async () => {
    mocks.prices.mockImplementation(async (addresses: string[]) => {
      if (addresses.length > 1) throw Object.assign(new Error("unsupported"), { statusCode: 400 });
      if (addresses[0] === "0x4e3fbd56cd56c3e72c1403e103b45db9da5b9d2b") return new Promise(() => {});
      return fixture.prices.filter(p => addresses.includes(p.address.toLowerCase()));
    });
    const result = await (await simulate()).json() as Result;
    expect(result.assetChanges[0]).not.toHaveProperty("dollarValue");
    expect(Number(result.assetChanges[1].dollarValue)).toBeGreaterThan(0);
  });

});
