import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useBlockNumber } from "wagmi";

import { TokenSelector } from "@/components/TokenSelector";
import { useEnsoTokens } from "@/hooks/useEnsoTokens";
import { useTokenBalances } from "@/hooks/useTokenBalances";
import { useTokenMetadata } from "@/hooks/useTokenMetadata";
import type { EnsoToken } from "@/types/enso";

vi.mock("wagmi", () => ({
  useBlockNumber: vi.fn(),
}));

vi.mock("@/hooks/useEnsoTokens", () => ({
  useEnsoTokens: vi.fn(),
}));

vi.mock("@/hooks/useTokenMetadata", () => ({
  useTokenMetadata: vi.fn(),
}));

vi.mock("@/hooks/useTokenBalances", () => ({
  useTokenBalances: vi.fn(),
}));

const mockUseBlockNumber = vi.mocked(useBlockNumber);
const mockUseEnsoTokens = vi.mocked(useEnsoTokens);
const mockUseTokenBalances = vi.mocked(useTokenBalances);
const mockUseTokenMetadata = vi.mocked(useTokenMetadata);

describe("TokenSelector balance refresh", () => {
  const tokens: EnsoToken[] = [
    {
      address: "0x1111111111111111111111111111111111111111",
      chainId: 1,
      name: "Token AAA",
      symbol: "AAA",
      decimals: 18,
      type: "base",
    },
    {
      address: "0x2222222222222222222222222222222222222222",
      chainId: 1,
      name: "Token BBB",
      symbol: "BBB",
      decimals: 18,
      type: "base",
    },
  ];

  let currentBlock: bigint | undefined;
  let refetchBalances: ReturnType<typeof vi.fn>;
  let refetchOnchain: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    currentBlock = 100n;
    refetchBalances = vi.fn();
    refetchOnchain = vi.fn();

    mockUseBlockNumber.mockImplementation(() => ({ data: currentBlock }) as ReturnType<typeof useBlockNumber>);
    mockUseEnsoTokens.mockReturnValue({
      tokens,
      allTokens: tokens,
      searchQuery: "",
      setSearchQuery: vi.fn(),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      importToken: vi.fn(),
      isImported: vi.fn(() => false),
    });
    mockUseTokenMetadata.mockReturnValue({
      token: null,
      isLoading: false,
      error: null,
    } as ReturnType<typeof useTokenMetadata>);
    mockUseTokenBalances.mockReturnValue({
      sortedTokens: tokens,
      balanceMap: new Map([[tokens[0].address.toLowerCase(), 1n * 10n ** 18n]]),
      priceMap: new Map([[tokens[0].address.toLowerCase(), 1]]),
      refetch: refetchBalances,
      refetchOnchain,
      isLoading: false,
    } as ReturnType<typeof useTokenBalances>);
  });

  it("uses on-chain balance overlay when requested", () => {
    render(
      <TokenSelector
        selectedToken={tokens[0]}
        onSelect={vi.fn()}
        preferOnchainBalances
      />,
    );

    expect(mockUseTokenBalances).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        preferOnchain: true,
        includeWalletTokens: true,
        walletTokenAllowlist: expect.arrayContaining([
          "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        ]),
      }),
    );
    const options = mockUseTokenBalances.mock.calls.at(-1)?.[1];
    expect(options?.walletTokenAllowlist).not.toEqual(expect.arrayContaining([
      tokens[0].address.toLowerCase(),
      tokens[1].address.toLowerCase(),
    ]));
  });

  it("refetches Enso balances when opened and only on-chain balances on new blocks", async () => {
    const { rerender } = render(
      <TokenSelector
        selectedToken={tokens[0]}
        onSelect={vi.fn()}
        preferOnchainBalances
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /AAA/ }));

    await waitFor(() => {
      expect(refetchBalances).toHaveBeenCalledTimes(1);
    });
    expect(refetchOnchain).not.toHaveBeenCalled();

    currentBlock = 101n;
    rerender(
      <TokenSelector
        selectedToken={tokens[0]}
        onSelect={vi.fn()}
        preferOnchainBalances
      />,
    );

    await waitFor(() => {
      expect(refetchOnchain).toHaveBeenCalledTimes(1);
    });
    expect(refetchBalances).toHaveBeenCalledTimes(1);
  });

  it("keeps unrelated featured vaults out of token search results", () => {
    const crvUsd: EnsoToken = {
      address: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E",
      chainId: 1,
      name: "crvUSD",
      symbol: "crvUSD",
      decimals: 18,
      logoURI: "/tokens/crvusd.png",
      type: "base",
    };
    const scrvUsd: EnsoToken = {
      address: "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367",
      chainId: 1,
      name: "Savings crvUSD",
      symbol: "scrvUSD",
      decimals: 18,
      logoURI: "/tokens/scrvusd.png",
      type: "defi",
    };
    const unrelatedVault: EnsoToken = {
      address: "0xCa960E6DF1150100586c51382f619efCCcF72706",
      chainId: 1,
      name: "yld yscvxCRV",
      symbol: "yscvxCRV",
      decimals: 18,
      type: "defi",
    };

    mockUseEnsoTokens.mockReturnValue({
      tokens: [crvUsd, scrvUsd],
      allTokens: [crvUsd, scrvUsd],
      searchQuery: "crvusd",
      setSearchQuery: vi.fn(),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      importToken: vi.fn(),
      isImported: vi.fn(() => false),
    });
    mockUseTokenBalances.mockReturnValue({
      sortedTokens: [unrelatedVault, scrvUsd, crvUsd],
      balanceMap: new Map([[unrelatedVault.address.toLowerCase(), 1n * 10n ** 18n]]),
      priceMap: new Map(),
      refetch: refetchBalances,
      refetchOnchain,
      isLoading: false,
    } as ReturnType<typeof useTokenBalances>);

    render(
      <TokenSelector
        selectedToken={crvUsd}
        onSelect={vi.fn()}
        preferOnchainBalances
      />,
    );

    const balanceTokens = mockUseTokenBalances.mock.calls.at(-1)?.[0] ?? [];
    expect(balanceTokens.some((token) => token.symbol === "yscvxCRV")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /crvUSD/ }));

    expect(screen.queryByRole("button", { name: /yscvxCRV/ })).toBeNull();
    const crvUsdRow = screen.getByRole("button", { name: /crvUSD crvUSD crvUSD/ });
    const scrvUsdRow = screen.getByRole("button", { name: /scrvUSD scrvUSD Savings crvUSD/ });
    expect(crvUsdRow.compareDocumentPosition(scrvUsdRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
