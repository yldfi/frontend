import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mock setup
// ============================================================================

vi.mock("@/config/vaults", () => ({
  CURVE_CONTROLLERS: {
    "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86": "0x24174143cCF438f0A1F6dCF93B468C127123A96E",
  },
  getVaultByAddress: (addr: string) => {
    const vaults: Record<string, { address: string }> = {
      "0x95f19b19aff698169a1a0bbc28a2e47b14cb9a86": {
        address: "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86",
      },
    };
    return vaults[addr.toLowerCase()];
  },
}));

vi.mock("@/config/addresses", () => ({
  CRVUSD_ADDRESS: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E",
}));

import { runVNetSimulation } from "@/lib/vnet-simulation";

// ============================================================================
// Shared constants and helpers
// ============================================================================

const USER_ADDRESS = "0xUserAddress1234567890abcdef1234567890abcdef";
const CONTROLLER_ADDRESS = "0x24174143cCF438f0A1F6dCF93B468C127123A96E";
const CRVUSD = "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E";
const VAULT_COLLATERAL = "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86";
const RANDOM_TOKEN = "0xdEADbeEF00000000000000000000000000000001";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const TX_PARAMS = {
  from: USER_ADDRESS,
  to: "0xSomeContract",
  data: "0x1234",
};

function makeAssetChange(overrides: {
  contractAddress?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  type?: string;
  from?: string;
  to?: string;
  rawAmount?: string;
  amount?: string;
}) {
  return {
    assetInfo: {
      standard: "ERC20",
      type: "Fungible",
      contractAddress: overrides.contractAddress ?? RANDOM_TOKEN,
      symbol: overrides.symbol ?? "TKN",
      name: overrides.name ?? "Token",
      decimals: overrides.decimals ?? 18,
    },
    type: overrides.type ?? "Transfer",
    from: overrides.from ?? ZERO_ADDRESS,
    to: overrides.to ?? USER_ADDRESS,
    rawAmount: overrides.rawAmount ?? "0x1",
    amount: overrides.amount ?? "1.0",
  };
}

const mockRequest = vi.fn<(args: { method: string; params?: unknown[] }) => Promise<unknown>>();
const mockTransport = { request: mockRequest };

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// runVNetSimulation — core behaviour
// ============================================================================

describe("runVNetSimulation", () => {
  it("returns ok:true with assetChanges on successful simulation", async () => {
    mockRequest.mockResolvedValue({
      status: true,
      gasUsed: "0x5208",
      assetChanges: [
        makeAssetChange({
          contractAddress: RANDOM_TOKEN,
          from: ZERO_ADDRESS,
          to: USER_ADDRESS,
          rawAmount: "0x64",
          amount: "100.0",
          symbol: "TKN",
        }),
      ],
    });

    const res = await runVNetSimulation(mockTransport, TX_PARAMS, USER_ADDRESS);

    expect(res.ok).toBe(true);
    expect(res.result).not.toBeNull();
    expect(res.result!.success).toBe(true);
    expect(res.result!.gasUsed).toBe(0x5208);
    expect(res.result!.assetChanges.length).toBe(1);
    expect(res.result!.assetChanges[0].symbol).toBe("TKN");
    expect(res.result!.assetChanges[0].type).toBe("receive");
    expect(res.errorMessage).toBeUndefined();
  });

  it("returns ok:false with revert message when status is false", async () => {
    mockRequest.mockResolvedValue({
      status: false,
      gasUsed: "0x100",
    });

    const res = await runVNetSimulation(mockTransport, TX_PARAMS, USER_ADDRESS);

    expect(res.ok).toBe(false);
    expect(res.errorMessage).toBe("Transaction would revert");
    expect(res.result).not.toBeNull();
    expect(res.result!.success).toBe(false);
    expect(res.result!.gasUsed).toBe(0x100);
    expect(res.result!.assetChanges).toEqual([]);
  });

  it("handles RPC method not found (-32601) gracefully", async () => {
    mockRequest.mockRejectedValue({
      code: -32601,
      message: "Method not found",
    });

    const res = await runVNetSimulation(mockTransport, TX_PARAMS, USER_ADDRESS);

    expect(res.ok).toBe(false);
    expect(res.result).toBeNull();
    expect(res.errorMessage).toBe("VNet simulation not available");
  });

  it("propagates other RPC errors with the error message", async () => {
    mockRequest.mockRejectedValue({
      code: -32000,
      message: "Execution reverted: insufficient balance",
    });

    const res = await runVNetSimulation(mockTransport, TX_PARAMS, USER_ADDRESS);

    expect(res.ok).toBe(false);
    expect(res.result).toBeNull();
    expect(res.errorMessage).toBe("Execution reverted: insufficient balance");
  });
});

// ============================================================================
// processVNetAssetChanges — tested indirectly via runVNetSimulation
// ============================================================================

describe("processVNetAssetChanges (via runVNetSimulation)", () => {
  /** Helper that wraps asset changes in a successful VNet response and runs the simulation. */
  async function simulateWithAssetChanges(changes: ReturnType<typeof makeAssetChange>[]) {
    mockRequest.mockResolvedValue({
      status: true,
      gasUsed: "0x0",
      assetChanges: changes,
    });
    return runVNetSimulation(mockTransport, TX_PARAMS, USER_ADDRESS);
  }

  it("classifies crvUSD sent to controller as 'repay'", async () => {
    const res = await simulateWithAssetChanges([
      makeAssetChange({
        contractAddress: CRVUSD,
        symbol: "crvUSD",
        from: USER_ADDRESS,
        to: CONTROLLER_ADDRESS,
      }),
    ]);

    expect(res.result!.assetChanges).toHaveLength(1);
    expect(res.result!.assetChanges[0].type).toBe("repay");
    expect(res.result!.assetChanges[0].symbol).toBe("crvUSD");
  });

  it("classifies crvUSD from controller as 'borrow'", async () => {
    const res = await simulateWithAssetChanges([
      makeAssetChange({
        contractAddress: CRVUSD,
        symbol: "crvUSD",
        from: CONTROLLER_ADDRESS,
        to: USER_ADDRESS,
      }),
    ]);

    expect(res.result!.assetChanges).toHaveLength(1);
    expect(res.result!.assetChanges[0].type).toBe("borrow");
  });

  it("classifies crvUSD minted (from=0x0) as 'borrow'", async () => {
    const res = await simulateWithAssetChanges([
      makeAssetChange({
        contractAddress: CRVUSD,
        symbol: "crvUSD",
        from: ZERO_ADDRESS,
        to: USER_ADDRESS,
      }),
    ]);

    expect(res.result!.assetChanges).toHaveLength(1);
    expect(res.result!.assetChanges[0].type).toBe("borrow");
  });

  it("classifies vault collateral token sent by user as 'deposit'", async () => {
    const res = await simulateWithAssetChanges([
      makeAssetChange({
        contractAddress: VAULT_COLLATERAL,
        symbol: "VAULT",
        from: USER_ADDRESS,
        to: "0xSomeAMMAddress",
      }),
    ]);

    expect(res.result!.assetChanges).toHaveLength(1);
    expect(res.result!.assetChanges[0].type).toBe("deposit");
  });

  it("classifies vault collateral token received by user as 'receive'", async () => {
    const res = await simulateWithAssetChanges([
      makeAssetChange({
        contractAddress: VAULT_COLLATERAL,
        symbol: "VAULT",
        from: "0xSomeAMMAddress",
        to: USER_ADDRESS,
      }),
    ]);

    expect(res.result!.assetChanges).toHaveLength(1);
    expect(res.result!.assetChanges[0].type).toBe("receive");
  });

  it("classifies regular token sent by user as 'send'", async () => {
    const res = await simulateWithAssetChanges([
      makeAssetChange({
        contractAddress: RANDOM_TOKEN,
        symbol: "RND",
        from: USER_ADDRESS,
        to: "0xRecipient",
      }),
    ]);

    expect(res.result!.assetChanges).toHaveLength(1);
    expect(res.result!.assetChanges[0].type).toBe("send");
  });

  it("classifies regular token received by user as 'receive'", async () => {
    const res = await simulateWithAssetChanges([
      makeAssetChange({
        contractAddress: RANDOM_TOKEN,
        symbol: "RND",
        from: "0xSender",
        to: USER_ADDRESS,
      }),
    ]);

    expect(res.result!.assetChanges).toHaveLength(1);
    expect(res.result!.assetChanges[0].type).toBe("receive");
  });

  it("filters out transfers not involving user", async () => {
    const res = await simulateWithAssetChanges([
      makeAssetChange({
        contractAddress: RANDOM_TOKEN,
        from: "0xAlice",
        to: "0xBob",
      }),
    ]);

    expect(res.result!.assetChanges).toHaveLength(0);
  });

  it("returns empty array for empty assetChanges", async () => {
    const res = await simulateWithAssetChanges([]);

    expect(res.result!.assetChanges).toEqual([]);
  });

  it("returns empty array when assetChanges is undefined", async () => {
    mockRequest.mockResolvedValue({
      status: true,
      gasUsed: "0x0",
      // no assetChanges field
    });

    const res = await runVNetSimulation(mockTransport, TX_PARAMS, USER_ADDRESS);

    expect(res.result!.assetChanges).toEqual([]);
  });

  it("converts hex rawAmount to decimal string (0xa -> '10')", async () => {
    const res = await simulateWithAssetChanges([
      makeAssetChange({
        contractAddress: RANDOM_TOKEN,
        from: "0xSender",
        to: USER_ADDRESS,
        rawAmount: "0xa",
        amount: "10.0",
      }),
    ]);

    expect(res.result!.assetChanges).toHaveLength(1);
    expect(res.result!.assetChanges[0].rawAmount).toBe("10");
  });
});
