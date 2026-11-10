import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useAccount, usePublicClient } from "wagmi";

import { useUniversalZap } from "@/hooks/useUniversalZap";
import { TOKENS } from "@/config/vaults";
import type { EnsoToken } from "@/types/enso";

// The global setup mocks @tanstack/react-query with a no-op useQuery. Restore the
// real implementation so useUniversalZap's queryFn actually executes.
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual };
});

vi.mock("@/hooks/useVaultCache", () => ({
  useVaultCache: vi.fn(() => ({ data: undefined })),
}));

// Keep the real enso helpers but stub the network price fetch.
vi.mock("@/lib/enso", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/enso")>();
  return {
    ...actual,
    fetchTokenPrices: vi.fn(async (addresses: string[]) =>
      addresses.map((address) => ({ address, price: 2.0 })),
    ),
  };
});

const USER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as `0x${string}`;
const YSCVX = "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e" as `0x${string}`;

const CVX_TOKEN: EnsoToken = {
  address: TOKENS.CVX,
  chainId: 1,
  symbol: "CVX",
  name: "Convex",
  decimals: 18,
  type: "base",
};

const YSCVX_TOKEN: EnsoToken = {
  address: YSCVX,
  chainId: 1,
  symbol: "ysCVX",
  name: "ysCVX",
  decimals: 18,
  type: "defi",
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("CVX → ysCVX direct vault deposit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAccount).mockReturnValue({
      address: USER,
      isConnected: true,
    } as unknown as ReturnType<typeof useAccount>);
    vi.mocked(usePublicClient).mockReturnValue({
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "previewDeposit") return BigInt("999600000000000000");
        if (functionName === "convertToAssets") return BigInt("999600000000000000");
        return 0n;
      }),
    } as unknown as ReturnType<typeof usePublicClient>);
  });

  it("resolves CVX -> yscvx as a direct vault deposit", async () => {
    const { result } = renderHook(
      () =>
        useUniversalZap({
          inputToken: CVX_TOKEN,
          outputToken: YSCVX_TOKEN,
          inputAmount: "1",
          slippage: "50",
        }),
      { wrapper },
    );

    await waitFor(
      () => expect(result.current.quote || result.current.error).toBeTruthy(),
      { timeout: 4000 },
    );

    const quote = result.current.quote;
    expect(quote).toBeTruthy();
    expect(quote!.directVault?.action).toBe("deposit");
    expect(quote!.directVault?.vaultAddress.toLowerCase()).toBe(YSCVX.toLowerCase());
    expect(quote!.route).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  // Regression (6 Nov): the /zap "Value" row showed shares × CVX price, so
  // 13.01 CVX → 10.03 ysCVX read ~$18.75 while the simulation showed ~$24.32.
  describe("USD values use assets-per-share", () => {
    const PPS = 1.3;
    beforeEach(() => {
      vi.mocked(usePublicClient).mockReturnValue({
        readContract: vi.fn(async ({ functionName, args }: { functionName: string; args: [bigint] }) => {
          const amount = Number(args[0]) / 1e18;
          if (functionName === "previewDeposit") return BigInt(Math.round((amount / PPS) * 1e18));
          if (functionName === "previewRedeem") return BigInt(Math.round(amount * PPS * 1e18));
          if (functionName === "convertToAssets") return BigInt(Math.round(PPS * 1e18));
          return 0n;
        }),
      } as unknown as ReturnType<typeof usePublicClient>);
    });

    async function quoteFor(inputToken: EnsoToken, outputToken: EnsoToken, inputAmount: string) {
      const { result } = renderHook(
        () => useUniversalZap({ inputToken, outputToken, inputAmount, slippage: "50" }),
        { wrapper },
      );
      await waitFor(
        () => expect(result.current.quote || result.current.error).toBeTruthy(),
        { timeout: 4000 },
      );
      expect(result.current.error).toBeNull();
      return result.current.quote!;
    }

    it("deposit: output shares are valued at NAV, matching the input", async () => {
      const quote = await quoteFor(CVX_TOKEN, YSCVX_TOKEN, "13");
      expect(quote.directVault?.action).toBe("deposit");
      expect(quote.inputUsdValue).toBeCloseTo(26, 6);
      expect(quote.outputUsdValue).toBeCloseTo(26, 6);
      expect(quote.priceImpact).toBeNull();
    });

    it("withdraw: input shares are valued at NAV, matching the output", async () => {
      const quote = await quoteFor(YSCVX_TOKEN, CVX_TOKEN, "10");
      expect(quote.directVault?.action).toBe("withdraw");
      expect(quote.inputUsdValue).toBeCloseTo(26, 6);
      expect(quote.outputUsdValue).toBeCloseTo(26, 6);
      expect(quote.priceImpact).toBeNull();
    });
  });
});
