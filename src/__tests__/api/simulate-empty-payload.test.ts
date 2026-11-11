// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fixture from "@/__tests__/fixtures/simulation-pricing-yscvx-pxcvx.json";

type Result = {
  success: boolean;
  errorMessage?: string | null;
  simulationUnavailable?: boolean;
  simulationUnavailableReason?: string;
  simulationId?: string | null;
  gasUsed?: number | null;
  assetChanges: { symbol: string }[];
};

const mocks = vi.hoisted(() => ({ prices: vi.fn(), readContract: vi.fn(), call: vi.fn() }));
vi.mock("@/lib/enso", () => ({
  fetchTokenPricesDirect: mocks.prices,
  ENSO_ROUTER_V2: "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf",
  MORPHO_BUNDLER3_ADDRESS: "0x6566194141eefa99af43bb5aa71460ca2dc90245",
}));
vi.mock("viem", async (importOriginal) => ({
  ...await importOriginal<typeof import("viem")>(),
  createPublicClient: () => ({ readContract: mocks.readContract, call: mocks.call }),
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
    if (functionName === "convertToAssets") return BigInt(args[0]);
    throw new Error("not ERC4626");
  });
  mocks.call.mockResolvedValue({});
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

describe("simulation route with an unreadable Tenderly body", () => {
  it("reports a 200 with a non-JSON body as unavailable when eth_call passes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 200 })));
    const response = await simulate();
    const result = await response.json() as Result;
    expect(response.status).toBe(200);
    expect(result.success).toBe(true);
    expect(result.simulationUnavailable).toBe(true);
    expect(typeof result.simulationUnavailableReason).toBe("string");
    expect((result.simulationUnavailableReason ?? "").length).toBeGreaterThan(0);
    expect(result.assetChanges).toEqual([]);
    expect(result.simulationId).toBeNull();
    expect(mocks.call).toHaveBeenCalled();
  });

  it("reports an empty 200 body as unavailable when eth_call passes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    const response = await simulate();
    const result = await response.json() as Result;
    expect(response.status).toBe(200);
    expect(result.success).toBe(true);
    expect(result.simulationUnavailable).toBe(true);
    expect((result.simulationUnavailableReason ?? "").length).toBeGreaterThan(0);
    expect(result.assetChanges).toEqual([]);
    expect(result.simulationId).toBeNull();
  });

  it("reports a body read that times out as a fixed unavailable reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: () => new Promise(() => {}) }) as unknown as Response)
    );
    const response = await simulate();
    const result = await response.json() as Result;
    expect(response.status).toBe(200);
    expect(result.success).toBe(true);
    expect(result.simulationUnavailable).toBe(true);
    expect(result.simulationUnavailableReason).toBe("Simulation service unavailable");
    expect(result.assetChanges).toEqual([]);
    expect(mocks.call).toHaveBeenCalled();
  });

  it("hides a thrown Tenderly fetch error behind the fixed unavailable reason", async () => {
    const leaked = "tenderly fetch secret abc123";
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error(leaked))));
    const response = await simulate();
    const result = await response.json() as Result;
    expect(response.status).toBe(200);
    expect(result.success).toBe(true);
    expect(result.simulationUnavailable).toBe(true);
    expect(result.simulationUnavailableReason).toBe("Simulation service unavailable");
    expect(JSON.stringify(result)).not.toContain(leaked);
    expect(mocks.call).toHaveBeenCalled();
  });

  it("hides a Tenderly API error body behind the fixed unavailable reason", async () => {
    const leaked = "tenderly quota secret xyz789";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { slug: "quota_limit_reached", message: leaked } },
          { status: 429 }
        )
      )
    );
    const response = await simulate();
    const result = await response.json() as Result;
    expect(response.status).toBe(200);
    expect(result.success).toBe(true);
    expect(result.simulationUnavailable).toBe(true);
    expect(result.simulationUnavailableReason).toBe("Simulation service unavailable");
    expect(JSON.stringify(result)).not.toContain(leaked);
    expect(mocks.call).toHaveBeenCalled();
  });

  it("fails when the unreadable body is followed by a reverting eth_call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    mocks.call.mockRejectedValue(new Error("execution reverted"));
    const response = await simulate();
    const result = await response.json() as Result;
    expect(response.status).toBe(400);
    expect(result.success).toBe(false);
    expect(typeof result.errorMessage).toBe("string");
    expect(result.simulationUnavailable).not.toBe(true);
  });

  it("still succeeds for a real Tenderly payload", async () => {
    const response = await simulate();
    const result = await response.json() as Result;
    expect(response.status).toBe(200);
    expect(result.success).toBe(true);
    expect(result.simulationUnavailable).toBeUndefined();
    expect(result.assetChanges).toHaveLength(2);
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("keeps a Tenderly-reported revert as a failure, not as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      simulation: { id: "x", status: false, error_message: "boom" },
      transaction: { status: false },
    })));
    const result = await (await simulate()).json() as Result;
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe("boom");
    expect(result.simulationUnavailable).not.toBe(true);
  });
});
