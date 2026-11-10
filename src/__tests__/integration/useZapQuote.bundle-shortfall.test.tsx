import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useAccount, usePublicClient } from "wagmi";

import { useUniversalZap } from "@/hooks/useUniversalZap";
import { fetchExternalVaultZapInRoute } from "@/lib/enso";
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

  it("returns a quote that matches its route estimate", async () => {
    vi.mocked(fetchExternalVaultZapInRoute).mockResolvedValue(
      bundleWithShares("1777000000000000000000", "2,028.2231") as never,
    );
    const { quote, error } = await runQuote();
    expect(error).toBeNull();
    expect(Number(quote!.outputAmountFormatted)).toBeCloseTo(1777, 6);
  });
});
