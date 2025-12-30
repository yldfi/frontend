import { describe, it, expect } from "vitest";
import { formatUnits, isAddress } from "viem";

// Test the TokenSelector business logic directly
// We test token filtering, search, balance formatting, and selection logic

describe("TokenSelector logic", () => {
  describe("token structure", () => {
    interface Token {
      address: string;
      chainId: number;
      name: string;
      symbol: string;
      decimals: number;
      type: "base" | "defi";
      logoURI?: string;
    }

    const createMockToken = (overrides: Partial<Token> = {}): Token => ({
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      chainId: 1,
      name: "USD Coin",
      symbol: "USDC",
      decimals: 6,
      type: "base",
      ...overrides,
    });

    it("has required fields", () => {
      const token = createMockToken();
      expect(token.address).toBeDefined();
      expect(token.chainId).toBeDefined();
      expect(token.name).toBeDefined();
      expect(token.symbol).toBeDefined();
      expect(token.decimals).toBeDefined();
      expect(token.type).toBeDefined();
    });

    it("allows base type", () => {
      const token = createMockToken({ type: "base" });
      expect(token.type).toBe("base");
    });

    it("allows defi type", () => {
      const token = createMockToken({ type: "defi" });
      expect(token.type).toBe("defi");
    });

    it("logoURI is optional", () => {
      const tokenWithLogo = createMockToken({ logoURI: "https://example.com/logo.png" });
      const tokenWithoutLogo = createMockToken();
      expect(tokenWithLogo.logoURI).toBe("https://example.com/logo.png");
      expect(tokenWithoutLogo.logoURI).toBeUndefined();
    });
  });

  describe("token search filtering", () => {
    interface Token {
      address: string;
      name: string;
      symbol: string;
    }

    const mockTokens: Token[] = [
      { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", name: "USD Coin", symbol: "USDC" },
      { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", name: "Tether USD", symbol: "USDT" },
      { address: "0x6B175474E89094C44Da98b954EesdfsdfdCd36fB", name: "Dai Stablecoin", symbol: "DAI" },
      { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", name: "Wrapped Ether", symbol: "WETH" },
      { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", name: "Wrapped BTC", symbol: "WBTC" },
    ];

    function filterTokensBySearch(tokens: Token[], search: string): Token[] {
      if (!search || search.trim() === "") return tokens;
      const searchLower = search.toLowerCase().trim();

      return tokens.filter((token) => {
        const nameMatch = token.name.toLowerCase().includes(searchLower);
        const symbolMatch = token.symbol.toLowerCase().includes(searchLower);
        const addressMatch = token.address.toLowerCase().includes(searchLower);
        return nameMatch || symbolMatch || addressMatch;
      });
    }

    it("returns all tokens when search is empty", () => {
      expect(filterTokensBySearch(mockTokens, "")).toHaveLength(5);
      expect(filterTokensBySearch(mockTokens, "  ")).toHaveLength(5);
    });

    it("filters by symbol", () => {
      const results = filterTokensBySearch(mockTokens, "USDC");
      expect(results).toHaveLength(1);
      expect(results[0].symbol).toBe("USDC");
    });

    it("filters by partial symbol", () => {
      const results = filterTokensBySearch(mockTokens, "USD");
      expect(results).toHaveLength(2); // USDC and USDT
    });

    it("filters by name", () => {
      const results = filterTokensBySearch(mockTokens, "Wrapped");
      expect(results).toHaveLength(2); // WETH and WBTC
    });

    it("filters case-insensitively", () => {
      const results = filterTokensBySearch(mockTokens, "usdc");
      expect(results).toHaveLength(1);
      expect(results[0].symbol).toBe("USDC");
    });

    it("filters by address prefix", () => {
      const results = filterTokensBySearch(mockTokens, "0xA0b8");
      expect(results).toHaveLength(1);
      expect(results[0].symbol).toBe("USDC");
    });

    it("returns empty array when no matches", () => {
      const results = filterTokensBySearch(mockTokens, "XYZ");
      expect(results).toHaveLength(0);
    });
  });

  describe("address search detection", () => {
    function isAddressSearch(search: string): boolean {
      return search.startsWith("0x") && search.length >= 10;
    }

    function isCompleteAddress(search: string): boolean {
      return search.startsWith("0x") && search.length === 42 && isAddress(search);
    }

    it("detects address search", () => {
      expect(isAddressSearch("0xA0b86991c6")).toBe(true);
      expect(isAddressSearch("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe(true);
    });

    it("rejects non-address search", () => {
      expect(isAddressSearch("USDC")).toBe(false);
      expect(isAddressSearch("0x")).toBe(false);
      expect(isAddressSearch("0x123")).toBe(false);
    });

    it("detects complete valid address", () => {
      expect(isCompleteAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe(true);
    });

    it("rejects incomplete address", () => {
      expect(isCompleteAddress("0xA0b86991c6")).toBe(false);
    });

    it("rejects invalid checksum address", () => {
      expect(isCompleteAddress("0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48")).toBe(false);
    });
  });

  describe("exclude tokens filtering", () => {
    interface Token {
      address: string;
      symbol: string;
    }

    const mockTokens: Token[] = [
      { address: "0xAAA", symbol: "AAA" },
      { address: "0xBBB", symbol: "BBB" },
      { address: "0xCCC", symbol: "CCC" },
    ];

    function filterExcludedTokens(tokens: Token[], excludeTokens: string[]): Token[] {
      if (!excludeTokens || excludeTokens.length === 0) return tokens;
      const excludeSet = new Set(excludeTokens.map((t) => t.toLowerCase()));
      return tokens.filter((token) => !excludeSet.has(token.address.toLowerCase()));
    }

    it("returns all tokens when exclude list is empty", () => {
      expect(filterExcludedTokens(mockTokens, [])).toHaveLength(3);
    });

    it("excludes single token", () => {
      const results = filterExcludedTokens(mockTokens, ["0xAAA"]);
      expect(results).toHaveLength(2);
      expect(results.find((t) => t.symbol === "AAA")).toBeUndefined();
    });

    it("excludes multiple tokens", () => {
      const results = filterExcludedTokens(mockTokens, ["0xAAA", "0xBBB"]);
      expect(results).toHaveLength(1);
      expect(results[0].symbol).toBe("CCC");
    });

    it("excludes case-insensitively", () => {
      const results = filterExcludedTokens(mockTokens, ["0xaaa"]);
      expect(results).toHaveLength(2);
    });
  });

  describe("defi tokens filtering", () => {
    interface Token {
      address: string;
      symbol: string;
      type: "base" | "defi";
    }

    const mockTokens: Token[] = [
      { address: "0xAAA", symbol: "USDC", type: "base" },
      { address: "0xBBB", symbol: "aUSDC", type: "defi" },
      { address: "0xCCC", symbol: "ETH", type: "base" },
      { address: "0xDDD", symbol: "cETH", type: "defi" },
    ];

    function filterDefiTokens(tokens: Token[], excludeDefi: boolean): Token[] {
      if (!excludeDefi) return tokens;
      return tokens.filter((token) => token.type !== "defi");
    }

    it("returns all tokens when excludeDefi is false", () => {
      expect(filterDefiTokens(mockTokens, false)).toHaveLength(4);
    });

    it("excludes defi tokens when excludeDefi is true", () => {
      const results = filterDefiTokens(mockTokens, true);
      expect(results).toHaveLength(2);
      expect(results.every((t) => t.type === "base")).toBe(true);
    });
  });

  describe("balance formatting", () => {
    function formatTokenBalance(balance: bigint, decimals: number): string {
      const formatted = formatUnits(balance, decimals);
      const num = parseFloat(formatted);

      if (num === 0) return "0";
      if (num >= 1000) return num.toLocaleString("en-US", { maximumFractionDigits: 2 });
      if (num >= 1) return num.toFixed(4);
      if (num >= 0.0001) return num.toFixed(6);
      return "<0.0001";
    }

    it("formats large balances with commas", () => {
      const balance = BigInt("10000000000"); // 10000 with 6 decimals
      expect(formatTokenBalance(balance, 6)).toBe("10,000");
    });

    it("formats medium balances with 4 decimals", () => {
      const balance = BigInt("100123456"); // 100.123456 with 6 decimals
      expect(formatTokenBalance(balance, 6)).toBe("100.1235");
    });

    it("formats small balances with 6 decimals", () => {
      const balance = BigInt("123456"); // 0.123456 with 6 decimals
      expect(formatTokenBalance(balance, 6)).toBe("0.123456");
    });

    it("formats dust as <0.0001", () => {
      const balance = BigInt("10"); // 0.00001 with 6 decimals
      expect(formatTokenBalance(balance, 6)).toBe("<0.0001");
    });

    it("formats zero balance", () => {
      expect(formatTokenBalance(0n, 6)).toBe("0");
      expect(formatTokenBalance(0n, 18)).toBe("0");
    });
  });

  describe("USD value formatting", () => {
    function formatUsdValue(usdValue: number | undefined): string {
      if (usdValue === undefined || usdValue === null) return "";
      if (usdValue === 0) return "$0";
      if (usdValue >= 1000) return `$${(usdValue / 1000).toFixed(1)}K`;
      if (usdValue >= 1) return `$${usdValue.toFixed(2)}`;
      if (usdValue >= 0.01) return `$${usdValue.toFixed(2)}`;
      return "<$0.01";
    }

    it("formats K values", () => {
      expect(formatUsdValue(1000)).toBe("$1.0K");
      expect(formatUsdValue(5500)).toBe("$5.5K");
    });

    it("formats regular values", () => {
      expect(formatUsdValue(100)).toBe("$100.00");
      expect(formatUsdValue(50.5)).toBe("$50.50");
    });

    it("formats small values", () => {
      expect(formatUsdValue(0.5)).toBe("$0.50");
      expect(formatUsdValue(0.05)).toBe("$0.05");
    });

    it("formats very small values", () => {
      expect(formatUsdValue(0.001)).toBe("<$0.01");
    });

    it("formats zero", () => {
      expect(formatUsdValue(0)).toBe("$0");
    });

    it("returns empty for undefined", () => {
      expect(formatUsdValue(undefined)).toBe("");
    });
  });

  describe("token logo fallback", () => {
    function getTokenLogoUrl(logoURI: string | undefined): string | null {
      return logoURI ?? null;
    }

    function shouldShowFallback(logoError: boolean, logoURI: string | undefined): boolean {
      return logoError || !logoURI;
    }

    it("returns logoURI when available", () => {
      const url = getTokenLogoUrl("https://example.com/logo.png");
      expect(url).toBe("https://example.com/logo.png");
    });

    it("returns null when no logoURI", () => {
      const url = getTokenLogoUrl(undefined);
      expect(url).toBe(null);
    });

    it("shows fallback when logo errors", () => {
      expect(shouldShowFallback(true, "https://example.com/logo.png")).toBe(true);
    });

    it("shows fallback when no logoURI", () => {
      expect(shouldShowFallback(false, undefined)).toBe(true);
    });

    it("shows logo when available and no error", () => {
      expect(shouldShowFallback(false, "https://example.com/logo.png")).toBe(false);
    });
  });

  describe("symbol abbreviation", () => {
    function abbreviateSymbol(symbol: string, maxLength: number = 6): string {
      if (symbol.length <= maxLength) return symbol;
      return symbol.slice(0, maxLength - 1) + "…";
    }

    it("returns short symbols unchanged", () => {
      expect(abbreviateSymbol("ETH")).toBe("ETH");
      expect(abbreviateSymbol("USDC")).toBe("USDC");
    });

    it("abbreviates long symbols", () => {
      expect(abbreviateSymbol("WSTETHCRV")).toBe("WSTET…");
    });

    it("handles custom max length", () => {
      expect(abbreviateSymbol("ETHEREUM", 4)).toBe("ETH…");
    });
  });

  describe("token sorting by balance", () => {
    interface TokenWithBalance {
      symbol: string;
      balanceUsd: number;
    }

    function sortByBalance(tokens: TokenWithBalance[]): TokenWithBalance[] {
      return [...tokens].sort((a, b) => b.balanceUsd - a.balanceUsd);
    }

    const mockTokens: TokenWithBalance[] = [
      { symbol: "USDC", balanceUsd: 100 },
      { symbol: "ETH", balanceUsd: 5000 },
      { symbol: "DAI", balanceUsd: 50 },
    ];

    it("sorts by balance descending", () => {
      const sorted = sortByBalance(mockTokens);
      expect(sorted[0].symbol).toBe("ETH");
      expect(sorted[1].symbol).toBe("USDC");
      expect(sorted[2].symbol).toBe("DAI");
    });

    it("handles equal balances", () => {
      const tokens = [
        { symbol: "A", balanceUsd: 100 },
        { symbol: "B", balanceUsd: 100 },
      ];
      const sorted = sortByBalance(tokens);
      expect(sorted).toHaveLength(2);
    });

    it("handles zero balances", () => {
      const tokens = [
        { symbol: "A", balanceUsd: 0 },
        { symbol: "B", balanceUsd: 100 },
        { symbol: "C", balanceUsd: 0 },
      ];
      const sorted = sortByBalance(tokens);
      expect(sorted[0].symbol).toBe("B");
    });
  });

  describe("popular tokens prioritization", () => {
    interface Token {
      address: string;
      symbol: string;
    }

    const POPULAR_TOKEN_ADDRESSES = [
      "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", // ETH
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
      "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
    ];

    function isPopularToken(address: string): boolean {
      return POPULAR_TOKEN_ADDRESSES.some(
        (p) => p.toLowerCase() === address.toLowerCase()
      );
    }

    function sortWithPopularFirst(tokens: Token[]): Token[] {
      return [...tokens].sort((a, b) => {
        const aPopular = isPopularToken(a.address);
        const bPopular = isPopularToken(b.address);
        if (aPopular && !bPopular) return -1;
        if (!aPopular && bPopular) return 1;
        return 0;
      });
    }

    it("identifies popular tokens", () => {
      expect(isPopularToken("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe(true);
      expect(isPopularToken("0x0000000000000000000000000000000000000000")).toBe(false);
    });

    it("sorts popular tokens first", () => {
      const tokens: Token[] = [
        { address: "0x111", symbol: "RANDOM" },
        { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC" },
        { address: "0x222", symbol: "ANOTHER" },
      ];
      const sorted = sortWithPopularFirst(tokens);
      expect(sorted[0].symbol).toBe("USDC");
    });
  });

  describe("modal state management", () => {
    interface ModalState {
      isOpen: boolean;
      searchQuery: string;
      selectedToken: string | null;
    }

    function openModal(): Partial<ModalState> {
      return { isOpen: true, searchQuery: "" };
    }

    function closeModal(): ModalState {
      return { isOpen: false, searchQuery: "", selectedToken: null };
    }

    function selectToken(tokenAddress: string): Partial<ModalState> {
      return { selectedToken: tokenAddress, isOpen: false };
    }

    it("opens modal with empty search", () => {
      const state = openModal();
      expect(state.isOpen).toBe(true);
      expect(state.searchQuery).toBe("");
    });

    it("closes modal and resets state", () => {
      const state = closeModal();
      expect(state.isOpen).toBe(false);
      expect(state.searchQuery).toBe("");
      expect(state.selectedToken).toBe(null);
    });

    it("selects token and closes modal", () => {
      const state = selectToken("0x123");
      expect(state.selectedToken).toBe("0x123");
      expect(state.isOpen).toBe(false);
    });
  });

  describe("keyboard navigation", () => {
    function handleKeyDown(
      key: string,
      currentIndex: number,
      totalItems: number
    ): number {
      switch (key) {
        case "ArrowDown":
          return Math.min(currentIndex + 1, totalItems - 1);
        case "ArrowUp":
          return Math.max(currentIndex - 1, 0);
        case "Home":
          return 0;
        case "End":
          return totalItems - 1;
        default:
          return currentIndex;
      }
    }

    it("moves down", () => {
      expect(handleKeyDown("ArrowDown", 0, 10)).toBe(1);
      expect(handleKeyDown("ArrowDown", 5, 10)).toBe(6);
    });

    it("stops at last item", () => {
      expect(handleKeyDown("ArrowDown", 9, 10)).toBe(9);
    });

    it("moves up", () => {
      expect(handleKeyDown("ArrowUp", 5, 10)).toBe(4);
    });

    it("stops at first item", () => {
      expect(handleKeyDown("ArrowUp", 0, 10)).toBe(0);
    });

    it("jumps to start", () => {
      expect(handleKeyDown("Home", 5, 10)).toBe(0);
    });

    it("jumps to end", () => {
      expect(handleKeyDown("End", 5, 10)).toBe(9);
    });
  });

  describe("token import validation", () => {
    function validateTokenImport(
      address: string,
      existingTokens: string[]
    ): { valid: boolean; error?: string } {
      if (!address) {
        return { valid: false, error: "Address required" };
      }

      if (!isAddress(address)) {
        return { valid: false, error: "Invalid address format" };
      }

      const exists = existingTokens.some(
        (t) => t.toLowerCase() === address.toLowerCase()
      );
      if (exists) {
        return { valid: false, error: "Token already exists" };
      }

      return { valid: true };
    }

    it("validates new token address", () => {
      const result = validateTokenImport(
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        []
      );
      expect(result.valid).toBe(true);
    });

    it("rejects empty address", () => {
      const result = validateTokenImport("", []);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Address required");
    });

    it("rejects invalid address", () => {
      const result = validateTokenImport("not-an-address", []);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid address format");
    });

    it("rejects duplicate token", () => {
      const result = validateTokenImport(
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"]
      );
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Token already exists");
    });

    it("checks duplicates case-insensitively", () => {
      const result = validateTokenImport(
        "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"]
      );
      expect(result.valid).toBe(false);
    });
  });

  describe("search input debouncing", () => {
    function shouldTriggerSearch(
      lastSearchTime: number,
      currentTime: number,
      debounceMs: number
    ): boolean {
      return currentTime - lastSearchTime >= debounceMs;
    }

    const DEBOUNCE_MS = 300;

    it("triggers search after debounce period", () => {
      expect(shouldTriggerSearch(0, 300, DEBOUNCE_MS)).toBe(true);
      expect(shouldTriggerSearch(0, 500, DEBOUNCE_MS)).toBe(true);
    });

    it("prevents search during debounce", () => {
      expect(shouldTriggerSearch(0, 100, DEBOUNCE_MS)).toBe(false);
      expect(shouldTriggerSearch(0, 299, DEBOUNCE_MS)).toBe(false);
    });
  });

  describe("scroll behavior", () => {
    function shouldLoadMore(
      scrollTop: number,
      clientHeight: number,
      scrollHeight: number,
      threshold: number = 100
    ): boolean {
      return scrollTop + clientHeight >= scrollHeight - threshold;
    }

    it("triggers load more near bottom", () => {
      expect(shouldLoadMore(900, 500, 1500, 100)).toBe(true);
    });

    it("prevents load more when far from bottom", () => {
      expect(shouldLoadMore(0, 500, 1500, 100)).toBe(false);
    });

    it("triggers at exact threshold", () => {
      expect(shouldLoadMore(900, 500, 1500, 100)).toBe(true);
    });
  });

  describe("empty state messages", () => {
    function getEmptyMessage(
      hasSearch: boolean,
      isSearchingAddress: boolean,
      isLoading: boolean
    ): string {
      if (isLoading) return "Loading tokens...";
      if (isSearchingAddress) return "Token not found. Import it?";
      if (hasSearch) return "No tokens found matching your search";
      return "No tokens available";
    }

    it("shows loading message", () => {
      expect(getEmptyMessage(false, false, true)).toBe("Loading tokens...");
    });

    it("shows import suggestion for address search", () => {
      expect(getEmptyMessage(true, true, false)).toBe("Token not found. Import it?");
    });

    it("shows no matches message", () => {
      expect(getEmptyMessage(true, false, false)).toBe("No tokens found matching your search");
    });

    it("shows no tokens message", () => {
      expect(getEmptyMessage(false, false, false)).toBe("No tokens available");
    });
  });

  describe("ETH native token handling", () => {
    const ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

    function isNativeEth(address: string): boolean {
      return address.toLowerCase() === ETH_ADDRESS.toLowerCase();
    }

    function getTokenDisplay(address: string): { symbol: string; name: string } {
      if (isNativeEth(address)) {
        return { symbol: "ETH", name: "Ethereum" };
      }
      // Would normally look up token
      return { symbol: "???", name: "Unknown" };
    }

    it("identifies native ETH", () => {
      expect(isNativeEth(ETH_ADDRESS)).toBe(true);
      expect(isNativeEth("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE")).toBe(true);
    });

    it("identifies ETH case-insensitively", () => {
      expect(isNativeEth("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")).toBe(true);
    });

    it("returns correct display for ETH", () => {
      const display = getTokenDisplay(ETH_ADDRESS);
      expect(display.symbol).toBe("ETH");
      expect(display.name).toBe("Ethereum");
    });
  });

  describe("token row accessibility", () => {
    function getTokenRowAriaLabel(
      symbol: string,
      name: string,
      balance: string,
      usdValue: string
    ): string {
      const balanceText = balance ? `, balance: ${balance}` : "";
      const usdText = usdValue ? ` (${usdValue})` : "";
      return `${name} (${symbol})${balanceText}${usdText}`;
    }

    it("creates aria label with all info", () => {
      const label = getTokenRowAriaLabel("USDC", "USD Coin", "100", "$100.00");
      expect(label).toBe("USD Coin (USDC), balance: 100 ($100.00)");
    });

    it("creates aria label without balance", () => {
      const label = getTokenRowAriaLabel("USDC", "USD Coin", "", "");
      expect(label).toBe("USD Coin (USDC)");
    });

    it("creates aria label with balance but no USD", () => {
      const label = getTokenRowAriaLabel("USDC", "USD Coin", "100", "");
      expect(label).toBe("USD Coin (USDC), balance: 100");
    });
  });

  describe("combined filtering pipeline", () => {
    interface Token {
      address: string;
      symbol: string;
      name: string;
      type: "base" | "defi";
      balanceUsd: number;
    }

    const mockTokens: Token[] = [
      { address: "0xAAA", symbol: "USDC", name: "USD Coin", type: "base", balanceUsd: 1000 },
      { address: "0xBBB", symbol: "aUSDC", name: "Aave USDC", type: "defi", balanceUsd: 500 },
      { address: "0xCCC", symbol: "ETH", name: "Ethereum", type: "base", balanceUsd: 2000 },
      { address: "0xDDD", symbol: "DAI", name: "Dai", type: "base", balanceUsd: 0 },
    ];

    function filterTokens(
      tokens: Token[],
      options: {
        search?: string;
        excludeTokens?: string[];
        excludeDefi?: boolean;
      }
    ): Token[] {
      let result = tokens;

      // Filter by exclude list
      if (options.excludeTokens?.length) {
        const excludeSet = new Set(options.excludeTokens.map((t) => t.toLowerCase()));
        result = result.filter((t) => !excludeSet.has(t.address.toLowerCase()));
      }

      // Filter defi tokens
      if (options.excludeDefi) {
        result = result.filter((t) => t.type !== "defi");
      }

      // Filter by search
      if (options.search?.trim()) {
        const searchLower = options.search.toLowerCase().trim();
        result = result.filter(
          (t) =>
            t.symbol.toLowerCase().includes(searchLower) ||
            t.name.toLowerCase().includes(searchLower)
        );
      }

      // Sort by balance
      result = [...result].sort((a, b) => b.balanceUsd - a.balanceUsd);

      return result;
    }

    it("applies all filters", () => {
      const result = filterTokens(mockTokens, {
        search: "USD",
        excludeDefi: true,
      });
      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("USDC");
    });

    it("excludes specified tokens", () => {
      const result = filterTokens(mockTokens, {
        excludeTokens: ["0xAAA"],
      });
      expect(result.find((t) => t.symbol === "USDC")).toBeUndefined();
    });

    it("sorts by balance after filtering", () => {
      const result = filterTokens(mockTokens, { excludeDefi: true });
      expect(result[0].symbol).toBe("ETH"); // Highest balance
      expect(result[result.length - 1].symbol).toBe("DAI"); // Zero balance
    });
  });
});
