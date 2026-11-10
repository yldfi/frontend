import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useAccount, usePublicClient } from "wagmi";

import { useUniversalZap } from "@/hooks/useUniversalZap";
import { fetchAnyFromErc4626ExternalVaultRoute, fetchAnyFromUCrvRoute, fetchQuote, fetchZapOutRoute } from "@/lib/enso";
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
    fetchTokenPrices: vi.fn(async (addresses: string[]) => addresses.map((address) => ({ address, price: 1 }))),
    fetchZapOutRoute: vi.fn(),
    fetchAnyFromErc4626ExternalVaultRoute: vi.fn(),
    fetchAnyFromUCrvRoute: vi.fn(),
    previewUCrvWithdraw: vi.fn(async (amount: string) => amount),
    fetchQuote: vi.fn(),
  };
});

const USER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as `0x${string}`;
const YSCVXCRV = "0xCa960E6DF1150100586c51382f619efCCcF72706";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const YSCVXCRV_TOKEN: EnsoToken = { address: YSCVXCRV, chainId: 1, symbol: "yscvxCRV", name: "yscvxCRV", decimals: 18, type: "defi" };
const USDC_TOKEN: EnsoToken = { address: USDC, chainId: 1, symbol: "USDC", name: "USD Coin", decimals: 6, type: "base" };

// 100 yscvxCRV at pps 1 → 100 cvxCRV ($100 at $1); the bundle delivers 60 USDC → 40% impact.
function zapOutBundle(usdcOut: number) {
  return {
    tx: { to: "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf", data: "0x", value: "0", from: USER },
    gas: "500000",
    amountsOut: { [USDC.toLowerCase()]: String(usdcOut * 1e6) },
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

async function runZapOut() {
  const { result } = renderHook(
    () => useUniversalZap({ inputToken: YSCVXCRV_TOKEN, outputToken: USDC_TOKEN, inputAmount: "100", slippage: "50" }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.quote || result.current.error).toBeTruthy(), { timeout: 8000 });
  return result.current;
}

describe("zap-out: high-impact bundles are checked against a standalone quote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAccount).mockReturnValue({ address: USER, isConnected: true } as unknown as ReturnType<typeof useAccount>);
    vi.mocked(usePublicClient).mockReturnValue({
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === "convertToAssets" ? 10n ** 18n : 0n,
      ),
    } as unknown as ReturnType<typeof usePublicClient>);
  });

  it("refuses the bundle when the standalone leg gives far more (bad quote)", async () => {
    vi.mocked(fetchZapOutRoute).mockResolvedValue(zapOutBundle(60) as never);
    vi.mocked(fetchQuote).mockResolvedValue({ amountOut: String(99 * 1e6), route: [] });

    const { quote, error } = await runZapOut();
    expect(quote).toBeFalsy();
    expect(error?.message).toContain(ROUTE_QUOTE_SHORTFALL_MESSAGE_PREFIX);
    expect(vi.mocked(fetchQuote)).toHaveBeenCalledWith(expect.objectContaining({
      tokenIn: expect.stringMatching(/^0x62b9c7356a2dc64a1969e19c23e4f579f9810aa7$/i), // cvxCRV
      tokenOut: USDC,
      amountIn: (100n * 10n ** 18n).toString(),
    }));
  });

  it("keeps the quote (CONFIRM still applies) when the market really is that bad", async () => {
    vi.mocked(fetchZapOutRoute).mockResolvedValue(zapOutBundle(60) as never);
    vi.mocked(fetchQuote).mockResolvedValue({ amountOut: String(61 * 1e6), route: [] });

    const { quote, error } = await runZapOut();
    expect(error).toBeNull();
    expect(quote!.priceImpact).toBeCloseTo(40, 6);
    expect(vi.mocked(fetchQuote)).toHaveBeenCalledTimes(1);
  });

  it("makes no extra Enso call when the impact is below the CONFIRM threshold", async () => {
    vi.mocked(fetchZapOutRoute).mockResolvedValue(zapOutBundle(98) as never);

    const { quote, error } = await runZapOut();
    expect(error).toBeNull();
    expect(quote).toBeTruthy();
    expect(vi.mocked(fetchQuote)).not.toHaveBeenCalled();
  });

  it("fails open when the standalone quote errors", async () => {
    vi.mocked(fetchZapOutRoute).mockResolvedValue(zapOutBundle(60) as never);
    vi.mocked(fetchQuote).mockRejectedValue(new Error("quoter down"));

    const { quote, error } = await runZapOut();
    expect(error).toBeNull();
    expect(quote!.priceImpact).toBeCloseTo(40, 6);
  });
});

describe("outside vault → token: same check on the redeem → route leg", () => {
  const YVUSDC1 = "0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204";
  const CVXCRV = "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7";
  const YVUSDC1_TOKEN: EnsoToken = { address: YVUSDC1, chainId: 1, symbol: "yvUSDC-1", name: "yvUSDC-1", decimals: 6, type: "defi" };
  const CVXCRV_TOKEN: EnsoToken = { address: CVXCRV, chainId: 1, symbol: "cvxCRV", name: "cvxCRV", decimals: 18, type: "base" };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAccount).mockReturnValue({ address: USER, isConnected: true } as unknown as ReturnType<typeof useAccount>);
    vi.mocked(usePublicClient).mockReturnValue({
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === "convertToAssets" ? 10n ** 18n : 0n,
      ),
    } as unknown as ReturnType<typeof usePublicClient>);
  });

  it("refuses a bundle far below the standalone USDC → cvxCRV quote", async () => {
    // 100 yvUSDC-1 → 100 USDC ($100); bundle 60 cvxCRV ($60, 40% impact); standalone 99 cvxCRV.
    vi.mocked(fetchAnyFromErc4626ExternalVaultRoute).mockResolvedValue({
      tx: { to: "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf", data: "0x", value: "0", from: USER },
      gas: "500000",
      amountsOut: { [CVXCRV.toLowerCase()]: (60n * 10n ** 18n).toString() },
    } as never);
    vi.mocked(fetchQuote).mockResolvedValue({ amountOut: (99n * 10n ** 18n).toString(), route: [] });

    const { result } = renderHook(
      () => useUniversalZap({ inputToken: YVUSDC1_TOKEN, outputToken: CVXCRV_TOKEN, inputAmount: "100", slippage: "50" }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.quote || result.current.error).toBeTruthy(), { timeout: 8000 });
    expect(result.current.error?.message).toContain(ROUTE_QUOTE_SHORTFALL_MESSAGE_PREFIX);
    expect(vi.mocked(fetchQuote)).toHaveBeenCalledWith(expect.objectContaining({
      tokenIn: expect.stringMatching(/^0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48$/i), // USDC
      amountIn: "100000000", // 100 USDC at 6 decimals
    }));
  });

  it("skips the check for uCRV (skipQuote builder: its output already is the standalone estimate)", async () => {
    const UCRV = "0xde2bEF0A01845257b4aEf2A2EAa48f6EAeAfa8B7";
    const UCRV_TOKEN: EnsoToken = { address: UCRV, chainId: 1, symbol: "uCRV", name: "uCRV", decimals: 18, type: "defi" };
    vi.mocked(fetchAnyFromUCrvRoute).mockResolvedValue({
      tx: { to: "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf", data: "0x", value: "0", from: USER },
      gas: "500000",
      amountsOut: { [CVXCRV.toLowerCase()]: (60n * 10n ** 18n).toString() },
    } as never);

    const { result } = renderHook(
      () => useUniversalZap({ inputToken: UCRV_TOKEN, outputToken: CVXCRV_TOKEN, inputAmount: "100", slippage: "50" }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.quote || result.current.error).toBeTruthy(), { timeout: 8000 });
    expect(vi.mocked(fetchAnyFromUCrvRoute)).toHaveBeenCalled();
    expect(result.current.quote).toBeTruthy();
    expect(vi.mocked(fetchQuote)).not.toHaveBeenCalled();
  });
});
