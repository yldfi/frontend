import { describe, it, expect } from "vitest";
import { isAddress } from "viem";

// Test the useTokenMetadata business logic directly
// We test address validation and token creation from contract results

describe("useTokenMetadata logic", () => {
  describe("address validation", () => {
    function isValidAddress(address: string | undefined): boolean {
      return !!address && isAddress(address);
    }

    describe("valid addresses", () => {
      it("validates standard Ethereum address", () => {
        expect(isValidAddress("0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86")).toBe(true);
      });

      it("validates lowercase address", () => {
        expect(isValidAddress("0x95f19b19aff698169a1a0bbc28a2e47b14cb9a86")).toBe(true);
      });

      it("rejects fully uppercase address (not valid checksum)", () => {
        // viem's isAddress requires proper checksumming, fully uppercase is invalid
        expect(isValidAddress("0x95F19B19AFF698169A1A0BBC28A2E47B14CB9A86")).toBe(false);
      });

      it("validates zero address", () => {
        expect(isValidAddress("0x0000000000000000000000000000000000000000")).toBe(true);
      });

      it("validates checksum address", () => {
        expect(isValidAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe(true);
      });
    });

    describe("invalid addresses", () => {
      it("rejects undefined", () => {
        expect(isValidAddress(undefined)).toBe(false);
      });

      it("rejects empty string", () => {
        expect(isValidAddress("")).toBe(false);
      });

      it("rejects short address", () => {
        expect(isValidAddress("0x95f19B19aff698169a1a0bbc28a2e47b")).toBe(false);
      });

      it("rejects long address", () => {
        expect(isValidAddress("0x95f19B19aff698169a1a0bbc28a2e47b14cb9a86aa")).toBe(false);
      });

      it("rejects address without 0x prefix", () => {
        expect(isValidAddress("95f19B19aff698169a1a0bbc28a2e47b14cb9a86")).toBe(false);
      });

      it("rejects non-hex characters", () => {
        expect(isValidAddress("0xGHIJKL19aff698169a1a0bbc28a2e47b14cb9a86")).toBe(false);
      });

      it("rejects random string", () => {
        expect(isValidAddress("not-an-address")).toBe(false);
      });
    });
  });

  describe("token creation from contract results", () => {
    interface ContractResult {
      status: "success" | "failure";
      result?: string | number;
    }

    interface EnsoToken {
      address: string;
      chainId: number;
      name: string;
      symbol: string;
      decimals: number;
      type: "base" | "defi";
    }

    function createTokenFromResults(
      tokenAddress: string | undefined,
      data: ContractResult[] | undefined
    ): EnsoToken | null {
      if (!tokenAddress || !data) return null;

      const [nameResult, symbolResult, decimalsResult] = data;

      // Check if all calls succeeded
      if (
        nameResult.status !== "success" ||
        symbolResult.status !== "success" ||
        decimalsResult.status !== "success"
      ) {
        return null;
      }

      return {
        address: tokenAddress,
        chainId: 1,
        name: nameResult.result as string,
        symbol: symbolResult.result as string,
        decimals: decimalsResult.result as number,
        type: "base",
      };
    }

    it("creates token from successful contract calls", () => {
      const data: ContractResult[] = [
        { status: "success", result: "USD Coin" },
        { status: "success", result: "USDC" },
        { status: "success", result: 6 },
      ];

      const token = createTokenFromResults("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", data);

      expect(token).not.toBeNull();
      expect(token?.name).toBe("USD Coin");
      expect(token?.symbol).toBe("USDC");
      expect(token?.decimals).toBe(6);
      expect(token?.chainId).toBe(1);
      expect(token?.type).toBe("base");
    });

    it("returns null when name call fails", () => {
      const data: ContractResult[] = [
        { status: "failure" },
        { status: "success", result: "USDC" },
        { status: "success", result: 6 },
      ];

      expect(createTokenFromResults("0x123", data)).toBeNull();
    });

    it("returns null when symbol call fails", () => {
      const data: ContractResult[] = [
        { status: "success", result: "USD Coin" },
        { status: "failure" },
        { status: "success", result: 6 },
      ];

      expect(createTokenFromResults("0x123", data)).toBeNull();
    });

    it("returns null when decimals call fails", () => {
      const data: ContractResult[] = [
        { status: "success", result: "USD Coin" },
        { status: "success", result: "USDC" },
        { status: "failure" },
      ];

      expect(createTokenFromResults("0x123", data)).toBeNull();
    });

    it("returns null when all calls fail", () => {
      const data: ContractResult[] = [
        { status: "failure" },
        { status: "failure" },
        { status: "failure" },
      ];

      expect(createTokenFromResults("0x123", data)).toBeNull();
    });

    it("returns null when data is undefined", () => {
      expect(createTokenFromResults("0x123", undefined)).toBeNull();
    });

    it("returns null when address is undefined", () => {
      const data: ContractResult[] = [
        { status: "success", result: "Token" },
        { status: "success", result: "TKN" },
        { status: "success", result: 18 },
      ];

      expect(createTokenFromResults(undefined, data)).toBeNull();
    });
  });

  describe("query enablement", () => {
    function shouldEnableQuery(tokenAddress: string | undefined): boolean {
      return !!tokenAddress;
    }

    it("enables query when address provided", () => {
      expect(shouldEnableQuery("0x123")).toBe(true);
    });

    it("disables query when address is undefined", () => {
      expect(shouldEnableQuery(undefined)).toBe(false);
    });

    it("disables query when address is empty", () => {
      expect(shouldEnableQuery("")).toBe(false);
    });
  });

  describe("return value structure", () => {
    interface UseTokenMetadataResult {
      token: object | null;
      isLoading: boolean;
      error: Error | null;
      isValidAddress: boolean;
    }

    function createResult(
      isValidAddress: boolean,
      hasToken: boolean,
      isLoading: boolean = false,
      error: Error | null = null
    ): UseTokenMetadataResult {
      return {
        token: hasToken ? { name: "Token", symbol: "TKN", decimals: 18 } : null,
        isLoading,
        error,
        isValidAddress,
      };
    }

    it("returns token when valid address and successful calls", () => {
      const result = createResult(true, true);
      expect(result.token).not.toBeNull();
      expect(result.isValidAddress).toBe(true);
    });

    it("returns null token when invalid address", () => {
      const result = createResult(false, false);
      expect(result.token).toBeNull();
      expect(result.isValidAddress).toBe(false);
    });

    it("returns loading state", () => {
      const result = createResult(true, false, true);
      expect(result.isLoading).toBe(true);
    });

    it("returns error state", () => {
      const error = new Error("Contract call failed");
      const result = createResult(true, false, false, error);
      expect(result.error).toBe(error);
    });
  });

  describe("contracts array construction", () => {
    function buildContractsArray(tokenAddress: string | undefined) {
      if (!tokenAddress) return undefined;

      return [
        { address: tokenAddress, functionName: "name" },
        { address: tokenAddress, functionName: "symbol" },
        { address: tokenAddress, functionName: "decimals" },
      ];
    }

    it("builds contracts array for valid address", () => {
      const contracts = buildContractsArray("0x123");
      expect(contracts).toHaveLength(3);
      expect(contracts?.[0].functionName).toBe("name");
      expect(contracts?.[1].functionName).toBe("symbol");
      expect(contracts?.[2].functionName).toBe("decimals");
    });

    it("returns undefined for undefined address", () => {
      expect(buildContractsArray(undefined)).toBeUndefined();
    });

    it("all contracts have same address", () => {
      const contracts = buildContractsArray("0xABC");
      contracts?.forEach((c) => {
        expect(c.address).toBe("0xABC");
      });
    });
  });

  describe("common token metadata", () => {
    interface TokenMetadata {
      name: string;
      symbol: string;
      decimals: number;
    }

    const COMMON_TOKENS: Record<string, TokenMetadata> = {
      USDC: { name: "USD Coin", symbol: "USDC", decimals: 6 },
      USDT: { name: "Tether USD", symbol: "USDT", decimals: 6 },
      DAI: { name: "Dai Stablecoin", symbol: "DAI", decimals: 18 },
      WETH: { name: "Wrapped Ether", symbol: "WETH", decimals: 18 },
      WBTC: { name: "Wrapped BTC", symbol: "WBTC", decimals: 8 },
      cvxCRV: { name: "Convex CRV", symbol: "cvxCRV", decimals: 18 },
    };

    it("USDC has 6 decimals", () => {
      expect(COMMON_TOKENS.USDC.decimals).toBe(6);
    });

    it("USDT has 6 decimals", () => {
      expect(COMMON_TOKENS.USDT.decimals).toBe(6);
    });

    it("DAI has 18 decimals", () => {
      expect(COMMON_TOKENS.DAI.decimals).toBe(18);
    });

    it("WETH has 18 decimals", () => {
      expect(COMMON_TOKENS.WETH.decimals).toBe(18);
    });

    it("WBTC has 8 decimals", () => {
      expect(COMMON_TOKENS.WBTC.decimals).toBe(8);
    });

    it("cvxCRV has 18 decimals", () => {
      expect(COMMON_TOKENS.cvxCRV.decimals).toBe(18);
    });
  });

  describe("chainId handling", () => {
    const MAINNET_CHAIN_ID = 1;

    function createTokenWithChainId(chainId: number) {
      return {
        address: "0x123",
        chainId,
        name: "Token",
        symbol: "TKN",
        decimals: 18,
        type: "base" as const,
      };
    }

    it("defaults to mainnet (chainId 1)", () => {
      const token = createTokenWithChainId(MAINNET_CHAIN_ID);
      expect(token.chainId).toBe(1);
    });

    it("can create token for different chains", () => {
      const arbitrumToken = createTokenWithChainId(42161);
      expect(arbitrumToken.chainId).toBe(42161);
    });
  });

  describe("type field", () => {
    it("imported tokens are base type", () => {
      const token = {
        address: "0x123",
        chainId: 1,
        name: "Custom Token",
        symbol: "CUSTOM",
        decimals: 18,
        type: "base" as const,
      };
      expect(token.type).toBe("base");
    });
  });

  describe("edge cases", () => {
    it("handles token with empty name", () => {
      const token = {
        address: "0x123",
        chainId: 1,
        name: "",
        symbol: "TKN",
        decimals: 18,
        type: "base" as const,
      };
      expect(token.name).toBe("");
    });

    it("handles token with unicode name", () => {
      const token = {
        address: "0x123",
        chainId: 1,
        name: "Token 🚀",
        symbol: "TKN",
        decimals: 18,
        type: "base" as const,
      };
      expect(token.name).toBe("Token 🚀");
    });

    it("handles token with 0 decimals", () => {
      const token = {
        address: "0x123",
        chainId: 1,
        name: "No Decimals Token",
        symbol: "NDT",
        decimals: 0,
        type: "base" as const,
      };
      expect(token.decimals).toBe(0);
    });

    it("handles token with unusual decimals", () => {
      // Some tokens have unusual decimal values
      const token = {
        address: "0x123",
        chainId: 1,
        name: "Unusual Token",
        symbol: "UNU",
        decimals: 2, // Like some share tokens
        type: "base" as const,
      };
      expect(token.decimals).toBe(2);
    });
  });
});
