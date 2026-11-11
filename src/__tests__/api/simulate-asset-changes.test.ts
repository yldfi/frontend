// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encodeAbiParameters, keccak256, pad, parseAbiParameters, toHex } from "viem";
import { TOKENS } from "@/config/vaults";

type AssetChange = {
  type: "send" | "receive" | "repay" | "borrow" | "deposit";
  symbol: string;
  amount: string;
  rawAmount: string;
  address: string;
  decimals: number;
  dollarValue?: string;
};
type Simulation = { success: boolean; assetChanges: AssetChange[]; tenderlyUrl?: string | null };
type Credentials = { nonce: string; expires: number; sig: string };

const mocks = vi.hoisted(() => ({ prices: vi.fn(), readContract: vi.fn() }));
vi.mock("@/lib/enso", () => ({
  fetchTokenPricesDirect: mocks.prices,
  ENSO_ROUTER_V2: "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf",
  MORPHO_BUNDLER3_ADDRESS: "0x6566194141eefa99af43bb5aa71460ca2dc90245",
}));
vi.mock("viem", async (importOriginal) => ({
  ...await importOriginal<typeof import("viem")>(),
  createPublicClient: () => ({ readContract: mocks.readContract, call: mocks.readContract }),
}));
import { OPTIONS, POST } from "@/app/api/simulate/route";
import { GET as shareSimulation } from "@/app/api/simulate/share/[simulationId]/route";
import { GET as nonce } from "@/app/api/simulate/nonce/route";

const FROM = "0x1234567890123456789012345678901234567890";
const TO = "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf";
const DATA = "0x21025a06";
const CONTROLLER = "0x24174143ccf438f0a1f6dcf93b468c127123a96e";
const AMM = "0xf1b03586c03ebfec014238d105148a15102a282f";
const VAULT_COLLATERAL = "0x95f19b19aff698169a1a0bbc28a2e47b14cb9a86";
const CRVUSD = "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e";
const ZERO = "0x0000000000000000000000000000000000000000";
const CVX = "0x4e3fbd56cd56c3e72c1403e103b45db9da5b9d2b";
const SIMULATION_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

type ChangeInput = {
  tokenAddress: string;
  symbol?: string;
  decimals?: number;
  from?: string;
  to?: string;
  amount?: string;
  rawAmount?: string;
  dollarValue?: string;
};

function change(overrides: ChangeInput) {
  return {
    token_info: {
      symbol: overrides.symbol ?? "TOKEN",
      decimals: overrides.decimals ?? 18,
      standard: "ERC20",
      contract_address: overrides.tokenAddress,
    },
    from: overrides.from ?? FROM,
    to: overrides.to ?? "0x0000000000000000000000000000000000000001",
    amount: overrides.amount ?? "1",
    raw_amount: overrides.rawAmount ?? "1000000000000000000",
    dollar_value: overrides.dollarValue,
  };
}

function tenderlyPayload(assetChanges: unknown[] | undefined) {
  return {
    simulation: { id: SIMULATION_ID, status: true, gas_used: 123456 },
    transaction: {
      status: true,
      gas_used: 123456,
      transaction_info: assetChanges === undefined ? {} : { asset_changes: assetChanges },
    },
  };
}

let lastTenderlyRequest: Record<string, unknown> | null;

function uniqueHeaders(origin = "https://yldfi.co") {
  return { origin, "x-forwarded-for": `asset-${crypto.randomUUID()}` };
}

async function post(body: Record<string, unknown>, headers: Record<string, string>) {
  const credentials = await (await nonce(new NextRequest("http://localhost:3000/api/simulate/nonce", { headers }))).json() as Credentials;
  return POST(new NextRequest("http://localhost:3000/api/simulate", {
    method: "POST",
    headers,
    body: JSON.stringify({ from: FROM, to: TO, data: DATA, ...credentials, ...body }),
  }));
}

async function simulateAssetChanges(): Promise<AssetChange[]> {
  const result = await (await post({}, uniqueHeaders())).json() as Simulation;
  expect(result.success).toBe(true);
  return result.assetChanges;
}

beforeEach(() => {
  lastTenderlyRequest = null;
  vi.stubEnv("TENDERLY_ACCOUNT_SLUG", "fixture");
  vi.stubEnv("TENDERLY_PROJECT_SLUG", "fixture");
  vi.stubEnv("TENDERLY_ACCESS_KEY", "fixture-only");
  vi.stubEnv("SIMULATION_NONCE_SECRET", "fixture-only-local-secret");
  mocks.prices.mockResolvedValue([]);
  mocks.readContract.mockRejectedValue(new Error("not ERC4626"));
});

function stubTenderly(assetChanges: unknown[] | undefined) {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    lastTenderlyRequest = JSON.parse(String(init?.body));
    return Response.json(tenderlyPayload(assetChanges));
  }));
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("POST /api/simulate asset changes", () => {
  it("classifies crvUSD into the controller as a repay and out of it as a borrow", async () => {
    stubTenderly([
      change({ tokenAddress: CRVUSD, symbol: "crvUSD", from: FROM, to: CONTROLLER }),
      change({ tokenAddress: CRVUSD, symbol: "crvUSD", from: CONTROLLER, to: FROM }),
    ]);

    const changes = await simulateAssetChanges();

    expect(changes.map((c) => c.type)).toEqual(["repay", "borrow"]);
    expect(changes.map((c) => c.symbol)).toEqual(["crvUSD", "crvUSD"]);
  });

  it("classifies crvUSD minted from the zero address as a borrow", async () => {
    stubTenderly([change({ tokenAddress: CRVUSD, symbol: "crvUSD", from: ZERO, to: FROM })]);

    const changes = await simulateAssetChanges();

    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe("borrow");
  });

  it("classifies vault collateral moved to and from the lending AMM", async () => {
    stubTenderly([
      change({ tokenAddress: VAULT_COLLATERAL, symbol: "ycvxCRV", from: FROM, to: AMM }),
      change({ tokenAddress: VAULT_COLLATERAL, symbol: "ycvxCRV", from: AMM, to: FROM }),
    ]);

    const changes = await simulateAssetChanges();

    expect(changes.map((c) => c.type)).toEqual(["deposit", "receive"]);
  });

  it("classifies user sends and receives and drops changes that do not involve the user", async () => {
    stubTenderly([
      change({ tokenAddress: "0x0000000000000000000000000000000000000010", from: FROM, to: "0x0000000000000000000000000000000000000011" }),
      change({ tokenAddress: "0x0000000000000000000000000000000000000010", from: "0x0000000000000000000000000000000000000012", to: FROM }),
      change({ tokenAddress: "0x0000000000000000000000000000000000000010", from: "0x0000000000000000000000000000000000000013", to: "0x0000000000000000000000000000000000000014" }),
    ]);

    const changes = await simulateAssetChanges();

    expect(changes.map((c) => c.type)).toEqual(["send", "receive"]);
  });

  it("matches the user address case-insensitively", async () => {
    stubTenderly([
      change({ tokenAddress: "0x0000000000000000000000000000000000000010", from: FROM.toUpperCase(), to: "0x0000000000000000000000000000000000000011" }),
    ]);

    const changes = await simulateAssetChanges();

    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe("send");
  });

  it("derives the amount from raw_amount when Tenderly's own amount is zero", async () => {
    stubTenderly([
      change({
        tokenAddress: "0x0000000000000000000000000000000000000010",
        from: "0x0000000000000000000000000000000000000012",
        to: FROM,
        amount: "0",
        rawAmount: "210504506594801098457",
      }),
      change({
        tokenAddress: "0x0000000000000000000000000000000000000010",
        from: FROM,
        to: "0x0000000000000000000000000000000000000011",
        amount: "0",
        rawAmount: "210504506594801098457",
      }),
    ]);

    const changes = await simulateAssetChanges();

    expect(changes.map((c) => c.amount)).toEqual([
      "210.504506594801098457",
      "210.504506594801098457",
    ]);
  });

  it("derives a 6-decimal amount from raw_amount", async () => {
    stubTenderly([
      change({
        tokenAddress: "0x0000000000000000000000000000000000000010",
        decimals: 6,
        from: "0x0000000000000000000000000000000000000012",
        to: FROM,
        amount: "0",
        rawAmount: "1500000",
      }),
    ]);

    const changes = await simulateAssetChanges();

    expect(changes[0].amount).toBe("1.5");
  });

  it("keeps a genuine zero raw_amount at zero", async () => {
    stubTenderly([
      change({ tokenAddress: "0x0000000000000000000000000000000000000010", from: "0x0000000000000000000000000000000000000012", to: FROM, amount: "5", rawAmount: "0" }),
    ]);

    const changes = await simulateAssetChanges();

    expect(changes[0].amount).toBe("0");
  });

  it("signs a share link that the real share endpoint accepts", async () => {
    stubTenderly([]);

    const result = await (await post({}, uniqueHeaders())).json() as Simulation;

    expect(result.tenderlyUrl).toMatch(new RegExp(`^/api/simulate/share/${SIMULATION_ID}\\?sig=[A-Za-z0-9_-]+$`));
    const shareUrl = new URL(result.tenderlyUrl!, "https://yldfi.co");
    const response = await shareSimulation(
      new NextRequest(shareUrl),
      { params: Promise.resolve({ simulationId: SIMULATION_ID }) },
    );

    expect(response.status).not.toBe(403);
    expect(response.status).toBe(200);
  });

  it("overrides Tenderly's lowercase CVX symbol with canonical casing", async () => {
    stubTenderly([
      change({ tokenAddress: CVX.toUpperCase().replace("0X", "0x"), symbol: "cvx", from: FROM, to: "0x0000000000000000000000000000000000000011" }),
    ]);

    const changes = await simulateAssetChanges();

    expect(changes[0].symbol).toBe("CVX");
  });

  it("keeps a Tenderly dollar value when no price source can price the token", async () => {
    stubTenderly([
      change({ tokenAddress: "0x0000000000000000000000000000000000000010", from: "0x0000000000000000000000000000000000000012", to: FROM, dollarValue: "42.50" }),
    ]);

    const changes = await simulateAssetChanges();

    expect(changes[0].dollarValue).toBe("42.5");
  });

  it("returns no asset changes when Tenderly reports none", async () => {
    stubTenderly(undefined);

    const changes = await simulateAssetChanges();

    expect(changes).toEqual([]);
  });

  it("writes a synthetic CVX balance slot for the sender only when the input token is CVX", async () => {
    stubTenderly([]);

    await post({ inputToken: TOKENS.CVX }, uniqueHeaders());

    const request = lastTenderlyRequest as {
      state_objects?: Record<string, { storage: Record<string, string> }>;
    };
    const expectedSlot = keccak256(
      encodeAbiParameters(parseAbiParameters("address, uint256"), [FROM as `0x${string}`, 0n])
    );
    expect(request.state_objects).toEqual({
      [TOKENS.CVX]: {
        storage: {
          [expectedSlot]: pad(toHex((1n << 256n) - 1n), { size: 32 }),
        },
      },
    });

    await post({ inputToken: "0x0000000000000000000000000000000000000010" }, uniqueHeaders());

    expect((lastTenderlyRequest as { state_objects?: unknown }).state_objects).toBeUndefined();
  });

  it("normalizes the requested gas for Tenderly and drops invalid values", async () => {
    stubTenderly([]);

    await post({ gas: "60000000" }, uniqueHeaders());
    expect((lastTenderlyRequest as { gas?: number }).gas).toBe(60000000);

    await post({ gas: "0x3938700" }, uniqueHeaders());
    expect((lastTenderlyRequest as { gas?: number }).gas).toBe(60000000);

    await post({ gas: 60000000 }, uniqueHeaders());
    expect((lastTenderlyRequest as { gas?: number }).gas).toBe(60000000);

    await post({ gas: "not-a-number" }, uniqueHeaders());
    expect((lastTenderlyRequest as { gas?: number }).gas).toBeUndefined();

    await post({ gas: 0 }, uniqueHeaders());
    expect((lastTenderlyRequest as { gas?: number }).gas).toBeUndefined();
  });

  it("echoes an allowed origin and falls back to the canonical origin otherwise", async () => {
    stubTenderly([]);

    const allowed = await post({}, uniqueHeaders("https://www.yldfi.co"));
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://www.yldfi.co");

    const unknown = await post({}, uniqueHeaders("https://attacker.example"));
    expect(unknown.headers.get("Access-Control-Allow-Origin")).toBe("https://yldfi.co");

    const preflight = await OPTIONS(new NextRequest("http://localhost:3000/api/simulate", {
      headers: { origin: "https://attacker.example" },
    }));
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("https://yldfi.co");
  });
});
