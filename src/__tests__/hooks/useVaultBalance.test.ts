import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAccount, useReadContracts } from "wagmi";

import { useMultipleVaultBalances, useVaultBalance } from "@/hooks/useVaultBalance";

const VAULT = "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e" as const;
const USER = "0x1234567890123456789012345678901234567890" as const;

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

function shares(amount: number, decimals = 18): bigint {
  return BigInt(Math.round(amount * 10 ** decimals));
}

describe("useVaultBalance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withAccount(USER);
    withReads([{ result: shares(1000) }, { result: 18 }]);
  });

  it("reads the connected account's vault shares and decimals", () => {
    renderHook(() => useVaultBalance(VAULT));

    expect(useReadContracts).toHaveBeenCalledWith(expect.objectContaining({
      contracts: [
        expect.objectContaining({ address: VAULT, functionName: "balanceOf", args: [USER], chainId: 1 }),
        expect.objectContaining({ address: VAULT, functionName: "decimals", chainId: 1 }),
      ],
      query: expect.objectContaining({ enabled: true }),
    }));
  });

  it("formats the share balance with the vault's decimals", () => {
    withReads([{ result: BigInt("1500000000000000000") }, { result: 18 }]);

    const { result } = renderHook(() => useVaultBalance(VAULT));

    expect(result.current.balance).toBe(BigInt("1500000000000000000"));
    expect(result.current.decimals).toBe(18);
    expect(result.current.formatted).toBe("1.5");
  });

  it("formats a six-decimal vault balance", () => {
    withReads([{ result: BigInt("1000000") }, { result: 6 }]);

    const { result } = renderHook(() => useVaultBalance(VAULT));

    expect(result.current.formatted).toBe("1");
  });

  it("values the position with price per share and asset price", () => {
    withReads([{ result: shares(1000) }, { result: 18 }]);

    const { result } = renderHook(() => useVaultBalance(VAULT, 1.05, 0.93));

    expect(result.current.formattedUsd).toBe("$976.50");
  });

  it("formats a large position in thousands", () => {
    const { result } = renderHook(() => useVaultBalance(VAULT, 1.05, 0.93));

    expect(result.current.formattedUsd).toBe("$976.50");

    withReads([{ result: shares(50000) }, { result: 18 }]);
    expect(renderHook(() => useVaultBalance(VAULT, 1.05, 0.93)).result.current.formattedUsd).toBe("$48.8K");
  });

  it.each([
    ["zero", 0, 1, 1, "$0"],
    ["one dollar", 1, 1, 1, "$1.00"],
    ["below a dollar", 0.5, 1, 1, "$0.5000"],
    ["a cent", 0.01, 1, 1, "$0.0100"],
    ["just under a dollar", 0.999, 1, 1, "$0.9990"],
    ["dust", 0.001, 1.05, 0.93, "$0.0010"],
    ["a thousand", 1000, 1, 1, "$1.0K"],
    ["fifteen hundred", 1500, 1, 1, "$1.5K"],
    ["just under a million", 999999, 1, 1, "$1000.0K"],
  ])("formats %s as %s", (_label, balance, pps, price, expected) => {
    withReads([{ result: shares(balance) }, { result: 18 }]);

    const { result } = renderHook(() => useVaultBalance(VAULT, pps, price));

    expect(result.current.formattedUsd).toBe(expected);
  });

  it("defaults an unloaded vault to a zero balance", () => {
    withReads(undefined);

    const { result } = renderHook(() => useVaultBalance(VAULT, 1.5, 100));

    expect(result.current.balance).toBe(0n);
    expect(result.current.decimals).toBe(18);
    expect(result.current.formatted).toBe("0");
    expect(result.current.formattedUsd).toBe("$0");
  });

  it("only reports loading while a wallet is connected", () => {
    withReads(undefined, { isLoading: true });

    withAccount(USER);
    expect(renderHook(() => useVaultBalance(VAULT)).result.current.isLoading).toBe(true);

    withAccount(undefined);
    expect(renderHook(() => useVaultBalance(VAULT)).result.current.isLoading).toBe(false);
  });

  it("disables the query without a connected wallet", () => {
    withAccount(undefined);

    renderHook(() => useVaultBalance(VAULT));

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

    const { result } = renderHook(() => useVaultBalance(VAULT));
    result.current.refetch();

    expect(refetch).toHaveBeenCalled();
  });
});

describe("useMultipleVaultBalances", () => {
  const VAULTS = [
    { address: "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e" as const, pricePerShare: 1, assetPriceUsd: 1 },
    { address: "0xCa960E6DF1150100586c51382f619efCCcF72706" as const, pricePerShare: 1.5, assetPriceUsd: 0.9 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    withAccount(USER);
  });

  it("reads a balance and decimals for every vault", () => {
    withReads([
      { result: shares(2) },
      { result: 18 },
      { result: shares(10) },
      { result: 18 },
    ]);

    renderHook(() => useMultipleVaultBalances(VAULTS));

    const [parameters] = vi.mocked(useReadContracts).mock.calls[0] as unknown as [{
      contracts: Array<{ address?: string; functionName?: string }>;
    }];
    expect(parameters.contracts.map((c) => ({ address: c.address, functionName: c.functionName }))).toEqual([
      { address: VAULTS[0].address, functionName: "balanceOf" },
      { address: VAULTS[0].address, functionName: "decimals" },
      { address: VAULTS[1].address, functionName: "balanceOf" },
      { address: VAULTS[1].address, functionName: "decimals" },
    ]);
  });

  it("pairs each vault with its own formatted balance and USD value", () => {
    withReads([
      { result: shares(2) },
      { result: 18 },
      { result: shares(10) },
      { result: 18 },
    ]);

    const { result } = renderHook(() => useMultipleVaultBalances(VAULTS));

    expect(result.current.balances).toEqual([
      expect.objectContaining({ address: VAULTS[0].address, formatted: "2", formattedUsd: "$2.00", usdValue: 2 }),
      expect.objectContaining({ address: VAULTS[1].address, formatted: "10", formattedUsd: "$13.50", usdValue: 13.5 }),
    ]);
  });

  it("defaults every missing vault to a zero balance", () => {
    withReads(undefined);

    const { result } = renderHook(() => useMultipleVaultBalances(VAULTS));

    expect(result.current.balances.map((b) => b.formatted)).toEqual(["0", "0"]);
    expect(result.current.balances.map((b) => b.formattedUsd)).toEqual(["$0", "$0"]);
  });

  it("returns no balances for an empty vault list", () => {
    withReads([]);

    const { result } = renderHook(() => useMultipleVaultBalances([]));

    expect(result.current.balances).toEqual([]);
  });

  it("passes connection and loading state through", () => {
    withReads(undefined, { isLoading: true });

    const { result } = renderHook(() => useMultipleVaultBalances(VAULTS));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isConnected).toBe(true);

    withAccount(undefined);
    const disconnected = renderHook(() => useMultipleVaultBalances(VAULTS)).result.current;
    expect(disconnected.isLoading).toBe(false);
    expect(disconnected.isConnected).toBe(false);
  });
});
