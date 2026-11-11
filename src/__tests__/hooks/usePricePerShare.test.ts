import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useReadContracts } from "wagmi";

import { useMultiplePricePerShare, usePricePerShare } from "@/hooks/usePricePerShare";

const VAULT = "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e" as const;

function withContractsResult(
  data: Array<{ result?: unknown; status?: "success" | "failure" }> | undefined,
  options: { isLoading?: boolean; error?: Error | null } = {},
) {
  vi.mocked(useReadContracts).mockReturnValue({
    data,
    isLoading: options.isLoading ?? false,
    error: options.error ?? null,
  } as unknown as ReturnType<typeof useReadContracts>);
}

describe("usePricePerShare", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withContractsResult([{ result: 18 }, { result: BigInt("1000000000000000000") }]);
  });

  it("reads decimals and convertToAssets for one share on mainnet", () => {
    renderHook(() => usePricePerShare(VAULT));

    expect(useReadContracts).toHaveBeenCalledWith(expect.objectContaining({
      contracts: [
        expect.objectContaining({ address: VAULT, functionName: "decimals", chainId: 1 }),
        expect.objectContaining({
          address: VAULT,
          functionName: "convertToAssets",
          args: [BigInt(10 ** 18)],
          chainId: 1,
        }),
      ],
    }));
  });

  it("reports a 1:1 price for a new vault", () => {
    const { result } = renderHook(() => usePricePerShare(VAULT));

    expect(result.current.pricePerShare).toBe(1);
    expect(result.current.pricePerShareFormatted).toBe("1.0000");
    expect(result.current.decimals).toBe(18);
  });

  it("calculates a vault that has gained assets per share", () => {
    withContractsResult([{ result: 18 }, { result: BigInt("1500000000000000000") }]);

    const { result } = renderHook(() => usePricePerShare(VAULT));

    expect(result.current.pricePerShare).toBe(1.5);
    expect(result.current.pricePerShareFormatted).toBe("1.5000");
  });

  it("keeps precision for a realistic vault price", () => {
    withContractsResult([{ result: 18 }, { result: BigInt("1123456789012345678") }]);

    const { result } = renderHook(() => usePricePerShare(VAULT));

    expect(result.current.pricePerShare).toBeCloseTo(1.123456789, 6);
    expect(result.current.pricePerShareFormatted).toBe("1.1235");
  });

  it("honours the vault's own decimals", () => {
    withContractsResult([{ result: 6 }, { result: BigInt("1500000") }]);

    const { result } = renderHook(() => usePricePerShare(VAULT));

    expect(result.current.decimals).toBe(6);
    expect(result.current.pricePerShare).toBe(1.5);
  });

  it("falls back to 1 when convertToAssets has not returned yet", () => {
    withContractsResult([{ result: 18 }]);

    const { result } = renderHook(() => usePricePerShare(VAULT));

    expect(result.current.pricePerShare).toBe(1);
    expect(result.current.pricePerShareFormatted).toBe("1.0000");
  });

  it("falls back to 1 for a zero convertToAssets result", () => {
    withContractsResult([{ result: 18 }, { result: 0n }]);

    const { result } = renderHook(() => usePricePerShare(VAULT));

    expect(result.current.pricePerShare).toBe(1);
  });

  it("falls back to 18 decimals when the read has no result", () => {
    withContractsResult(undefined);

    const { result } = renderHook(() => usePricePerShare(VAULT));

    expect(result.current.decimals).toBe(18);
    expect(result.current.pricePerShare).toBe(1);
  });

  it("exposes loading and error state", () => {
    const error = new Error("rpc unavailable");
    withContractsResult(undefined, { isLoading: true, error });

    const { result } = renderHook(() => usePricePerShare(VAULT));

    expect(result.current.isLoading).toBe(true);
    expect(result.current.error).toBe(error);
  });
});

describe("useMultiplePricePerShare", () => {
  const VAULTS = [
    "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e",
    "0xCa960E6DF1150100586c51382f619efCCcF72706",
  ] as const;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds decimals and convertToAssets reads for every vault", () => {
    withContractsResult([
      { result: 18 },
      { result: BigInt("1000000000000000000") },
      { result: 18 },
      { result: BigInt("1500000000000000000") },
    ]);

    renderHook(() => useMultiplePricePerShare([...VAULTS]));

    const [parameters] = vi.mocked(useReadContracts).mock.calls[0] as unknown as [{
      contracts: Array<{ address?: string; functionName?: string }>;
    }];
    expect(parameters.contracts.map((c) => ({ address: c.address, functionName: c.functionName }))).toEqual([
      { address: VAULTS[0], functionName: "decimals" },
      { address: VAULTS[0], functionName: "convertToAssets" },
      { address: VAULTS[1], functionName: "decimals" },
      { address: VAULTS[1], functionName: "convertToAssets" },
    ]);
  });

  it("pairs each vault with its own price", () => {
    withContractsResult([
      { result: 18 },
      { result: BigInt("1000000000000000000") },
      { result: 18 },
      { result: BigInt("1500000000000000000") },
    ]);

    const { result } = renderHook(() => useMultiplePricePerShare([...VAULTS]));

    expect(result.current.prices).toEqual([
      { address: VAULTS[0], pricePerShare: 1, pricePerShareFormatted: "1.0000", decimals: 18 },
      { address: VAULTS[1], pricePerShare: 1.5, pricePerShareFormatted: "1.5000", decimals: 18 },
    ]);
  });

  it("defaults missing vault data to a 1:1 price", () => {
    withContractsResult(undefined);

    const { result } = renderHook(() => useMultiplePricePerShare([...VAULTS]));

    expect(result.current.prices.map((p) => p.pricePerShare)).toEqual([1, 1]);
    expect(result.current.prices.map((p) => p.decimals)).toEqual([18, 18]);
  });

  it("returns no prices for an empty vault list", () => {
    withContractsResult([]);

    const { result } = renderHook(() => useMultiplePricePerShare([]));

    expect(result.current.prices).toEqual([]);
  });
});
