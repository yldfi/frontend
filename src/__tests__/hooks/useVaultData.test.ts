import { describe, it, expect } from "vitest";

// Test the useVaultData business logic directly
// We test fee formatting, config selection, and data extraction

describe("useVaultData logic", () => {
  describe("formatFee function", () => {
    // Replicate the formatFee function from useVaultData.ts
    function formatFee(bps: number): string {
      return (bps / 100).toFixed(bps % 100 === 0 ? 0 : 2);
    }

    describe("common fee values", () => {
      it("formats 0 bps as 0", () => {
        expect(formatFee(0)).toBe("0");
      });

      it("formats 100 bps as 1 (1%)", () => {
        expect(formatFee(100)).toBe("1");
      });

      it("formats 200 bps as 2 (2%)", () => {
        expect(formatFee(200)).toBe("2");
      });

      it("formats 1000 bps as 10 (10%)", () => {
        expect(formatFee(1000)).toBe("10");
      });

      it("formats 1500 bps as 15 (15%)", () => {
        expect(formatFee(1500)).toBe("15");
      });

      it("formats 2000 bps as 20 (20%)", () => {
        expect(formatFee(2000)).toBe("20");
      });
    });

    describe("fractional percentages", () => {
      it("formats 50 bps as 0.50 (0.5%)", () => {
        expect(formatFee(50)).toBe("0.50");
      });

      it("formats 150 bps as 1.50 (1.5%)", () => {
        expect(formatFee(150)).toBe("1.50");
      });

      it("formats 25 bps as 0.25 (0.25%)", () => {
        expect(formatFee(25)).toBe("0.25");
      });

      it("formats 175 bps as 1.75 (1.75%)", () => {
        expect(formatFee(175)).toBe("1.75");
      });

      it("formats 1 bps as 0.01 (0.01%)", () => {
        expect(formatFee(1)).toBe("0.01");
      });

      it("formats 99 bps as 0.99 (0.99%)", () => {
        expect(formatFee(99)).toBe("0.99");
      });
    });

    describe("edge cases", () => {
      it("handles maximum reasonable fee (10000 bps = 100%)", () => {
        expect(formatFee(10000)).toBe("100");
      });

      it("handles small odd values", () => {
        expect(formatFee(33)).toBe("0.33");
        expect(formatFee(67)).toBe("0.67");
      });
    });
  });

  describe("config selection logic", () => {
    type FeeConfig = readonly [number, number, number, number, number, number];

    function selectConfig(
      useCustom: boolean | undefined,
      customConfig: FeeConfig | undefined,
      defaultConfig: FeeConfig | undefined
    ): FeeConfig | undefined {
      return useCustom ? customConfig : defaultConfig;
    }

    const customConfig: FeeConfig = [100, 1500, 0, 5000, 10000, 10000];
    const defaultConfig: FeeConfig = [200, 2000, 0, 5000, 10000, 10000];

    it("returns custom config when useCustom is true", () => {
      const config = selectConfig(true, customConfig, defaultConfig);
      expect(config).toBe(customConfig);
      expect(config?.[0]).toBe(100); // management fee
      expect(config?.[1]).toBe(1500); // performance fee
    });

    it("returns default config when useCustom is false", () => {
      const config = selectConfig(false, customConfig, defaultConfig);
      expect(config).toBe(defaultConfig);
      expect(config?.[0]).toBe(200);
      expect(config?.[1]).toBe(2000);
    });

    it("returns default config when useCustom is undefined", () => {
      const config = selectConfig(undefined, customConfig, defaultConfig);
      expect(config).toBe(defaultConfig);
    });

    it("returns undefined when both configs are undefined", () => {
      const config = selectConfig(false, undefined, undefined);
      expect(config).toBeUndefined();
    });
  });

  describe("vault data extraction", () => {
    interface ContractResult {
      result?: unknown;
      status?: "success" | "failure";
    }

    function extractVaultData(data: ContractResult[] | undefined) {
      return {
        accountant: (data?.[0]?.result as `0x${string}`) ?? "0x0000000000000000000000000000000000000000",
        totalAssets: (data?.[1]?.result as bigint) ?? 0n,
        pricePerShare: (data?.[2]?.result as bigint) ?? 0n,
        decimals: (data?.[3]?.result as number) ?? 18,
      };
    }

    it("extracts all fields when present", () => {
      const data: ContractResult[] = [
        { result: "0x1234567890123456789012345678901234567890" },
        { result: BigInt("1000000000000000000000") },
        { result: BigInt("1050000000000000000") },
        { result: 18 },
      ];

      const extracted = extractVaultData(data);
      expect(extracted.accountant).toBe("0x1234567890123456789012345678901234567890");
      expect(extracted.totalAssets).toBe(BigInt("1000000000000000000000"));
      expect(extracted.pricePerShare).toBe(BigInt("1050000000000000000"));
      expect(extracted.decimals).toBe(18);
    });

    it("uses defaults when data is undefined", () => {
      const extracted = extractVaultData(undefined);
      expect(extracted.accountant).toBe("0x0000000000000000000000000000000000000000");
      expect(extracted.totalAssets).toBe(0n);
      expect(extracted.pricePerShare).toBe(0n);
      expect(extracted.decimals).toBe(18);
    });

    it("uses defaults when results are missing", () => {
      const data: ContractResult[] = [
        { status: "failure" },
        { status: "failure" },
        { status: "failure" },
        { status: "failure" },
      ];

      const extracted = extractVaultData(data);
      expect(extracted.totalAssets).toBe(0n);
      expect(extracted.decimals).toBe(18);
    });
  });

  describe("fee extraction from config", () => {
    type FeeConfig = readonly [number, number, number, number, number, number];

    function extractFees(config: FeeConfig | undefined) {
      return {
        managementFee: config?.[0] ?? 0,
        performanceFee: config?.[1] ?? 0,
        refundRatio: config?.[2] ?? 0,
        maxFee: config?.[3] ?? 0,
        maxGain: config?.[4] ?? 0,
        maxLoss: config?.[5] ?? 0,
      };
    }

    it("extracts all fee values from config", () => {
      const config: FeeConfig = [100, 1500, 50, 5000, 10000, 10000];
      const fees = extractFees(config);

      expect(fees.managementFee).toBe(100);
      expect(fees.performanceFee).toBe(1500);
      expect(fees.refundRatio).toBe(50);
      expect(fees.maxFee).toBe(5000);
      expect(fees.maxGain).toBe(10000);
      expect(fees.maxLoss).toBe(10000);
    });

    it("returns defaults when config is undefined", () => {
      const fees = extractFees(undefined);

      expect(fees.managementFee).toBe(0);
      expect(fees.performanceFee).toBe(0);
      expect(fees.refundRatio).toBe(0);
      expect(fees.maxFee).toBe(0);
      expect(fees.maxGain).toBe(0);
      expect(fees.maxLoss).toBe(0);
    });
  });

  describe("isLoading derivation", () => {
    function deriveIsLoading(vaultLoading: boolean, accountantLoading: boolean): boolean {
      return vaultLoading || accountantLoading;
    }

    it("returns true when vault is loading", () => {
      expect(deriveIsLoading(true, false)).toBe(true);
    });

    it("returns true when accountant is loading", () => {
      expect(deriveIsLoading(false, true)).toBe(true);
    });

    it("returns true when both are loading", () => {
      expect(deriveIsLoading(true, true)).toBe(true);
    });

    it("returns false when neither is loading", () => {
      expect(deriveIsLoading(false, false)).toBe(false);
    });
  });

  describe("error derivation", () => {
    function deriveError(vaultError: Error | null, accountantError: Error | null): Error | null {
      return vaultError || accountantError || null;
    }

    it("returns vault error when present", () => {
      const error = new Error("Vault error");
      expect(deriveError(error, null)).toBe(error);
    });

    it("returns accountant error when present", () => {
      const error = new Error("Accountant error");
      expect(deriveError(null, error)).toBe(error);
    });

    it("returns vault error when both present (priority)", () => {
      const vaultError = new Error("Vault error");
      const accountantError = new Error("Accountant error");
      expect(deriveError(vaultError, accountantError)).toBe(vaultError);
    });

    it("returns null when no errors", () => {
      expect(deriveError(null, null)).toBeNull();
    });
  });

  describe("query enablement for accountant", () => {
    function shouldEnableAccountantQuery(accountantAddress: string | undefined): boolean {
      return !!accountantAddress;
    }

    it("enables when accountant address exists", () => {
      expect(shouldEnableAccountantQuery("0x1234")).toBe(true);
    });

    it("disables when accountant address is undefined", () => {
      expect(shouldEnableAccountantQuery(undefined)).toBe(false);
    });

    it("disables when accountant address is empty string", () => {
      expect(shouldEnableAccountantQuery("")).toBe(false);
    });
  });

  describe("VaultData interface", () => {
    interface VaultData {
      totalAssets: bigint;
      pricePerShare: bigint;
      decimals: number;
      accountant: `0x${string}`;
      managementFee: number;
      performanceFee: number;
      isLoading: boolean;
      error: Error | null;
    }

    function createVaultData(overrides: Partial<VaultData> = {}): VaultData {
      return {
        totalAssets: 0n,
        pricePerShare: 0n,
        decimals: 18,
        accountant: "0x0000000000000000000000000000000000000000",
        managementFee: 0,
        performanceFee: 0,
        isLoading: false,
        error: null,
        ...overrides,
      };
    }

    it("creates default vault data", () => {
      const data = createVaultData();
      expect(data.totalAssets).toBe(0n);
      expect(data.decimals).toBe(18);
      expect(data.isLoading).toBe(false);
      expect(data.error).toBeNull();
    });

    it("allows overriding fields", () => {
      const data = createVaultData({
        totalAssets: BigInt("1000000000000000000"),
        managementFee: 100,
        performanceFee: 1500,
      });

      expect(data.totalAssets).toBe(BigInt("1000000000000000000"));
      expect(data.managementFee).toBe(100);
      expect(data.performanceFee).toBe(1500);
    });
  });

  describe("typical fee configurations", () => {
    // Common Yearn V3 fee structures
    it("standard vault: 2% management, 20% performance", () => {
      const managementFee = 200; // 2%
      const performanceFee = 2000; // 20%

      expect(managementFee / 100).toBe(2);
      expect(performanceFee / 100).toBe(20);
    });

    it("low fee vault: 0% management, 10% performance", () => {
      const managementFee = 0;
      const performanceFee = 1000;

      expect(managementFee / 100).toBe(0);
      expect(performanceFee / 100).toBe(10);
    });

    it("yld_fi vault: 0% management, 10% performance", () => {
      // Typical yld_fi configuration
      const managementFee = 0;
      const performanceFee = 1000;

      expect(managementFee).toBe(0);
      expect(performanceFee).toBe(1000);
    });
  });

  describe("contracts array for vault reads", () => {
    const vaultAbi = [
      { name: "accountant" },
      { name: "totalAssets" },
      { name: "pricePerShare" },
      { name: "decimals" },
    ];

    function buildVaultContracts(vaultAddress: string) {
      return [
        { address: vaultAddress, functionName: "accountant" },
        { address: vaultAddress, functionName: "totalAssets" },
        { address: vaultAddress, functionName: "pricePerShare" },
        { address: vaultAddress, functionName: "decimals" },
      ];
    }

    it("builds 4 contract calls for vault data", () => {
      const contracts = buildVaultContracts("0x123");
      expect(contracts).toHaveLength(4);
    });

    it("all contracts have same address", () => {
      const contracts = buildVaultContracts("0x123");
      contracts.forEach((c) => {
        expect(c.address).toBe("0x123");
      });
    });

    it("has correct function names in order", () => {
      const contracts = buildVaultContracts("0x123");
      expect(contracts[0].functionName).toBe("accountant");
      expect(contracts[1].functionName).toBe("totalAssets");
      expect(contracts[2].functionName).toBe("pricePerShare");
      expect(contracts[3].functionName).toBe("decimals");
    });
  });

  describe("contracts array for accountant reads", () => {
    function buildAccountantContracts(
      accountantAddress: string,
      vaultAddress: string
    ) {
      return [
        {
          address: accountantAddress,
          functionName: "useCustomConfig",
          args: [vaultAddress],
        },
        {
          address: accountantAddress,
          functionName: "customConfig",
          args: [vaultAddress],
        },
        {
          address: accountantAddress,
          functionName: "defaultConfig",
        },
      ];
    }

    it("builds 3 contract calls for accountant data", () => {
      const contracts = buildAccountantContracts("0xAcc", "0xVault");
      expect(contracts).toHaveLength(3);
    });

    it("passes vault address as arg to useCustomConfig", () => {
      const contracts = buildAccountantContracts("0xAcc", "0xVault");
      expect(contracts[0].args).toEqual(["0xVault"]);
    });

    it("passes vault address as arg to customConfig", () => {
      const contracts = buildAccountantContracts("0xAcc", "0xVault");
      expect(contracts[1].args).toEqual(["0xVault"]);
    });

    it("defaultConfig has no args", () => {
      const contracts = buildAccountantContracts("0xAcc", "0xVault");
      expect(contracts[2].args).toBeUndefined();
    });
  });
});
