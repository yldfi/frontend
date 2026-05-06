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

  beforeEach(() => {
    vi.clearAllMocks();
    currentBlock = 100n;
    refetchBalances = vi.fn();

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
      { preferOnchain: true, includeWalletTokens: true },
    );
  });

  it("refetches balances when opened and on new blocks while open", async () => {
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

    currentBlock = 101n;
    rerender(
      <TokenSelector
        selectedToken={tokens[0]}
        onSelect={vi.fn()}
        preferOnchainBalances
      />,
    );

    await waitFor(() => {
      expect(refetchBalances).toHaveBeenCalledTimes(2);
    });
  });
});
