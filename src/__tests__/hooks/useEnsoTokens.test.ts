import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";

import { DEFAULT_ETH_TOKEN, useEnsoToken, useEnsoTokens } from "@/hooks/useEnsoTokens";
import { CUSTOM_TOKENS, ETH_ADDRESS } from "@/lib/enso";
import type { EnsoToken } from "@/types/enso";

const imported = vi.hoisted(() => ({
  tokens: [] as EnsoToken[],
  addToken: vi.fn(),
}));

vi.mock("@/hooks/useImportedTokens", () => ({
  useImportedTokens: () => ({
    importedTokens: imported.tokens,
    addToken: imported.addToken,
    isImported: (address: string) =>
      imported.tokens.some((t) => t.address.toLowerCase() === address.toLowerCase()),
  }),
}));

const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const CVXCRV_ADDRESS = "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7";

function token(symbol: string, address: string, overrides: Partial<EnsoToken> = {}): EnsoToken {
  return { address, chainId: 1, name: symbol, symbol, decimals: 18, type: "base", ...overrides };
}

function withQueryResult(
  data: EnsoToken[] | Map<string, EnsoToken> | undefined,
  options: { isLoading?: boolean; error?: Error | null } = {},
) {
  const refetch = vi.fn();
  vi.mocked(useQuery).mockReturnValue({
    data,
    isLoading: options.isLoading ?? false,
    error: options.error ?? null,
    refetch,
  } as unknown as ReturnType<typeof useQuery>);
  return refetch;
}

describe("useEnsoTokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    imported.tokens = [];
    withQueryResult([token("USDC", USDC_ADDRESS)]);
  });

  it("merges Enso tokens with the custom token list", () => {
    const { result } = renderHook(() => useEnsoTokens());

    expect(result.current.allTokens).toHaveLength(CUSTOM_TOKENS.length + 1);
    expect(result.current.allTokens.some((t) => t.symbol === "USDC")).toBe(true);
    expect(result.current.allTokens.some((t) => t.symbol === "cvxCRV")).toBe(true);
  });

  it("prefers an imported token over the custom and Enso copies", () => {
    imported.tokens = [token("IMPORTED_CVXCRV", CVXCRV_ADDRESS, { decimals: 6 })];

    const { result } = renderHook(() => useEnsoTokens());

    const merged = result.current.allTokens.filter(
      (t) => t.address.toLowerCase() === CVXCRV_ADDRESS.toLowerCase(),
    );
    expect(merged).toEqual([expect.objectContaining({ symbol: "IMPORTED_CVXCRV", decimals: 6 })]);
  });

  it("prefers a custom token over the Enso copy and dedupes by lowercase address", () => {
    withQueryResult([
      token("ENSO_CVXCRV", CVXCRV_ADDRESS.toLowerCase(), { decimals: 8 }),
      token("USDC", USDC_ADDRESS),
    ]);

    const { result } = renderHook(() => useEnsoTokens());

    const merged = result.current.allTokens.filter(
      (t) => t.address.toLowerCase() === CVXCRV_ADDRESS.toLowerCase(),
    );
    expect(merged).toEqual([expect.objectContaining({ symbol: "cvxCRV" })]);
  });

  it("sorts the merged list with popular tokens first", () => {
    const { result } = renderHook(() => useEnsoTokens());

    expect(result.current.allTokens[0].symbol).toBe("ETH");
    expect(result.current.allTokens[1].symbol).toBe("USDC");
  });

  it("filters the list by the search query", () => {
    const { result } = renderHook(() => useEnsoTokens());

    act(() => result.current.setSearchQuery("usdc"));

    expect(result.current.searchQuery).toBe("usdc");
    const symbols = result.current.tokens.map((t) => t.symbol);
    expect(symbols).toContain("USDC");
    expect(symbols).not.toContain("ETH");
  });

  it("caps the filtered list at 100 tokens", () => {
    withQueryResult(
      Array.from({ length: 150 }, (_, index) =>
        token(`TOKEN${index}`, `0x${"a".repeat(38)}${String(index).padStart(2, "0")}`),
      ),
    );

    const { result } = renderHook(() => useEnsoTokens());

    expect(result.current.allTokens).toHaveLength(CUSTOM_TOKENS.length + 150);
    expect(result.current.tokens).toHaveLength(100);
  });

  it("imports a token through the imported-token store", () => {
    const { result } = renderHook(() => useEnsoTokens());
    const newToken = token("NEW", "0x0000000000000000000000000000000000000002");

    act(() => result.current.importToken(newToken));

    expect(imported.addToken).toHaveBeenCalledWith(newToken);
  });

  it("passes query state and refetch through", () => {
    const error = new Error("token list unavailable");
    const refetch = withQueryResult(undefined, { isLoading: true, error });

    const { result } = renderHook(() => useEnsoTokens());
    result.current.refetch();

    expect(result.current.isLoading).toBe(true);
    expect(result.current.error).toBe(error);
    expect(refetch).toHaveBeenCalled();
  });
});

describe("useEnsoToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds the lookup map with custom tokens first and lowercase keys", () => {
    withQueryResult(new Map());

    renderHook(() => useEnsoToken(CVXCRV_ADDRESS));

    const [options] = vi.mocked(useQuery).mock.calls.at(-1)! as unknown as [{
      select?: (tokens: EnsoToken[]) => Map<string, EnsoToken>;
    }];
    expect(options.select).toBeTypeOf("function");

    const ensoCvxCrv = token("ENSO_CVXCRV", CVXCRV_ADDRESS.toLowerCase(), { decimals: 8 });
    const other = token("OTHER", "0x0000000000000000000000000000000000000004");

    const map = options.select!([ensoCvxCrv, other]);

    expect(map.get(CVXCRV_ADDRESS.toLowerCase())).toEqual(
      expect.objectContaining({ symbol: "cvxCRV" }),
    );
    expect(map.get(CVXCRV_ADDRESS.toLowerCase())?.decimals).toBe(18);
    expect([...map.keys()].every((key) => key === key.toLowerCase())).toBe(true);
    expect(map.get(other.address.toLowerCase())).toEqual(other);
  });

  it("looks a token up by address case-insensitively", () => {
    withQueryResult(new Map([
      [USDC_ADDRESS.toLowerCase(), token("USDC", USDC_ADDRESS)],
    ]));

    const { result } = renderHook(() => useEnsoToken(USDC_ADDRESS.toUpperCase().replace("0X", "0x")));

    expect(result.current.token?.symbol).toBe("USDC");
  });

  it("returns null for an unknown or missing address", () => {
    withQueryResult(new Map());

    expect(renderHook(() => useEnsoToken(undefined)).result.current.token).toBeNull();
    expect(renderHook(() => useEnsoToken("")).result.current.token).toBeNull();
    expect(renderHook(() => useEnsoToken("0x0000000000000000000000000000000000000009")).result.current.token).toBeNull();
  });

  it("exposes the token-list loading state", () => {
    withQueryResult(undefined, { isLoading: true });

    const { result } = renderHook(() => useEnsoToken(USDC_ADDRESS));

    expect(result.current.isLoading).toBe(true);
    expect(result.current.token).toBeNull();
  });
});

describe("DEFAULT_ETH_TOKEN", () => {
  it("describes mainnet ETH with its logo", () => {
    expect(DEFAULT_ETH_TOKEN).toEqual({
      address: ETH_ADDRESS,
      chainId: 1,
      name: "Ethereum",
      symbol: "ETH",
      decimals: 18,
      logoURI: "/tokens/eth.png",
      type: "base",
    });
  });
});
