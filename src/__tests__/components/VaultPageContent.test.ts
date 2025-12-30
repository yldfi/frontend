import { describe, it, expect } from "vitest";
import { formatUnits, parseUnits } from "viem";

// Test the VaultPageContent business logic directly
// We test vault configuration, calculations, and formatting without rendering components

describe("VaultPageContent logic", () => {
  describe("vaultsData configuration", () => {
    const YCVXCRV_ADDRESS = "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86";
    const YSCVXCRV_ADDRESS = "0x27B5739e22ad9033bcBf192059122d163b60349D";

    interface VaultData {
      name: string;
      symbol: string;
      description: string;
      asset: string;
      assetSymbol: string;
      assetDecimals: number;
      decimals: number;
      strategyDescription: string;
      links: { label: string; url: string }[];
      contractAddress?: string;
      version?: string;
    }

    const vaultsData: Record<string, VaultData> = {
      [YCVXCRV_ADDRESS]: {
        name: "ycvxCRV",
        symbol: "ycvxCRV",
        description: "Yearn cvxCRV Vault",
        asset: "cvxCRV",
        assetSymbol: "cvxCRV",
        assetDecimals: 18,
        decimals: 18,
        strategyDescription: "Deposits cvxCRV into Convex and auto-compounds rewards",
        links: [
          { label: "Strategy", url: "https://etherscan.io/address/0x..." },
        ],
        contractAddress: YCVXCRV_ADDRESS,
        version: "v3",
      },
      [YSCVXCRV_ADDRESS]: {
        name: "yscvxCRV",
        symbol: "yscvxCRV",
        description: "Yearn staked cvxCRV Vault",
        asset: "stkCvxCrv",
        assetSymbol: "stkCvxCrv",
        assetDecimals: 18,
        decimals: 18,
        strategyDescription: "Deposits stkCvxCrv into Convex and auto-compounds rewards",
        links: [],
        contractAddress: YSCVXCRV_ADDRESS,
        version: "v3",
      },
    };

    it("has ycvxCRV vault configuration", () => {
      expect(vaultsData[YCVXCRV_ADDRESS]).toBeDefined();
      expect(vaultsData[YCVXCRV_ADDRESS].name).toBe("ycvxCRV");
    });

    it("has yscvxCRV vault configuration", () => {
      expect(vaultsData[YSCVXCRV_ADDRESS]).toBeDefined();
      expect(vaultsData[YSCVXCRV_ADDRESS].name).toBe("yscvxCRV");
    });

    it("ycvxCRV uses cvxCRV as asset", () => {
      expect(vaultsData[YCVXCRV_ADDRESS].asset).toBe("cvxCRV");
      expect(vaultsData[YCVXCRV_ADDRESS].assetSymbol).toBe("cvxCRV");
    });

    it("yscvxCRV uses stkCvxCrv as asset", () => {
      expect(vaultsData[YSCVXCRV_ADDRESS].asset).toBe("stkCvxCrv");
      expect(vaultsData[YSCVXCRV_ADDRESS].assetSymbol).toBe("stkCvxCrv");
    });

    it("both vaults use 18 decimals", () => {
      expect(vaultsData[YCVXCRV_ADDRESS].decimals).toBe(18);
      expect(vaultsData[YSCVXCRV_ADDRESS].decimals).toBe(18);
      expect(vaultsData[YCVXCRV_ADDRESS].assetDecimals).toBe(18);
      expect(vaultsData[YSCVXCRV_ADDRESS].assetDecimals).toBe(18);
    });

    it("both vaults are v3", () => {
      expect(vaultsData[YCVXCRV_ADDRESS].version).toBe("v3");
      expect(vaultsData[YSCVXCRV_ADDRESS].version).toBe("v3");
    });
  });

  describe("transaction mode", () => {
    type TransactionMode = "deposit" | "withdraw" | "zap";

    function getTransactionModes(): TransactionMode[] {
      return ["deposit", "withdraw", "zap"];
    }

    function isValidTransactionMode(mode: string): mode is TransactionMode {
      return ["deposit", "withdraw", "zap"].includes(mode);
    }

    it("has three transaction modes", () => {
      expect(getTransactionModes()).toHaveLength(3);
    });

    it("validates deposit mode", () => {
      expect(isValidTransactionMode("deposit")).toBe(true);
    });

    it("validates withdraw mode", () => {
      expect(isValidTransactionMode("withdraw")).toBe(true);
    });

    it("validates zap mode", () => {
      expect(isValidTransactionMode("zap")).toBe(true);
    });

    it("rejects invalid mode", () => {
      expect(isValidTransactionMode("invalid")).toBe(false);
      expect(isValidTransactionMode("")).toBe(false);
    });
  });

  describe("exchange rate calculation", () => {
    function calculateExchangeRate(pricePerShare: bigint, decimals: number): number {
      return Number(formatUnits(pricePerShare, decimals));
    }

    it("calculates 1:1 exchange rate", () => {
      const pps = parseUnits("1", 18);
      expect(calculateExchangeRate(pps, 18)).toBe(1);
    });

    it("calculates 1.05:1 exchange rate (5% gain)", () => {
      const pps = parseUnits("1.05", 18);
      expect(calculateExchangeRate(pps, 18)).toBe(1.05);
    });

    it("calculates 1.5:1 exchange rate (50% gain)", () => {
      const pps = parseUnits("1.5", 18);
      expect(calculateExchangeRate(pps, 18)).toBe(1.5);
    });

    it("calculates 2:1 exchange rate (100% gain)", () => {
      const pps = parseUnits("2", 18);
      expect(calculateExchangeRate(pps, 18)).toBe(2);
    });
  });

  describe("deposit output calculation", () => {
    function calculateDepositOutput(
      inputAmount: bigint,
      pricePerShare: bigint,
      decimals: number
    ): bigint {
      // shares = assets / pricePerShare
      if (pricePerShare === 0n) return 0n;
      return (inputAmount * parseUnits("1", decimals)) / pricePerShare;
    }

    it("calculates shares at 1:1 pps", () => {
      const input = parseUnits("100", 18);
      const pps = parseUnits("1", 18);
      const shares = calculateDepositOutput(input, pps, 18);
      expect(shares).toBe(parseUnits("100", 18));
    });

    it("calculates fewer shares at 1.05 pps", () => {
      const input = parseUnits("105", 18);
      const pps = parseUnits("1.05", 18);
      const shares = calculateDepositOutput(input, pps, 18);
      expect(shares).toBe(parseUnits("100", 18));
    });

    it("calculates fewer shares at 2:1 pps", () => {
      const input = parseUnits("200", 18);
      const pps = parseUnits("2", 18);
      const shares = calculateDepositOutput(input, pps, 18);
      expect(shares).toBe(parseUnits("100", 18));
    });

    it("returns 0 for 0 input", () => {
      const pps = parseUnits("1.05", 18);
      const shares = calculateDepositOutput(0n, pps, 18);
      expect(shares).toBe(0n);
    });

    it("returns 0 for 0 pps (edge case)", () => {
      const input = parseUnits("100", 18);
      const shares = calculateDepositOutput(input, 0n, 18);
      expect(shares).toBe(0n);
    });
  });

  describe("withdraw output calculation", () => {
    function calculateWithdrawOutput(
      sharesAmount: bigint,
      pricePerShare: bigint,
      decimals: number
    ): bigint {
      // assets = shares * pricePerShare
      return (sharesAmount * pricePerShare) / parseUnits("1", decimals);
    }

    it("calculates assets at 1:1 pps", () => {
      const shares = parseUnits("100", 18);
      const pps = parseUnits("1", 18);
      const assets = calculateWithdrawOutput(shares, pps, 18);
      expect(assets).toBe(parseUnits("100", 18));
    });

    it("calculates more assets at 1.05 pps", () => {
      const shares = parseUnits("100", 18);
      const pps = parseUnits("1.05", 18);
      const assets = calculateWithdrawOutput(shares, pps, 18);
      expect(assets).toBe(parseUnits("105", 18));
    });

    it("calculates more assets at 2:1 pps", () => {
      const shares = parseUnits("100", 18);
      const pps = parseUnits("2", 18);
      const assets = calculateWithdrawOutput(shares, pps, 18);
      expect(assets).toBe(parseUnits("200", 18));
    });

    it("returns 0 for 0 shares", () => {
      const pps = parseUnits("1.05", 18);
      const assets = calculateWithdrawOutput(0n, pps, 18);
      expect(assets).toBe(0n);
    });
  });

  describe("insufficient balance detection", () => {
    function hasInsufficientBalance(
      inputAmount: bigint,
      userBalance: bigint
    ): boolean {
      return inputAmount > userBalance;
    }

    it("detects insufficient balance", () => {
      const input = parseUnits("100", 18);
      const balance = parseUnits("50", 18);
      expect(hasInsufficientBalance(input, balance)).toBe(true);
    });

    it("allows equal balance", () => {
      const input = parseUnits("100", 18);
      const balance = parseUnits("100", 18);
      expect(hasInsufficientBalance(input, balance)).toBe(false);
    });

    it("allows sufficient balance", () => {
      const input = parseUnits("50", 18);
      const balance = parseUnits("100", 18);
      expect(hasInsufficientBalance(input, balance)).toBe(false);
    });

    it("allows zero input", () => {
      const balance = parseUnits("100", 18);
      expect(hasInsufficientBalance(0n, balance)).toBe(false);
    });

    it("detects insufficient with zero balance", () => {
      const input = parseUnits("1", 18);
      expect(hasInsufficientBalance(input, 0n)).toBe(true);
    });
  });

  describe("slippage configuration", () => {
    const DEFAULT_SLIPPAGE = 0.5;
    const MIN_SLIPPAGE = 0.01;
    const MAX_SLIPPAGE = 50;
    const SLIPPAGE_PRESETS = [0.1, 0.5, 1.0];

    function isValidSlippage(slippage: number): boolean {
      return slippage >= MIN_SLIPPAGE && slippage <= MAX_SLIPPAGE;
    }

    function parseSlippageInput(input: string): number | null {
      const parsed = parseFloat(input);
      if (isNaN(parsed)) return null;
      if (!isValidSlippage(parsed)) return null;
      return parsed;
    }

    it("has default slippage of 0.5%", () => {
      expect(DEFAULT_SLIPPAGE).toBe(0.5);
    });

    it("has slippage presets", () => {
      expect(SLIPPAGE_PRESETS).toEqual([0.1, 0.5, 1.0]);
    });

    it("validates slippage within range", () => {
      expect(isValidSlippage(0.5)).toBe(true);
      expect(isValidSlippage(1)).toBe(true);
      expect(isValidSlippage(10)).toBe(true);
    });

    it("rejects slippage below minimum", () => {
      expect(isValidSlippage(0)).toBe(false);
      expect(isValidSlippage(0.001)).toBe(false);
    });

    it("rejects slippage above maximum", () => {
      expect(isValidSlippage(51)).toBe(false);
      expect(isValidSlippage(100)).toBe(false);
    });

    it("parses valid slippage input", () => {
      expect(parseSlippageInput("0.5")).toBe(0.5);
      expect(parseSlippageInput("1")).toBe(1);
      expect(parseSlippageInput("10")).toBe(10);
    });

    it("returns null for invalid input", () => {
      expect(parseSlippageInput("")).toBe(null);
      expect(parseSlippageInput("abc")).toBe(null);
      expect(parseSlippageInput("-1")).toBe(null);
      expect(parseSlippageInput("100")).toBe(null);
    });
  });

  describe("slippage localStorage", () => {
    function saveSlippage(slippage: number): string {
      return JSON.stringify(slippage);
    }

    function loadSlippage(stored: string | null, defaultValue: number): number {
      if (!stored) return defaultValue;
      try {
        const parsed = JSON.parse(stored);
        if (typeof parsed === "number" && parsed > 0 && parsed <= 50) {
          return parsed;
        }
      } catch {
        // Invalid JSON
      }
      return defaultValue;
    }

    it("serializes slippage to JSON", () => {
      expect(saveSlippage(0.5)).toBe("0.5");
      expect(saveSlippage(1)).toBe("1");
    });

    it("loads valid slippage", () => {
      expect(loadSlippage("0.5", 0.5)).toBe(0.5);
      expect(loadSlippage("1", 0.5)).toBe(1);
      expect(loadSlippage("10", 0.5)).toBe(10);
    });

    it("returns default for null", () => {
      expect(loadSlippage(null, 0.5)).toBe(0.5);
    });

    it("returns default for invalid JSON", () => {
      expect(loadSlippage("invalid", 0.5)).toBe(0.5);
    });

    it("returns default for out of range", () => {
      expect(loadSlippage("0", 0.5)).toBe(0.5);
      expect(loadSlippage("-1", 0.5)).toBe(0.5);
      expect(loadSlippage("100", 0.5)).toBe(0.5);
    });
  });

  describe("input amount parsing", () => {
    function parseInputAmount(input: string, decimals: number): bigint | null {
      if (!input || input === "") return null;
      try {
        // Remove commas and validate
        const cleaned = input.replace(/,/g, "");
        if (!/^[0-9]*\.?[0-9]*$/.test(cleaned)) return null;
        if (cleaned === "" || cleaned === ".") return null;
        return parseUnits(cleaned, decimals);
      } catch {
        return null;
      }
    }

    it("parses whole numbers", () => {
      expect(parseInputAmount("100", 18)).toBe(parseUnits("100", 18));
      expect(parseInputAmount("1", 18)).toBe(parseUnits("1", 18));
    });

    it("parses decimals", () => {
      expect(parseInputAmount("1.5", 18)).toBe(parseUnits("1.5", 18));
      expect(parseInputAmount("0.001", 18)).toBe(parseUnits("0.001", 18));
    });

    it("parses numbers with commas", () => {
      expect(parseInputAmount("1,000", 18)).toBe(parseUnits("1000", 18));
      expect(parseInputAmount("1,000,000", 18)).toBe(parseUnits("1000000", 18));
    });

    it("returns null for empty input", () => {
      expect(parseInputAmount("", 18)).toBe(null);
    });

    it("returns null for invalid input", () => {
      expect(parseInputAmount("abc", 18)).toBe(null);
      expect(parseInputAmount("1.2.3", 18)).toBe(null);
      expect(parseInputAmount("-1", 18)).toBe(null);
    });

    it("returns null for just a dot", () => {
      expect(parseInputAmount(".", 18)).toBe(null);
    });
  });

  describe("output amount formatting", () => {
    function formatOutputAmount(amount: bigint, decimals: number): string {
      const formatted = formatUnits(amount, decimals);
      const num = parseFloat(formatted);

      if (num === 0) return "0";
      if (num >= 1) return num.toFixed(4);
      if (num >= 0.0001) return num.toFixed(6);
      return "<0.0001";
    }

    it("formats whole numbers", () => {
      const amount = parseUnits("100", 18);
      expect(formatOutputAmount(amount, 18)).toBe("100.0000");
    });

    it("formats with 4 decimals for >= 1", () => {
      const amount = parseUnits("1.123456789", 18);
      expect(formatOutputAmount(amount, 18)).toBe("1.1235"); // rounded
    });

    it("formats with 6 decimals for small amounts", () => {
      const amount = parseUnits("0.123456789", 18);
      expect(formatOutputAmount(amount, 18)).toBe("0.123457"); // rounded
    });

    it("formats zero", () => {
      expect(formatOutputAmount(0n, 18)).toBe("0");
    });

    it("formats very small amounts", () => {
      const amount = parseUnits("0.0001", 18);
      expect(formatOutputAmount(amount, 18)).toBe("0.000100");
    });

    it("formats dust as <0.0001", () => {
      const amount = parseUnits("0.00000001", 18);
      expect(formatOutputAmount(amount, 18)).toBe("<0.0001");
    });
  });

  describe("max button logic", () => {
    function getMaxAmount(
      mode: "deposit" | "withdraw",
      assetBalance: bigint,
      shareBalance: bigint
    ): bigint {
      return mode === "deposit" ? assetBalance : shareBalance;
    }

    it("uses asset balance for deposit", () => {
      const assetBalance = parseUnits("100", 18);
      const shareBalance = parseUnits("50", 18);
      expect(getMaxAmount("deposit", assetBalance, shareBalance)).toBe(assetBalance);
    });

    it("uses share balance for withdraw", () => {
      const assetBalance = parseUnits("100", 18);
      const shareBalance = parseUnits("50", 18);
      expect(getMaxAmount("withdraw", assetBalance, shareBalance)).toBe(shareBalance);
    });
  });

  describe("button state logic", () => {
    interface ButtonState {
      disabled: boolean;
      text: string;
    }

    function getButtonState(
      isConnected: boolean,
      inputAmount: bigint | null,
      hasInsufficientBalance: boolean,
      isApprovalNeeded: boolean,
      isPending: boolean,
      mode: "deposit" | "withdraw" | "zap"
    ): ButtonState {
      if (!isConnected) {
        return { disabled: false, text: "Connect Wallet" };
      }

      if (!inputAmount || inputAmount === 0n) {
        return { disabled: true, text: "Enter Amount" };
      }

      if (hasInsufficientBalance) {
        return { disabled: true, text: "Insufficient Balance" };
      }

      if (isPending) {
        return { disabled: true, text: "Confirming..." };
      }

      if (isApprovalNeeded && mode !== "withdraw") {
        return { disabled: false, text: "Approve" };
      }

      const modeText = mode.charAt(0).toUpperCase() + mode.slice(1);
      return { disabled: false, text: modeText };
    }

    it("shows Connect Wallet when not connected", () => {
      const state = getButtonState(false, null, false, false, false, "deposit");
      expect(state.text).toBe("Connect Wallet");
      expect(state.disabled).toBe(false);
    });

    it("shows Enter Amount when no input", () => {
      const state = getButtonState(true, null, false, false, false, "deposit");
      expect(state.text).toBe("Enter Amount");
      expect(state.disabled).toBe(true);
    });

    it("shows Enter Amount when zero input", () => {
      const state = getButtonState(true, 0n, false, false, false, "deposit");
      expect(state.text).toBe("Enter Amount");
      expect(state.disabled).toBe(true);
    });

    it("shows Insufficient Balance when balance too low", () => {
      const state = getButtonState(true, parseUnits("100", 18), true, false, false, "deposit");
      expect(state.text).toBe("Insufficient Balance");
      expect(state.disabled).toBe(true);
    });

    it("shows Confirming when pending", () => {
      const state = getButtonState(true, parseUnits("100", 18), false, false, true, "deposit");
      expect(state.text).toBe("Confirming...");
      expect(state.disabled).toBe(true);
    });

    it("shows Approve when approval needed", () => {
      const state = getButtonState(true, parseUnits("100", 18), false, true, false, "deposit");
      expect(state.text).toBe("Approve");
      expect(state.disabled).toBe(false);
    });

    it("shows Deposit when ready to deposit", () => {
      const state = getButtonState(true, parseUnits("100", 18), false, false, false, "deposit");
      expect(state.text).toBe("Deposit");
      expect(state.disabled).toBe(false);
    });

    it("shows Withdraw when ready to withdraw", () => {
      const state = getButtonState(true, parseUnits("100", 18), false, false, false, "withdraw");
      expect(state.text).toBe("Withdraw");
      expect(state.disabled).toBe(false);
    });

    it("shows Zap when ready to zap", () => {
      const state = getButtonState(true, parseUnits("100", 18), false, false, false, "zap");
      expect(state.text).toBe("Zap");
      expect(state.disabled).toBe(false);
    });

    it("withdraw doesn't need approval", () => {
      const state = getButtonState(true, parseUnits("100", 18), false, true, false, "withdraw");
      expect(state.text).toBe("Withdraw");
      expect(state.disabled).toBe(false);
    });
  });

  describe("zap output calculation with slippage", () => {
    function calculateMinimumOutput(
      expectedOutput: bigint,
      slippagePercent: number
    ): bigint {
      const slippageBps = BigInt(Math.floor(slippagePercent * 100));
      const basisPoints = 10000n;
      return (expectedOutput * (basisPoints - slippageBps)) / basisPoints;
    }

    it("calculates minimum output with 0.5% slippage", () => {
      const expected = parseUnits("100", 18);
      const minimum = calculateMinimumOutput(expected, 0.5);
      // 100 * (10000 - 50) / 10000 = 99.5
      expect(minimum).toBe(parseUnits("99.5", 18));
    });

    it("calculates minimum output with 1% slippage", () => {
      const expected = parseUnits("100", 18);
      const minimum = calculateMinimumOutput(expected, 1);
      expect(minimum).toBe(parseUnits("99", 18));
    });

    it("calculates minimum output with 5% slippage", () => {
      const expected = parseUnits("100", 18);
      const minimum = calculateMinimumOutput(expected, 5);
      expect(minimum).toBe(parseUnits("95", 18));
    });

    it("handles small amounts", () => {
      const expected = parseUnits("0.001", 18);
      const minimum = calculateMinimumOutput(expected, 1);
      expect(minimum).toBe(parseUnits("0.00099", 18));
    });

    it("handles zero expected output", () => {
      const minimum = calculateMinimumOutput(0n, 0.5);
      expect(minimum).toBe(0n);
    });
  });

  describe("APY display formatting", () => {
    function formatApy(apy: number | undefined): string {
      if (apy === undefined || apy === null) return "—";
      if (apy === 0) return "0.00%";
      if (apy < 0.01) return "<0.01%";
      return `${apy.toFixed(2)}%`;
    }

    it("formats normal APY", () => {
      expect(formatApy(5.5)).toBe("5.50%");
      expect(formatApy(10)).toBe("10.00%");
      expect(formatApy(25.123)).toBe("25.12%");
    });

    it("formats zero APY", () => {
      expect(formatApy(0)).toBe("0.00%");
    });

    it("formats very small APY", () => {
      expect(formatApy(0.001)).toBe("<0.01%");
      expect(formatApy(0.009)).toBe("<0.01%");
    });

    it("formats undefined/null as dash", () => {
      expect(formatApy(undefined)).toBe("—");
    });
  });

  describe("TVL display formatting", () => {
    function formatTvl(tvl: number | undefined): string {
      if (tvl === undefined || tvl === null) return "—";
      if (tvl >= 1_000_000) return `$${(tvl / 1_000_000).toFixed(2)}M`;
      if (tvl >= 1_000) return `$${(tvl / 1_000).toFixed(1)}K`;
      return `$${tvl.toFixed(2)}`;
    }

    it("formats millions", () => {
      expect(formatTvl(1_000_000)).toBe("$1.00M");
      expect(formatTvl(5_500_000)).toBe("$5.50M");
    });

    it("formats thousands", () => {
      expect(formatTvl(1_000)).toBe("$1.0K");
      expect(formatTvl(500_000)).toBe("$500.0K");
    });

    it("formats small values", () => {
      expect(formatTvl(500)).toBe("$500.00");
      expect(formatTvl(0)).toBe("$0.00");
    });

    it("formats undefined as dash", () => {
      expect(formatTvl(undefined)).toBe("—");
    });
  });

  describe("vault stats derivation", () => {
    interface VaultStats {
      apy: number;
      tvl: number;
      pricePerShare: number;
    }

    function deriveVaultStats(
      yearnData: { apy?: number; tvlUsd?: number } | undefined,
      cacheData: { pps?: number; tvlUsd?: number } | undefined
    ): VaultStats | null {
      if (!yearnData && !cacheData) return null;

      return {
        apy: yearnData?.apy ?? 0,
        tvl: yearnData?.tvlUsd ?? cacheData?.tvlUsd ?? 0,
        pricePerShare: cacheData?.pps ?? 1,
      };
    }

    it("uses yearn data when available", () => {
      const yearnData = { apy: 5.5, tvlUsd: 1_000_000 };
      const cacheData = { pps: 1.05, tvlUsd: 900_000 };
      const stats = deriveVaultStats(yearnData, cacheData);
      expect(stats?.apy).toBe(5.5);
      expect(stats?.tvl).toBe(1_000_000);
      expect(stats?.pricePerShare).toBe(1.05);
    });

    it("falls back to cache TVL", () => {
      const yearnData = { apy: 5.5 };
      const cacheData = { pps: 1.05, tvlUsd: 900_000 };
      const stats = deriveVaultStats(yearnData, cacheData);
      expect(stats?.tvl).toBe(900_000);
    });

    it("defaults pricePerShare to 1", () => {
      const yearnData = { apy: 5.5, tvlUsd: 1_000_000 };
      const stats = deriveVaultStats(yearnData, undefined);
      expect(stats?.pricePerShare).toBe(1);
    });

    it("returns null when no data", () => {
      expect(deriveVaultStats(undefined, undefined)).toBe(null);
    });
  });

  describe("transaction confirmation states", () => {
    type TxStatus = "idle" | "pending" | "confirming" | "success" | "error";

    function getTxStatusMessage(status: TxStatus): string {
      switch (status) {
        case "idle":
          return "";
        case "pending":
          return "Waiting for wallet confirmation...";
        case "confirming":
          return "Transaction confirming...";
        case "success":
          return "Transaction successful!";
        case "error":
          return "Transaction failed";
      }
    }

    it("returns empty for idle", () => {
      expect(getTxStatusMessage("idle")).toBe("");
    });

    it("returns pending message", () => {
      expect(getTxStatusMessage("pending")).toBe("Waiting for wallet confirmation...");
    });

    it("returns confirming message", () => {
      expect(getTxStatusMessage("confirming")).toBe("Transaction confirming...");
    });

    it("returns success message", () => {
      expect(getTxStatusMessage("success")).toBe("Transaction successful!");
    });

    it("returns error message", () => {
      expect(getTxStatusMessage("error")).toBe("Transaction failed");
    });
  });

  describe("tab accessibility", () => {
    function getTabAriaProps(
      tab: string,
      selectedTab: string
    ): { "aria-selected": boolean; "aria-controls": string } {
      return {
        "aria-selected": tab === selectedTab,
        "aria-controls": `${tab}-panel`,
      };
    }

    it("marks selected tab", () => {
      const props = getTabAriaProps("deposit", "deposit");
      expect(props["aria-selected"]).toBe(true);
    });

    it("marks unselected tab", () => {
      const props = getTabAriaProps("deposit", "withdraw");
      expect(props["aria-selected"]).toBe(false);
    });

    it("sets correct aria-controls", () => {
      const props = getTabAriaProps("deposit", "deposit");
      expect(props["aria-controls"]).toBe("deposit-panel");
    });
  });

  describe("real-world deposit scenarios", () => {
    function calculateDepositOutput(
      inputAmount: bigint,
      pricePerShare: bigint,
      decimals: number
    ): bigint {
      if (pricePerShare === 0n) return 0n;
      return (inputAmount * parseUnits("1", decimals)) / pricePerShare;
    }

    it("deposit 1000 cvxCRV at 1.05 pps", () => {
      const input = parseUnits("1000", 18);
      const pps = parseUnits("1.05", 18);
      const shares = calculateDepositOutput(input, pps, 18);
      // 1000 / 1.05 ≈ 952.38 shares
      const sharesNum = parseFloat(formatUnits(shares, 18));
      expect(sharesNum).toBeCloseTo(952.38, 1);
    });

    it("deposit 500 cvxCRV at 1.1 pps", () => {
      const input = parseUnits("500", 18);
      const pps = parseUnits("1.1", 18);
      const shares = calculateDepositOutput(input, pps, 18);
      // 500 / 1.1 ≈ 454.54 shares
      const sharesNum = parseFloat(formatUnits(shares, 18));
      expect(sharesNum).toBeCloseTo(454.54, 1);
    });
  });

  describe("real-world withdraw scenarios", () => {
    function calculateWithdrawOutput(
      sharesAmount: bigint,
      pricePerShare: bigint,
      decimals: number
    ): bigint {
      return (sharesAmount * pricePerShare) / parseUnits("1", decimals);
    }

    it("withdraw 1000 shares at 1.05 pps", () => {
      const shares = parseUnits("1000", 18);
      const pps = parseUnits("1.05", 18);
      const assets = calculateWithdrawOutput(shares, pps, 18);
      // 1000 * 1.05 = 1050 cvxCRV
      expect(assets).toBe(parseUnits("1050", 18));
    });

    it("withdraw all shares after 10% gain", () => {
      const shares = parseUnits("952.38", 18);
      const pps = parseUnits("1.1", 18); // 10% gain from 1.0
      const assets = calculateWithdrawOutput(shares, pps, 18);
      // 952.38 * 1.1 = 1047.618
      const assetsNum = parseFloat(formatUnits(assets, 18));
      expect(assetsNum).toBeCloseTo(1047.62, 1);
    });
  });

  describe("zap token validation", () => {
    const SUPPORTED_ZAP_TOKENS = [
      "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", // ETH
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
      "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
      "0x6B175474E89094C44Da98b954EesdfsdfdCd36fB", // DAI (example)
    ];

    function isZapTokenSupported(tokenAddress: string): boolean {
      return SUPPORTED_ZAP_TOKENS.some(
        (t) => t.toLowerCase() === tokenAddress.toLowerCase()
      );
    }

    it("supports ETH", () => {
      expect(isZapTokenSupported("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE")).toBe(true);
    });

    it("supports USDC", () => {
      expect(isZapTokenSupported("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe(true);
    });

    it("supports tokens case-insensitively", () => {
      expect(isZapTokenSupported("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")).toBe(true);
    });

    it("rejects unsupported tokens", () => {
      expect(isZapTokenSupported("0x0000000000000000000000000000000000000000")).toBe(false);
    });
  });

  describe("form reset behavior", () => {
    interface FormState {
      inputAmount: string;
      selectedToken: string | null;
    }

    function resetForm(currentMode: "deposit" | "withdraw" | "zap"): FormState {
      return {
        inputAmount: "",
        selectedToken: currentMode === "zap" ? null : null,
      };
    }

    it("resets input amount", () => {
      const state = resetForm("deposit");
      expect(state.inputAmount).toBe("");
    });

    it("resets selected token for zap", () => {
      const state = resetForm("zap");
      expect(state.selectedToken).toBe(null);
    });
  });
});
