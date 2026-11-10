import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useAccount, usePublicClient } from "wagmi";

import { useUniversalZap } from "@/hooks/useUniversalZap";
import { fetchExternalVaultZapInRoute, fetchVaultToVaultRoute } from "@/lib/enso";
import { ROUTE_QUOTE_SHORTFALL_MESSAGE_PREFIX } from "@/lib/price-impact";
import type { EnsoToken } from "@/types/enso";

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual };
});

vi.mock("@/hooks/useVaultCache", () => ({
  useVaultCache: vi.fn(() => ({ data: undefined })),
}));

vi.mock("@/lib/enso", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/enso")>();
  return {
    ...actual,
    fetchTokenPrices: vi.fn(async (addresses: string[]) =>
      addresses.map((address) => ({ address, price: 1 })),
    ),
    fetchExternalVaultZapInRoute: vi.fn(),
    fetchVaultToVaultRoute: vi.fn(),
  };
});

const USER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as `0x${string}`;
const YVUSDC1 = "0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204";
const YSCVXCRV = "0xCa960E6DF1150100586c51382f619efCCcF72706";
const PPS = 1.137657847235088;

const YVUSDC1_TOKEN: EnsoToken = { address: YVUSDC1, chainId: 1, symbol: "yvUSDC-1", name: "yvUSDC-1", decimals: 6, type: "defi" };
const YSCVXCRV_TOKEN: EnsoToken = { address: YSCVXCRV, chainId: 1, symbol: "yscvxCRV", name: "yscvxCRV", decimals: 18, type: "defi" };

function bundleWithShares(shares: string, depositEstimate: string) {
  return {
    tx: { to: "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf", data: "0x", value: "0", from: USER },
    gas: "1000000",
    amountsOut: { [YSCVXCRV.toLowerCase()]: shares },
    priceImpact: 3801,
    routeInfo: {
      steps: [
        { tokenSymbol: "yvUSDC-1", amount: "177.7308", action: "Exit", description: "yvUSDC-1 for USDC", protocol: "Yearn" },
        { tokenSymbol: "USDC", amount: "199.8261", action: "Swap", description: "USDC for cvxCRV", protocol: "Enso" },
        { tokenSymbol: "cvxCRV", amount: depositEstimate, action: "Deposit", description: "cvxCRV into yscvxCRV", protocol: "yld" },
        { tokenSymbol: "yscvxCRV", action: "Receive", description: "vault shares", protocol: "yld" },
      ],
    },
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

async function runQuote() {
  const { result } = renderHook(
    () => useUniversalZap({ inputToken: YVUSDC1_TOKEN, outputToken: YSCVXCRV_TOKEN, inputAmount: "177.73088", slippage: "50" }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.quote || result.current.error).toBeTruthy(), { timeout: 8000 });
  return result.current;
}

describe("external vault → yld vault zap: bundle shortfall guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAccount).mockReturnValue({ address: USER, isConnected: true } as unknown as ReturnType<typeof useAccount>);
    vi.mocked(usePublicClient).mockReturnValue({
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === "convertToAssets" ? BigInt(Math.round(PPS * 1e18)) : 0n,
      ),
    } as unknown as ReturnType<typeof usePublicClient>);
  });

  it("refuses the 5 Nov quote: 1,095.65 shares against a 2,028 cvxCRV route estimate", async () => {
    vi.mocked(fetchExternalVaultZapInRoute).mockResolvedValue(
      bundleWithShares("1095652400000000000000", "2,028.2231") as never,
    );
    const { quote, error } = await runQuote();
    expect(quote).toBeFalsy();
    expect(error?.message).toContain(ROUTE_QUOTE_SHORTFALL_MESSAGE_PREFIX);
  });

  it("refuses an explicit zero share output", async () => {
    vi.mocked(fetchExternalVaultZapInRoute).mockResolvedValue(bundleWithShares("0", "2,028.2231") as never);
    const { quote, error } = await runQuote();
    expect(quote).toBeFalsy();
    expect(error?.message).toContain(ROUTE_QUOTE_SHORTFALL_MESSAGE_PREFIX);
  });

  it("skips the check when the bundle has no amountsOut entry for the vault", async () => {
    vi.mocked(fetchExternalVaultZapInRoute).mockResolvedValue({
      ...bundleWithShares("0", "2,028.2231"),
      amountsOut: {},
    } as never);
    const { error } = await runQuote();
    expect(error?.message ?? "").not.toContain(ROUTE_QUOTE_SHORTFALL_MESSAGE_PREFIX);
  });

  it("returns a quote that matches its route estimate", async () => {
    vi.mocked(fetchExternalVaultZapInRoute).mockResolvedValue(
      bundleWithShares("1777000000000000000000", "2,028.2231") as never,
    );
    const { quote, error } = await runQuote();
    expect(error).toBeNull();
    expect(Number(quote!.outputAmountFormatted)).toBeCloseTo(1777, 6);
  });
});

describe("yld vault → yld vault zap: bundle shortfall guard", () => {
  const YSCVX = "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e";
  const YSCVX_TOKEN: EnsoToken = { address: YSCVX, chainId: 1, symbol: "ysCVX", name: "ysCVX", decimals: 18, type: "defi" };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAccount).mockReturnValue({ address: USER, isConnected: true } as unknown as ReturnType<typeof useAccount>);
    vi.mocked(usePublicClient).mockReturnValue({
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === "convertToAssets" ? BigInt(Math.round(PPS * 1e18)) : 0n,
      ),
    } as unknown as ReturnType<typeof usePublicClient>);
  });

  function vaultBundle(shares: string, depositEstimate: string) {
    return {
      tx: { to: "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf", data: "0x", value: "0", from: USER },
      gas: "1000000",
      amountsOut: { [YSCVX.toLowerCase()]: shares },
      routeInfo: {
        steps: [
          { tokenSymbol: "yscvxCRV", amount: "1000", action: "Redeem", description: "yscvxCRV for cvxCRV", protocol: "yld" },
          { tokenSymbol: "cvxCRV", amount: "1,137.65", action: "Swap", description: "cvxCRV for CVX", protocol: "Enso" },
          { tokenSymbol: "CVX", amount: depositEstimate, action: "Deposit", description: "CVX into ysCVX", protocol: "yld" },
          { tokenSymbol: "ysCVX", action: "Receive", description: "vault shares", protocol: "yld" },
        ],
      },
    };
  }

  async function runVaultQuote() {
    const { result } = renderHook(
      () => useUniversalZap({ inputToken: YSCVXCRV_TOKEN, outputToken: YSCVX_TOKEN, inputAmount: "1000", slippage: "50" }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.quote || result.current.error).toBeTruthy(), { timeout: 8000 });
    return result.current;
  }

  it("refuses a bundle depositing 30% less CVX than the route estimate", async () => {
    // estimate 100 CVX; bundle 61.53 shares × pps 1.1377 ≈ 70 CVX
    vi.mocked(fetchVaultToVaultRoute).mockResolvedValue(vaultBundle("61530000000000000000", "100") as never);
    const { quote, error } = await runVaultQuote();
    expect(quote).toBeFalsy();
    expect(error?.message).toContain(ROUTE_QUOTE_SHORTFALL_MESSAGE_PREFIX);
  });

  it("accepts a bundle matching the route estimate", async () => {
    vi.mocked(fetchVaultToVaultRoute).mockResolvedValue(vaultBundle("87800000000000000000", "100") as never);
    const { quote, error } = await runVaultQuote();
    expect(error).toBeNull();
    expect(quote).toBeTruthy();
  });
});
