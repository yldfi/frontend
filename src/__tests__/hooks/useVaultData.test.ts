import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAccount, useReadContracts } from "wagmi";

import { formatFee, useVaultData } from "@/hooks/useVaultData";

const VAULT = "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e" as const;
const ACCOUNTANT = "0x1234567890123456789012345678901234567890" as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type ContractsResult = {
  data: Array<{ result?: unknown; status?: "success" | "failure" }> | undefined;
  isLoading: boolean;
  error: Error | null;
};

function stubReads(options: {
  vault?: Partial<ContractsResult>;
  accountant?: Partial<ContractsResult>;
}) {
  const vault: ContractsResult = { data: undefined, isLoading: false, error: null, ...options.vault };
  const accountant: ContractsResult = { data: undefined, isLoading: false, error: null, ...options.accountant };

  vi.mocked(useReadContracts).mockImplementation(((parameters: {
    contracts: Array<{ functionName?: string }>;
    query?: unknown;
  }) => {
    // Only the accountant read passes a `query` option; the vault read does not.
    return parameters.query !== undefined ? accountant : vault;
  }) as unknown as typeof useReadContracts);
}

function vaultResult(data: {
  accountant?: `0x${string}`;
  totalAssets?: bigint;
  pricePerShare?: bigint;
  decimals?: number;
}) {
  return [
    { result: data.accountant },
    { result: data.totalAssets },
    { result: data.pricePerShare },
    { result: data.decimals },
  ];
}

type ReadContractsCall = {
  contracts: Array<{ address?: string; functionName?: string; args?: readonly unknown[]; chainId?: number }>;
  query?: { enabled?: boolean };
};

function readCalls(): ReadContractsCall[] {
  return vi.mocked(useReadContracts).mock.calls.map(
    ([parameters]) => parameters as unknown as ReadContractsCall,
  );
}

describe("useVaultData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAccount).mockReturnValue({ chainId: 1 } as unknown as ReturnType<typeof useAccount>);
    stubReads({
      vault: {
        data: vaultResult({
          accountant: ACCOUNTANT,
          totalAssets: BigInt("1000000000000000000000"),
          pricePerShare: BigInt("1050000000000000000"),
          decimals: 18,
        }),
      },
      accountant: {
        data: [
          { result: false },
          { result: undefined },
          { result: [200, 2000, 0, 5000, 10000, 10000] },
        ],
      },
    });
  });

  it("reads the vault fields on the connected chain", () => {
    renderHook(() => useVaultData(VAULT));

    const [parameters] = readCalls() as [ReadContractsCall];
    expect(parameters.contracts.map((c) => c.functionName)).toEqual([
      "accountant",
      "totalAssets",
      "pricePerShare",
      "decimals",
    ]);
    expect(parameters.contracts.every((c) => c.address === VAULT && c.chainId === 1)).toBe(true);
  });

  it("extracts vault totals, price per share and decimals", () => {
    const { result } = renderHook(() => useVaultData(VAULT));

    expect(result.current.accountant).toBe(ACCOUNTANT);
    expect(result.current.totalAssets).toBe(BigInt("1000000000000000000000"));
    expect(result.current.pricePerShare).toBe(BigInt("1050000000000000000"));
    expect(result.current.decimals).toBe(18);
  });

  it("reads the accountant's config for the vault", () => {
    renderHook(() => useVaultData(VAULT));

    const accountantCalls = readCalls()
      .filter((parameters) => parameters.contracts[0]?.address === ACCOUNTANT);

    expect(accountantCalls).toHaveLength(1);
    expect(accountantCalls[0].contracts.map((c) => c.functionName)).toEqual([
      "useCustomConfig",
      "customConfig",
      "defaultConfig",
    ]);
    expect(accountantCalls[0].contracts[0].args).toEqual([VAULT]);
    expect(accountantCalls[0].contracts[1].args).toEqual([VAULT]);
    expect(accountantCalls[0].query).toEqual(expect.objectContaining({ enabled: true }));
  });

  it("uses the default fee config when the vault has no custom config", () => {
    const { result } = renderHook(() => useVaultData(VAULT));

    expect(result.current.managementFee).toBe(200);
    expect(result.current.performanceFee).toBe(2000);
  });

  it("uses the custom fee config when the accountant reports one", () => {
    stubReads({
      vault: { data: vaultResult({ accountant: ACCOUNTANT }) },
      accountant: {
        data: [
          { result: true },
          { result: [100, 1500, 0, 5000, 10000, 10000] },
          { result: [200, 2000, 0, 5000, 10000, 10000] },
        ],
      },
    });

    const { result } = renderHook(() => useVaultData(VAULT));

    expect(result.current.managementFee).toBe(100);
    expect(result.current.performanceFee).toBe(1500);
  });

  it("defaults fees to zero when no config is available", () => {
    stubReads({ vault: { data: vaultResult({ accountant: ACCOUNTANT }) } });

    const { result } = renderHook(() => useVaultData(VAULT));

    expect(result.current.managementFee).toBe(0);
    expect(result.current.performanceFee).toBe(0);
  });

  it("defaults every field before the reads land", () => {
    stubReads({});

    const { result } = renderHook(() => useVaultData(VAULT));

    expect(result.current.accountant).toBe(ZERO_ADDRESS);
    expect(result.current.totalAssets).toBe(0n);
    expect(result.current.pricePerShare).toBe(0n);
    expect(result.current.decimals).toBe(18);
  });

  it("skips the accountant read when the vault has no accountant", () => {
    stubReads({ vault: { data: vaultResult({ totalAssets: 1n }) } });

    renderHook(() => useVaultData(VAULT));

    const accountantCall = readCalls().find((parameters) => parameters.query !== undefined);

    expect(accountantCall?.contracts).toEqual([]);
    expect(accountantCall?.query).toEqual(expect.objectContaining({ enabled: false }));
  });

  it("is loading while either read is loading", () => {
    stubReads({
      vault: { data: vaultResult({ accountant: ACCOUNTANT }), isLoading: false },
      accountant: { isLoading: true },
    });
    expect(renderHook(() => useVaultData(VAULT)).result.current.isLoading).toBe(true);

    stubReads({ vault: { isLoading: true }, accountant: { isLoading: false } });
    expect(renderHook(() => useVaultData(VAULT)).result.current.isLoading).toBe(true);

    stubReads({});
    expect(renderHook(() => useVaultData(VAULT)).result.current.isLoading).toBe(false);
  });

  it("surfaces the vault error before the accountant error", () => {
    const vaultError = new Error("vault failed");
    const accountantError = new Error("accountant failed");

    stubReads({
      vault: {
        data: vaultResult({ accountant: ACCOUNTANT }),
        error: vaultError,
      },
      accountant: { error: accountantError },
    });
    expect(renderHook(() => useVaultData(VAULT)).result.current.error).toBe(vaultError);

    stubReads({
      vault: { data: vaultResult({ accountant: ACCOUNTANT }) },
      accountant: { error: accountantError },
    });
    expect(renderHook(() => useVaultData(VAULT)).result.current.error).toBe(accountantError);

    stubReads({});
    expect(renderHook(() => useVaultData(VAULT)).result.current.error).toBeNull();
  });
});

describe("formatFee", () => {
  it.each([
    [0, "0"],
    [100, "1"],
    [200, "2"],
    [1000, "10"],
    [1500, "15"],
    [2000, "20"],
    [10000, "100"],
    [50, "0.50"],
    [150, "1.50"],
    [25, "0.25"],
    [175, "1.75"],
    [1, "0.01"],
    [99, "0.99"],
    [33, "0.33"],
  ])("formats %i bps as %s per cent", (bps, expected) => {
    expect(formatFee(bps)).toBe(expected);
  });
});
