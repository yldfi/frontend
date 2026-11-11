import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useAccount, usePublicClient } from "wagmi";

import { useUniversalZap } from "@/hooks/useUniversalZap";
import {
  fetchAnyFromBeefyRoute,
  fetchAnyFromErc4626ExternalVaultRoute,
  fetchAnyFromLpxCvxRoute,
  fetchAnyFromPxCvxRoute,
  fetchAnyFromUCrvRoute,
  fetchAnyFromUCvxRoute,
  fetchAnyToExternalVaultRoute,
  fetchAnyToLpxCvxRoute,
  fetchAnyToPxCvxRoute,
  fetchExternalVaultZapInRoute,
  fetchLegacyMorphoWrapRoute,
  fetchLegacyMorphoZapInRoute,
  fetchLpxCvxZapInRoute,
  fetchPxCvxTokenZapInRoute,
  fetchPxCvxZapInRoute,
  fetchPxCvxZapOutRoute,
  fetchRoute,
  fetchSpecialTokenToExternalVaultRoute,
  fetchSpecialTokenToIlliquidRoute,
  fetchVaultToVaultRoute,
  fetchYldVaultToExternalVaultRoute,
  fetchYldVaultToIlliquidRoute,
  fetchZapInRoute,
  fetchZapOutRoute,
} from "@/lib/enso";
import { TOKENS, VAULT_ADDRESSES } from "@/config/vaults";
import { USDC_ADDRESS, YVUSDC1_ADDRESS } from "@/config/addresses";
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
  // The dispatcher calls exactly one builder per (input, output) pair. Every
  // builder rejects so the hook settles on `error` as soon as the chosen one
  // runs — the assertions only care about which builder was called.
  const notStubbed = () => vi.fn(async () => {
    throw new Error("builder not stubbed");
  });
  return {
    ...actual,
    fetchTokenPrices: vi.fn(async (addresses: string[]) =>
      addresses.map((address) => ({ address, price: 1 })),
    ),
    fetchQuote: notStubbed(),
    fetchDynamicInputEstimate: notStubbed(),
    fetchRoute: notStubbed(),
    fetchZapInRoute: notStubbed(),
    fetchZapOutRoute: notStubbed(),
    fetchVaultToVaultRoute: notStubbed(),
    fetchYldVaultToExternalVaultRoute: notStubbed(),
    fetchYldVaultToIlliquidRoute: notStubbed(),
    fetchPxCvxZapInRoute: notStubbed(),
    fetchPxCvxZapOutRoute: notStubbed(),
    fetchExternalVaultZapInRoute: notStubbed(),
    fetchLpxCvxZapInRoute: notStubbed(),
    fetchPxCvxTokenZapInRoute: notStubbed(),
    fetchAnyToPxCvxRoute: notStubbed(),
    fetchAnyToLpxCvxRoute: notStubbed(),
    fetchAnyToExternalVaultRoute: notStubbed(),
    fetchAnyFromPxCvxRoute: notStubbed(),
    fetchAnyFromLpxCvxRoute: notStubbed(),
    fetchAnyFromUCvxRoute: notStubbed(),
    fetchAnyFromErc4626ExternalVaultRoute: notStubbed(),
    fetchAnyFromUCrvRoute: notStubbed(),
    fetchAnyFromBeefyRoute: notStubbed(),
    fetchSpecialTokenToIlliquidRoute: notStubbed(),
    fetchSpecialTokenToExternalVaultRoute: notStubbed(),
    fetchLegacyMorphoWrapRoute: notStubbed(),
    fetchLegacyMorphoZapInRoute: notStubbed(),
  };
});

const USER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as `0x${string}`;
const PPS = 1.137657847235088;

function token(
  address: string,
  symbol: string,
  decimals: number,
  type: EnsoToken["type"] = "base",
): EnsoToken {
  return { address, chainId: 1, symbol, name: symbol, decimals, type };
}

const USDC = token(USDC_ADDRESS, "USDC", 6);
const CVX = token(TOKENS.CVX, "CVX", 18);
const CVXCRV = token(TOKENS.CVXCRV, "cvxCRV", 18);
const PXCVX = token(TOKENS.PXCVX, "pxCVX", 18);
const YVUSDC1 = token(YVUSDC1_ADDRESS, "yvUSDC-1", 6, "defi");
const YSCVXCRV = token(VAULT_ADDRESSES.YSCVXCRV, "yscvxCRV", 18, "defi");
const YSCVX = token(VAULT_ADDRESSES.YSCVX, "ysCVX", 18, "defi");

/** Every route builder the dispatcher can reach; each one is stubbed to reject. */
const BUILDERS = {
  fetchRoute: vi.mocked(fetchRoute),
  fetchZapInRoute: vi.mocked(fetchZapInRoute),
  fetchZapOutRoute: vi.mocked(fetchZapOutRoute),
  fetchVaultToVaultRoute: vi.mocked(fetchVaultToVaultRoute),
  fetchYldVaultToExternalVaultRoute: vi.mocked(fetchYldVaultToExternalVaultRoute),
  fetchYldVaultToIlliquidRoute: vi.mocked(fetchYldVaultToIlliquidRoute),
  fetchPxCvxZapInRoute: vi.mocked(fetchPxCvxZapInRoute),
  fetchPxCvxZapOutRoute: vi.mocked(fetchPxCvxZapOutRoute),
  fetchExternalVaultZapInRoute: vi.mocked(fetchExternalVaultZapInRoute),
  fetchLpxCvxZapInRoute: vi.mocked(fetchLpxCvxZapInRoute),
  fetchPxCvxTokenZapInRoute: vi.mocked(fetchPxCvxTokenZapInRoute),
  fetchAnyToPxCvxRoute: vi.mocked(fetchAnyToPxCvxRoute),
  fetchAnyToLpxCvxRoute: vi.mocked(fetchAnyToLpxCvxRoute),
  fetchAnyToExternalVaultRoute: vi.mocked(fetchAnyToExternalVaultRoute),
  fetchAnyFromPxCvxRoute: vi.mocked(fetchAnyFromPxCvxRoute),
  fetchAnyFromLpxCvxRoute: vi.mocked(fetchAnyFromLpxCvxRoute),
  fetchAnyFromUCvxRoute: vi.mocked(fetchAnyFromUCvxRoute),
  fetchAnyFromErc4626ExternalVaultRoute: vi.mocked(fetchAnyFromErc4626ExternalVaultRoute),
  fetchAnyFromUCrvRoute: vi.mocked(fetchAnyFromUCrvRoute),
  fetchAnyFromBeefyRoute: vi.mocked(fetchAnyFromBeefyRoute),
  fetchSpecialTokenToIlliquidRoute: vi.mocked(fetchSpecialTokenToIlliquidRoute),
  fetchSpecialTokenToExternalVaultRoute: vi.mocked(fetchSpecialTokenToExternalVaultRoute),
  fetchLegacyMorphoWrapRoute: vi.mocked(fetchLegacyMorphoWrapRoute),
  fetchLegacyMorphoZapInRoute: vi.mocked(fetchLegacyMorphoZapInRoute),
};

function expectOnlyBuilder(name: keyof typeof BUILDERS) {
  expect(BUILDERS[name], `${name} should have been called`).toHaveBeenCalled();
  for (const [otherName, mock] of Object.entries(BUILDERS)) {
    if (otherName === name) continue;
    expect(mock, `${otherName} should not have been called`).not.toHaveBeenCalled();
  }
}

function expectNoBuilder() {
  for (const [name, mock] of Object.entries(BUILDERS)) {
    expect(mock, `${name} should not have been called`).not.toHaveBeenCalled();
  }
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

async function runQuote(inputToken: EnsoToken, outputToken: EnsoToken, inputAmount: string) {
  const { result } = renderHook(
    () => useUniversalZap({ inputToken, outputToken, inputAmount, slippage: "50" }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.quote || result.current.error).toBeTruthy(), { timeout: 8000 });
  return result.current;
}

describe("useUniversalZap dispatch table", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAccount).mockReturnValue({ address: USER, isConnected: true } as unknown as ReturnType<typeof useAccount>);
    vi.mocked(usePublicClient).mockReturnValue({
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === "convertToAssets" ? BigInt(Math.round(PPS * 1e18)) : 0n,
      ),
    } as unknown as ReturnType<typeof usePublicClient>);
  });

  it("external ERC-4626 vault share → yld vault uses the external vault zap-in builder", async () => {
    await runQuote(YVUSDC1, YSCVXCRV, "177.73088");
    expectOnlyBuilder("fetchExternalVaultZapInRoute");
  });

  it("yld vault → plain token uses the zap-out builder", async () => {
    await runQuote(YSCVXCRV, USDC, "100");
    expectOnlyBuilder("fetchZapOutRoute");
  });

  it("plain token → yld vault uses the zap-in builder", async () => {
    await runQuote(USDC, YSCVXCRV, "100");
    expectOnlyBuilder("fetchZapInRoute");
  });

  it("yld vault → yld vault uses the vault-to-vault builder", async () => {
    await runQuote(YSCVXCRV, YSCVX, "1000");
    expectOnlyBuilder("fetchVaultToVaultRoute");
  });

  it("plain token → plain token uses the Enso route builder", async () => {
    await runQuote(USDC, CVX, "100");
    expectOnlyBuilder("fetchRoute");
  });

  it("plain token → pxCVX uses the pxCVX output builder", async () => {
    await runQuote(USDC, PXCVX, "100");
    expectOnlyBuilder("fetchAnyToPxCvxRoute");
  });

  it("pxCVX → plain token uses the pxCVX input builder", async () => {
    await runQuote(PXCVX, USDC, "100");
    expectOnlyBuilder("fetchAnyFromPxCvxRoute");
  });

  it("vault underlying → its own vault is a direct deposit with no builder", async () => {
    await runQuote(CVXCRV, YSCVXCRV, "100");
    expectNoBuilder();
  });
});
