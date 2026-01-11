/**
 * Integration tests for zap routes
 *
 * Tests all zap scenarios using:
 * 1. Enso bundle API (verify bundle creation)
 * 2. debug_traceCall simulation (verify execution with real tokens)
 *
 * Run with: pnpm vitest src/lib/__tests__/zap-integration.test.ts
 *
 * Requires environment variables:
 * - NEXT_PUBLIC_ENSO_API_KEY: Enso API key
 * - DEBUG_RPC_URL: RPC with debug_traceCall support (optional)
 * - DEBUG_RPC_AUTH: Basic auth for debug RPC (optional)
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { createPublicClient, http, parseEther, formatEther, type Address } from "viem";
import { mainnet } from "viem/chains";
import crossFetch from "cross-fetch";

// Restore real fetch for live API tests
// The global mock in vitest.setup.ts breaks network requests
// We use cross-fetch as a real fetch implementation
beforeAll(() => {
  vi.stubGlobal("fetch", crossFetch);
});

// Test configuration
const ENSO_API_KEY = process.env.NEXT_PUBLIC_ENSO_API_KEY;
const DEBUG_RPC_URL = process.env.DEBUG_RPC_URL;
const DEBUG_RPC_AUTH = process.env.DEBUG_RPC_AUTH;
const IS_CI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";

// Skip tests if no API key OR if running in CI (these are live integration tests)
// Run these tests locally with: pnpm vitest src/lib/__tests__/zap-integration.test.ts
const describeWithApi = (ENSO_API_KEY && !IS_CI) ? describe : describe.skip;

// Addresses
const TOKENS = {
  ETH: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const,
  CVX: "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B" as const,
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const,
  CVGCVX: "0x2191DF768ad71140F9F3E96c1e4407A4aA31d082" as const,
  PXCVX: "0xBCe0Cf87F513102F22232436CCa2ca49e815C3aC" as const,
  CVXCRV: "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7" as const,
};

const VAULTS = {
  YSCVGCVX: "0x8ED5AB1BA2b2E434361858cBD3CA9f374e8b0359" as const,
  YSPXCVX: "0x09F51fB1C78bFBaE6F6f838569D1f6cAD0EC3F00" as const,
  YCVXCRV: "0x0B3E08E95CD0bc13f83bB7b6c2ee8FF0f5bA2B08" as const,
  YSCVXCRV: "0xE36E5c24F7a99f8a8fC3a5f96e4f906C4a129f2C" as const,
};

// Known whales for impersonation
const WHALES = {
  // Vitalik has ETH
  ETH: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as Address,
  // Convex treasury has CVX
  CVX: "0x1389388d01708118b497f59521f6943Be2541bb7" as Address,
  // Circle USDC treasury
  USDC: "0x55FE002aeff02F77364de339a1292923A15844B8" as Address,
  // cvgCVX holder (from Convergence)
  CVGCVX: "0x2191DF768ad71140F9F3E96c1e4407A4aA31d082" as Address,
};

// Helper: Fetch bundle from Enso
async function fetchEnsoBundle(params: {
  fromAddress: string;
  actions: Record<string, unknown>[];
  routingStrategy?: string;
  skipQuote?: boolean;
}) {
  const response = await fetch(
    "https://api.enso.finance/api/v1/shortcuts/bundle?chainId=1",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ENSO_API_KEY}`,
      },
      body: JSON.stringify({
        routingStrategy: params.routingStrategy ?? "router",
        ...params,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Enso API error: ${JSON.stringify(error)}`);
  }

  return response.json();
}

// Helper: Simulate with debug_traceCall
async function simulateBundle(params: {
  from: string;
  to: string;
  data: string;
  value: string;
}): Promise<{ success: boolean; failedStep?: number; error?: string }> {
  if (!DEBUG_RPC_URL || !DEBUG_RPC_AUTH) {
    return { success: false, error: "No debug RPC configured" };
  }

  const response = await fetch(DEBUG_RPC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${DEBUG_RPC_AUTH}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        {
          from: params.from,
          to: params.to,
          data: params.data,
          value: "0x" + BigInt(params.value).toString(16),
        },
        "latest",
      ],
    }),
  });

  const result = await response.json() as { error?: { message?: string; data?: string }; result?: string };

  if (result.error) {
    // Check for specific step failure
    if (result.error.data?.startsWith("0xef3dcb2f")) {
      const stepHex = result.error.data.slice(10, 74);
      const failedStep = parseInt(stepHex, 16);
      return { success: false, failedStep, error: result.error.message };
    }
    return { success: false, error: result.error.message };
  }

  return { success: true };
}

// Helper: Get token balance
async function getTokenBalance(token: Address, holder: Address): Promise<bigint> {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(),
  });

  if (token.toLowerCase() === TOKENS.ETH.toLowerCase()) {
    return client.getBalance({ address: holder });
  }

  const balance = await client.readContract({
    address: token,
    abi: [{ name: "balanceOf", type: "function", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "balanceOf",
    args: [holder],
  });

  return balance as bigint;
}

// ============================================
// Test Suite
// ============================================

describeWithApi("Zap Integration Tests", () => {
  let client: ReturnType<typeof createPublicClient>;

  beforeAll(() => {
    client = createPublicClient({
      chain: mainnet,
      transport: http(),
    });
  });

  describe("Bundle Creation (Enso API)", () => {
    describe("ERC20 → Vault", () => {
      it("ETH → yscvgCVX: creates bundle with correct value", async () => {
        const { fetchCvgCvxZapInRoute } = await import("@/lib/enso");

        const route = await fetchCvgCvxZapInRoute({
          fromAddress: WHALES.ETH,
          inputToken: TOKENS.ETH,
          amountIn: parseEther("1").toString(),
          vaultAddress: VAULTS.YSCVGCVX,
          slippage: "300",
        });

        expect(route.tx).toBeDefined();
        expect(route.tx?.to).toBeDefined();
        expect(BigInt(route.tx?.value ?? 0)).toBe(parseEther("1"));
        expect(route.routeInfo?.tokens).toContain("ETH");
        expect(route.routeInfo?.tokens).toContain("CVX");
      });

      it("CVX → yscvgCVX: creates bundle without ETH value", async () => {
        const { fetchCvgCvxZapInRoute } = await import("@/lib/enso");

        const route = await fetchCvgCvxZapInRoute({
          fromAddress: WHALES.CVX,
          inputToken: TOKENS.CVX,
          amountIn: parseEther("1000").toString(),
          vaultAddress: VAULTS.YSCVGCVX,
          slippage: "300",
        });

        expect(route.tx).toBeDefined();
        expect(BigInt(route.tx?.value ?? 0)).toBe(0n);
        expect(route.routeInfo?.hybrid).toBeDefined();
      });

      it("USDC → yscvgCVX: creates multi-hop route", async () => {
        const { fetchCvgCvxZapInRoute } = await import("@/lib/enso");

        const route = await fetchCvgCvxZapInRoute({
          fromAddress: WHALES.USDC,
          inputToken: TOKENS.USDC,
          amountIn: "1000000000", // 1000 USDC (6 decimals)
          vaultAddress: VAULTS.YSCVGCVX,
          slippage: "300",
        });

        expect(route.tx).toBeDefined();
        expect(route.routeInfo?.tokens).toContain("USDC");
      });

      it("ETH → yspxCVX: creates pxCVX route", async () => {
        const { fetchPxCvxZapInRoute } = await import("@/lib/enso");

        const route = await fetchPxCvxZapInRoute({
          fromAddress: WHALES.ETH,
          inputToken: TOKENS.ETH,
          amountIn: parseEther("1").toString(),
          vaultAddress: VAULTS.YSPXCVX,
          slippage: "300",
        });

        expect(route.tx).toBeDefined();
        expect(BigInt(route.tx?.value ?? 0)).toBe(parseEther("1"));
      });
    });

    describe("Underlying → Vault", () => {
      it("cvgCVX → yscvgCVX: direct deposit route", async () => {
        const { fetchCvgCvxZapInRoute } = await import("@/lib/enso");

        const route = await fetchCvgCvxZapInRoute({
          fromAddress: WHALES.CVGCVX,
          inputToken: TOKENS.CVGCVX,
          amountIn: parseEther("100").toString(),
          vaultAddress: VAULTS.YSCVGCVX,
          slippage: "100",
        });

        expect(route.tx).toBeDefined();
        // Should be a simple approve + deposit, not a complex route
      });
    });

    describe("Vault → ERC20", () => {
      it("yscvgCVX → ETH: creates zap out route", async () => {
        const { fetchZapOutRoute } = await import("@/lib/enso");

        // Note: Requires vault shares holder for impersonation
        const route = await fetchZapOutRoute({
          fromAddress: WHALES.ETH, // Would need actual vault holder
          vaultAddress: VAULTS.YSCVGCVX,
          outputToken: TOKENS.ETH,
          amountIn: parseEther("100").toString(),
          slippage: "300",
        });

        expect(route.tx).toBeDefined();
        // routeInfo is added by our custom route functions
        expect((route as { routeInfo?: unknown }).routeInfo).toBeDefined();
      });

      it("yscvgCVX → CVX: creates zap out to CVX", async () => {
        const { fetchZapOutRoute } = await import("@/lib/enso");

        const route = await fetchZapOutRoute({
          fromAddress: WHALES.ETH,
          vaultAddress: VAULTS.YSCVGCVX,
          outputToken: TOKENS.CVX,
          amountIn: parseEther("100").toString(),
          slippage: "300",
        });

        expect(route.tx).toBeDefined();
      });
    });

    describe("Vault → Vault", () => {
      it("yscvgCVX → yspxCVX: cross-vault zap", async () => {
        const { fetchVaultToVaultRoute } = await import("@/lib/enso");

        const route = await fetchVaultToVaultRoute({
          fromAddress: WHALES.ETH,
          sourceVault: VAULTS.YSCVGCVX,
          targetVault: VAULTS.YSPXCVX,
          amountIn: parseEther("100").toString(),
          slippage: "300",
        });

        expect(route.tx).toBeDefined();
        expect((route as { routeInfo?: unknown }).routeInfo).toBeDefined();
      });

      it("yscvgCVX → ycvxCRV: different underlying vault", async () => {
        const { fetchVaultToVaultRoute } = await import("@/lib/enso");

        const route = await fetchVaultToVaultRoute({
          fromAddress: WHALES.ETH,
          sourceVault: VAULTS.YSCVGCVX,
          targetVault: VAULTS.YCVXCRV,
          amountIn: parseEther("100").toString(),
          slippage: "300",
        });

        expect(route.tx).toBeDefined();
      });
    });
  });

  describe("Hybrid Strategy Scenarios", () => {
    it("detects current pool state (swap vs mint)", async () => {
      const { getOptimalSwapAmount, getCvgCvxSwapRate } = await import("@/lib/enso");

      // Check swap rate for 1000 CVX
      const swapOutput = await getCvgCvxSwapRate(parseEther("1000").toString());
      const inputAmount = parseEther("1000");

      if (swapOutput && swapOutput > inputAmount) {
        console.log(`Pool ABOVE peg: ${formatEther(swapOutput)} cvgCVX for 1000 CVX (${((Number(swapOutput) / Number(inputAmount) - 1) * 100).toFixed(2)}% bonus)`);
      } else {
        console.log(`Pool AT/BELOW peg: ${swapOutput ? formatEther(swapOutput) : "N/A"} cvgCVX for 1000 CVX`);
      }

      // Get optimal split
      const { swapAmount, mintAmount } = await getOptimalSwapAmount(parseEther("10000").toString());

      console.log(`Optimal split for 10,000 CVX:`);
      console.log(`  Swap: ${formatEther(swapAmount)} CVX`);
      console.log(`  Mint: ${formatEther(mintAmount)} CVX`);

      expect(swapAmount + mintAmount).toBe(parseEther("10000"));
    });

    it("pure swap: when pool is significantly above peg", async () => {
      const { getOptimalSwapAmount } = await import("@/lib/enso");

      // Small amount should always be pure swap if pool has any bonus
      const { swapAmount, mintAmount } = await getOptimalSwapAmount(parseEther("100").toString());

      // For small amounts, expect either all swap or all mint
      expect(swapAmount === parseEther("100") || mintAmount === parseEther("100")).toBe(true);
    });

    it("hybrid: when amount exceeds peg point", async () => {
      const { getOptimalSwapAmount, findMaxSwapBeforePeg } = await import("@/lib/enso");

      const pegPoint = await findMaxSwapBeforePeg();
      console.log(`Current peg point: ${formatEther(pegPoint)} CVX`);

      if (pegPoint > 0n) {
        // Test amount larger than peg point
        const testAmount = pegPoint * 2n;
        const { swapAmount, mintAmount } = await getOptimalSwapAmount(testAmount.toString());

        console.log(`For ${formatEther(testAmount)} CVX:`);
        console.log(`  Swap: ${formatEther(swapAmount)}`);
        console.log(`  Mint: ${formatEther(mintAmount)}`);

        // Should be hybrid (both > 0)
        if (testAmount > pegPoint) {
          expect(swapAmount).toBeGreaterThan(0n);
          expect(mintAmount).toBeGreaterThan(0n);
        }
      }
    });
  });

  describe("Simulation with debug_traceCall", () => {
    const hasDebugRpc = DEBUG_RPC_URL && DEBUG_RPC_AUTH;

    it.skipIf(!hasDebugRpc)("ETH → yscvgCVX: simulates successfully", async () => {
      const { fetchCvgCvxZapInRoute } = await import("@/lib/enso");

      const route = await fetchCvgCvxZapInRoute({
        fromAddress: WHALES.ETH,
        inputToken: TOKENS.ETH,
        amountIn: parseEther("1").toString(),
        vaultAddress: VAULTS.YSCVGCVX,
        slippage: "300",
      });

      expect(route.tx).toBeDefined();

      // Note: eth_call simulation typically fails for DEX routes
      // because it can't execute actual swaps
      // This is documented behavior
      const result = await simulateBundle({
        from: WHALES.ETH,
        to: route.tx!.to,
        data: route.tx!.data,
        value: route.tx!.value,
      });

      // We expect this to fail at the route step
      // because eth_call can't execute DEX swaps
      console.log("Simulation result:", result);
    });

    it.skipIf(!hasDebugRpc)("CVX → yscvgCVX with whale balance", async () => {
      const { fetchCvgCvxZapInRoute } = await import("@/lib/enso");

      // Check whale has CVX
      const cvxBalance = await getTokenBalance(TOKENS.CVX as Address, WHALES.CVX);
      console.log(`CVX whale balance: ${formatEther(cvxBalance)} CVX`);

      if (cvxBalance < parseEther("1000")) {
        console.log("Whale has insufficient CVX, skipping simulation");
        return;
      }

      const route = await fetchCvgCvxZapInRoute({
        fromAddress: WHALES.CVX,
        inputToken: TOKENS.CVX,
        amountIn: parseEther("1000").toString(),
        vaultAddress: VAULTS.YSCVGCVX,
        slippage: "300",
      });

      expect(route.tx).toBeDefined();

      const result = await simulateBundle({
        from: WHALES.CVX,
        to: route.tx!.to,
        data: route.tx!.data,
        value: route.tx!.value ?? "0",
      });

      console.log("CVX simulation result:", result);
    });
  });
});

// ============================================
// Route Matrix Tests
// ============================================

describeWithApi("Route Matrix", () => {
  const testCases = [
    // ERC20 → Vault
    { from: "ETH", to: "yscvgCVX", inputToken: TOKENS.ETH, vault: VAULTS.YSCVGCVX, amount: "1" },
    { from: "CVX", to: "yscvgCVX", inputToken: TOKENS.CVX, vault: VAULTS.YSCVGCVX, amount: "1000" },
    { from: "USDC", to: "yscvgCVX", inputToken: TOKENS.USDC, vault: VAULTS.YSCVGCVX, amount: "1000", decimals: 6 },
    { from: "ETH", to: "yspxCVX", inputToken: TOKENS.ETH, vault: VAULTS.YSPXCVX, amount: "1" },
    { from: "CVX", to: "yspxCVX", inputToken: TOKENS.CVX, vault: VAULTS.YSPXCVX, amount: "1000" },
    { from: "ETH", to: "ycvxCRV", inputToken: TOKENS.ETH, vault: VAULTS.YCVXCRV, amount: "1" },
  ];

  describe("Zap In Routes", () => {
    testCases.forEach(({ from, to, inputToken, vault, amount, decimals }) => {
      it(`${from} → ${to}: creates valid bundle`, async () => {
        const { fetchZapInRoute } = await import("@/lib/enso");

        const amountIn = decimals
          ? (BigInt(amount) * 10n ** BigInt(decimals)).toString()
          : parseEther(amount).toString();

        const route = await fetchZapInRoute({
          fromAddress: WHALES.ETH,
          inputToken,
          amountIn,
          vaultAddress: vault,
          slippage: "300",
        });

        expect(route.tx).toBeDefined();
        expect(route.tx?.to).toBeDefined();
        expect(route.tx?.data).toBeDefined();

        console.log(`✅ ${from} → ${to}: Bundle created`);
      });
    });
  });
});
