import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAccount, useReadContracts } from "wagmi";

import { useTokenBalance } from "@/hooks/useTokenBalance";

const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;

function withReads(
  data: Array<{ result?: unknown; status?: "success" | "failure" }> | undefined,
  options: { isLoading?: boolean } = {},
) {
  vi.mocked(useReadContracts).mockReturnValue({
    data,
    isLoading: options.isLoading ?? false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useReadContracts>);
}

function withAccount(address: `0x${string}` | undefined, isConnected = Boolean(address)) {
  vi.mocked(useAccount).mockReturnValue({
    address,
    isConnected,
    chainId: 1,
  } as unknown as ReturnType<typeof useAccount>);
}

describe("useTokenBalance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withAccount("0x1234567890123456789012345678901234567890");
    withReads([{ result: BigInt("1000000000000000000") }, { result: 18 }]);
  });

  it("reads the connected account's balance and the token decimals", () => {
    renderHook(() => useTokenBalance(TOKEN));

    expect(useReadContracts).toHaveBeenCalledWith(expect.objectContaining({
      contracts: [
        expect.objectContaining({
          address: TOKEN,
          functionName: "balanceOf",
          args: ["0x1234567890123456789012345678901234567890"],
          chainId: 1,
        }),
        expect.objectContaining({ address: TOKEN, functionName: "decimals", chainId: 1 }),
      ],
      query: expect.objectContaining({ enabled: true }),
    }));
  });

  it("formats an 18-decimal balance", () => {
    withReads([{ result: BigInt("1234567890123456789") }, { result: 18 }]);

    const { result } = renderHook(() => useTokenBalance(TOKEN));

    expect(result.current.balance).toBe(BigInt("1234567890123456789"));
    expect(result.current.decimals).toBe(18);
    expect(result.current.formatted).toBe("1.234567890123456789");
  });

  it.each([
    ["1 token", BigInt("1000000000000000000"), 18, "1"],
    ["half a token", BigInt("500000000000000000"), 18, "0.5"],
    ["one wei", 1n, 18, "0.000000000000000001"],
    ["one million tokens", BigInt("1000000000000000000000000"), 18, "1000000"],
    ["one USDC", BigInt("1000000"), 6, "1"],
    ["one cent", BigInt("10000"), 6, "0.01"],
    ["one WBTC", BigInt("100000000"), 8, "1"],
    ["one satoshi", 1n, 8, "0.00000001"],
    ["a token with no decimals", BigInt("42"), 0, "42"],
  ])("formats %s", (_label, balance, decimals, expected) => {
    withReads([{ result: balance }, { result: decimals }]);

    const { result } = renderHook(() => useTokenBalance(TOKEN));

    expect(result.current.formatted).toBe(expected);
  });

  it("defaults the balance to zero and the decimals to 18 before the reads land", () => {
    withReads(undefined);

    const { result } = renderHook(() => useTokenBalance(TOKEN));

    expect(result.current.balance).toBe(0n);
    expect(result.current.decimals).toBe(18);
    expect(result.current.formatted).toBe("0");
  });

  it("defaults a failed read to zero instead of throwing", () => {
    withReads([{ status: "failure" }, { status: "failure" }]);

    const { result } = renderHook(() => useTokenBalance(TOKEN));

    expect(result.current.balance).toBe(0n);
    expect(result.current.decimals).toBe(18);
    expect(result.current.formatted).toBe("0");
  });

  it("only reports loading while a wallet is connected", () => {
    withReads(undefined, { isLoading: true });

    withAccount("0x1234567890123456789012345678901234567890");
    expect(renderHook(() => useTokenBalance(TOKEN)).result.current.isLoading).toBe(true);

    withAccount(undefined);
    expect(renderHook(() => useTokenBalance(TOKEN)).result.current.isLoading).toBe(false);
  });

  it("disables the query when no wallet is connected", () => {
    withAccount(undefined);

    renderHook(() => useTokenBalance(TOKEN));

    const [parameters] = vi.mocked(useReadContracts).mock.calls[0] as unknown as [{
      contracts: Array<{ args?: readonly unknown[] }>;
      query: { enabled: boolean };
    }];
    expect(parameters.query).toEqual(expect.objectContaining({ enabled: false }));
    expect(parameters.contracts[0].args).toBeUndefined();
  });

  it("passes refetch through", () => {
    const refetch = vi.fn();
    vi.mocked(useReadContracts).mockReturnValue({
      data: undefined,
      isLoading: false,
      refetch,
    } as unknown as ReturnType<typeof useReadContracts>);

    const { result } = renderHook(() => useTokenBalance(TOKEN));
    result.current.refetch();

    expect(refetch).toHaveBeenCalled();
  });
});
