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

  it("fetches prices only while the dropdown is open", async () => {
    render(<TokenSelector selectedToken={tokens[0]} onSelect={vi.fn()} />);
    expect(mockUseTokenBalances.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ fetchPrices: false }),
    );

    fireEvent.click(screen.getByRole("button", { name: /AAA/ }));

    await waitFor(() => {
      expect(mockUseTokenBalances.mock.calls.at(-1)?.[1]).toEqual(
        expect.objectContaining({ fetchPrices: true }),
      );
    });
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

  function setTokens(nextTokens: EnsoToken[], searchQuery = "") {
    mockUseEnsoTokens.mockReturnValue({
      tokens: nextTokens,
      allTokens: nextTokens,
      searchQuery,
      setSearchQuery: vi.fn(),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      importToken: vi.fn(),
      isImported: vi.fn(() => false),
    });
    mockUseTokenBalances.mockImplementation(((input: EnsoToken[]) => ({
      sortedTokens: input,
      balanceMap: new Map(),
      priceMap: new Map(),
      refetch: refetchBalances,
      refetchOnchain,
      isLoading: false,
    })) as unknown as typeof useTokenBalances);
  }

  it("hides tokens listed in excludeTokens", () => {
    const [, bbb] = tokens;
    render(<TokenSelector selectedToken={tokens[0]} onSelect={vi.fn()} excludeTokens={[bbb.address]} />);

    fireEvent.click(screen.getByRole("button", { name: /AAA/ }));

    expect(screen.queryByRole("button", { name: /BBB Token BBB/ })).toBeNull();
    expect(screen.getByRole("button", { name: /AAA Token AAA/ })).not.toBeNull();
  });

  it("hides defi tokens when excludeDefiTokens is set, except the featured partner tokens", () => {
    const defiToken: EnsoToken = {
      address: "0x3333333333333333333333333333333333333333",
      chainId: 1,
      name: "Strategy Share",
      symbol: "STRAT",
      decimals: 18,
      type: "defi",
    };
    const scrvUsd: EnsoToken = {
      address: "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367",
      chainId: 1,
      name: "Savings crvUSD",
      symbol: "scrvUSD",
      decimals: 18,
      type: "defi",
    };
    setTokens([tokens[0], defiToken, scrvUsd]);
    render(<TokenSelector selectedToken={tokens[0]} onSelect={vi.fn()} excludeDefiTokens />);

    fireEvent.click(screen.getByRole("button", { name: /AAA/ }));

    expect(screen.queryByRole("button", { name: /STRAT Strategy Share/ })).toBeNull();
    expect(screen.getByRole("button", { name: /scrvUSD Savings crvUSD/ })).not.toBeNull();
  });

  it("ranks an exact symbol match above a token whose symbol merely contains the query", () => {
    const eth: EnsoToken = {
      address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      chainId: 1,
      name: "Ethereum",
      symbol: "ETH",
      decimals: 18,
      type: "base",
    };
    const weth: EnsoToken = {
      address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      chainId: 1,
      name: "Wrapped Ether",
      symbol: "WETH",
      decimals: 18,
      type: "base",
    };
    setTokens([weth, eth], "eth");
    render(<TokenSelector selectedToken={eth} onSelect={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /ETH/ }));

    const rows = screen.getAllByRole("button", { name: /(ETH|WETH)/ });
    const ethRow = rows.find((row) => /ETH\s*Ethereum/.test(row.textContent ?? ""))!;
    const wethRow = rows.find((row) => /WETH\s*Wrapped Ether/.test(row.textContent ?? ""))!;
    expect(ethRow.compareDocumentPosition(wethRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("formats the row balance and USD value, including dust", () => {
    const price = 2;
    mockUseTokenBalances.mockReturnValue({
      sortedTokens: tokens,
      balanceMap: new Map([
        [tokens[0].address.toLowerCase(), 1500n * 10n ** 18n],
        [tokens[1].address.toLowerCase(), 1n],
      ]),
      priceMap: new Map([
        [tokens[0].address.toLowerCase(), price],
        [tokens[1].address.toLowerCase(), price],
      ]),
      refetch: refetchBalances,
      refetchOnchain,
      isLoading: false,
    } as ReturnType<typeof useTokenBalances>);
    render(<TokenSelector selectedToken={tokens[0]} onSelect={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /AAA/ }));

    const aaa = screen.getByRole("button", { name: /AAA Token AAA/ });
    expect(aaa.textContent).toContain("1500.0000");
    expect(aaa.textContent).toMatch(/\$3[.,\s\u00a0\u202f]?000[.,]00/);

    const bbb = screen.getByRole("button", { name: /BBB Token BBB/ });
    expect(bbb.textContent).toContain("0.0000");
    expect(bbb.textContent).toContain("<$0.01");
  });

  it("shows no balance or USD value for a token the wallet does not hold", () => {
    render(<TokenSelector selectedToken={tokens[0]} onSelect={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /AAA/ }));

    const bbb = screen.getByRole("button", { name: /BBB Token BBB/ });
    expect(bbb.textContent).toBe("BBBBBToken BBB0");
    expect(bbb.textContent).not.toContain("$");
  });

  it("shows the token logo when it has one and its initials otherwise", () => {
    const withLogo: EnsoToken = { ...tokens[0], logoURI: "https://example.com/aaa.png" };
    setTokens([withLogo, tokens[1]]);
    render(<TokenSelector selectedToken={withLogo} onSelect={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /AAA/ }));

    expect(screen.getAllByAltText("AAA").some((logo) => logo.getAttribute("src") === "https://example.com/aaa.png")).toBe(true);
    expect(screen.getAllByText("BB").length).toBeGreaterThan(0);
  });

  it("shows the empty state when no tokens match", () => {
    setTokens([]);
    mockUseTokenBalances.mockReturnValue({
      sortedTokens: [],
      balanceMap: new Map(),
      priceMap: new Map(),
      refetch: refetchBalances,
      refetchOnchain,
      isLoading: false,
    } as ReturnType<typeof useTokenBalances>);
    render(<TokenSelector selectedToken={tokens[0]} onSelect={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /AAA/ }));

    expect(screen.getByText("No tokens found")).toBeTruthy();
  });

  it("reports an address that is not a known token", () => {
    const unknownAddress = "0x0000000000000000000000000000000000000009";
    setTokens([], unknownAddress);
    mockUseTokenBalances.mockReturnValue({
      sortedTokens: [],
      balanceMap: new Map(),
      priceMap: new Map(),
      refetch: refetchBalances,
      refetchOnchain,
      isLoading: false,
    } as ReturnType<typeof useTokenBalances>);
    render(<TokenSelector selectedToken={tokens[0]} onSelect={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /AAA/ }));

    expect(screen.getByText("No token found at this address")).toBeTruthy();
  });

  it("shows the loading dots while the token list is loading", () => {
    mockUseEnsoTokens.mockReturnValue({
      tokens: [],
      allTokens: [],
      searchQuery: "",
      setSearchQuery: vi.fn(),
      isLoading: true,
      error: null,
      refetch: vi.fn(),
      importToken: vi.fn(),
      isImported: vi.fn(() => false),
    });
    render(<TokenSelector selectedToken={tokens[0]} onSelect={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /AAA/ }));

    expect(screen.queryByText("No tokens found")).toBeNull();
    expect(document.querySelectorAll(".animate-bounce")).toHaveLength(3);
  });

  it("closes the dropdown when Escape is pressed", () => {
    render(<TokenSelector selectedToken={tokens[0]} onSelect={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /AAA/ }));
    expect(screen.getByRole("button", { name: /BBB Token BBB/ })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("button", { name: /BBB Token BBB/ })).toBeNull();
  });

  it("closes the dropdown from the close button", () => {
    render(<TokenSelector selectedToken={tokens[0]} onSelect={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /AAA/ }));
    fireEvent.click(screen.getByRole("button", { name: "Close token selector" }));

    expect(screen.queryByRole("button", { name: /BBB Token BBB/ })).toBeNull();
  });

  it("closes the dropdown on a click outside the modal", () => {
    render(<TokenSelector selectedToken={tokens[0]} onSelect={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /AAA/ }));
    expect(screen.getByRole("button", { name: /BBB Token BBB/ })).toBeTruthy();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("button", { name: /BBB Token BBB/ })).toBeNull();
  });

  it("selects a token and closes the dropdown", () => {
    const onSelect = vi.fn();
    render(<TokenSelector selectedToken={tokens[0]} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: /AAA/ }));
    fireEvent.click(screen.getByRole("button", { name: /BBB Token BBB/ }));

    expect(onSelect).toHaveBeenCalledWith(tokens[1]);
    expect(screen.queryByRole("button", { name: /BBB Token BBB/ })).toBeNull();
  });
});
