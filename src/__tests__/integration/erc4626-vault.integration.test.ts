/**
 * Integration tests for direct ERC4626 vault operations (deposit/redeem).
 *
 * These tests verify that direct vault.deposit() and vault.redeem() calls work correctly
 * WITHOUT going through Enso. This is what the deposit/withdraw pages use via useVaultActions.
 *
 * Uses debug_traceCall with state overrides to simulate transactions on mainnet fork.
 * Uses token-holders API (or Moralis fallback) to find actual token holders for realistic testing.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { parseEther, encodeFunctionData, keccak256, toHex, pad, concat } from "viem";
import crossFetch from "cross-fetch";
import { VAULT_ADDRESSES, TOKENS } from "@/config/vaults";

// RPC configuration
const SIMULATION_RPC_URL = process.env.DEBUG_RPC_URL || "https://eth.llamarpc.com";
const SIMULATION_RPC_AUTH = process.env.DEBUG_RPC_AUTH || "";

// Token holders API
const TOKEN_HOLDER_API_URL = process.env.TOKEN_HOLDER_API_URL || "http://localhost:3000/api/token-holders";
const TOKEN_HOLDER_API_KEY = process.env.TOKEN_HOLDER_API_KEY || "";
const MORALIS_API_KEY = process.env.MORALIS_API_KEY || "";

// Skip tests if no RPC URL configured
const skipIfNoRpc = SIMULATION_RPC_URL ? it : it.skip;

// Test timeout
const TEST_TIMEOUT = 30000;

// ERC4626 ABI for deposit/redeem
const ERC4626_ABI = [
  {
    name: "deposit",
    type: "function",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    name: "redeem",
    type: "function",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "assets", type: "uint256" }],
  },
  {
    name: "previewDeposit",
    type: "function",
    inputs: [{ name: "assets", type: "uint256" }],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    name: "previewRedeem",
    type: "function",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "assets", type: "uint256" }],
  },
] as const;

// Vault configurations with their underlying tokens and storage slots
const VAULT_CONFIGS = {
  yscvgCVX: {
    vault: VAULT_ADDRESSES.YSCVGCVX,
    underlying: TOKENS.CVGCVX,
    name: "yscvgCVX",
    underlyingName: "cvgCVX",
    // cvgCVX is ERC20Upgradeable - slot 51 for balance, 52 for allowance
    underlyingBalanceSlot: 51,
    underlyingAllowanceSlot: 52,
    // Yearn V3 tokenized strategy - slot 0 for balance
    vaultBalanceSlot: 0,
  },
  yspxCVX: {
    vault: VAULT_ADDRESSES.YSPXCVX,
    underlying: TOKENS.PXCVX,
    name: "yspxCVX",
    underlyingName: "pxCVX",
    // pxCVX uses Solmate ERC20: slot 3 for balanceOf, slot 4 for allowance
    // (Solmate has: name[0], symbol[1], totalSupply[2], balanceOf[3], allowance[4])
    underlyingBalanceSlot: 3,
    underlyingAllowanceSlot: 4,
    // Yearn V3 tokenized strategy - slot 0 for balance
    vaultBalanceSlot: 0,
  },
  ycvxCRV: {
    vault: VAULT_ADDRESSES.YCVXCRV,
    underlying: TOKENS.CVXCRV,
    name: "ycvxCRV",
    underlyingName: "cvxCRV",
    // cvxCRV is standard ERC20 - slot 0 for balance, 1 for allowance
    underlyingBalanceSlot: 0,
    underlyingAllowanceSlot: 1,
    // Yearn V3 Vyper vault - slot 18 for balance (uses Vyper storage)
    vaultBalanceSlot: 18,
    isVyper: true,
  },
  yscvxCRV: {
    vault: VAULT_ADDRESSES.YSCVXCRV,
    underlying: TOKENS.CVXCRV,
    name: "yscvxCRV",
    underlyingName: "cvxCRV",
    // cvxCRV is standard ERC20 - slot 0 for balance, 1 for allowance
    underlyingBalanceSlot: 0,
    underlyingAllowanceSlot: 1,
    // Yearn V3 tokenized strategy - slot 0 for balance
    vaultBalanceSlot: 0,
  },
} as const;

// ============================================================================
// Token Holder Utilities (shared pattern with enso-zap.integration.test.ts)
// ============================================================================

/**
 * Get ERC20 token balance for an address using eth_call
 */
async function getTokenBalance(token: string, holder: string): Promise<bigint> {
  if (!SIMULATION_RPC_URL) return 0n;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (SIMULATION_RPC_AUTH) {
    headers["Authorization"] = `Basic ${SIMULATION_RPC_AUTH}`;
  }

  // balanceOf(address) selector: 0x70a08231
  const data = "0x70a08231" + holder.toLowerCase().slice(2).padStart(64, "0");

  try {
    const response = await crossFetch(SIMULATION_RPC_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: token, data }, "latest"],
      }),
    });

    const result = (await response.json()) as { result?: string };
    if (result.result && result.result !== "0x") {
      return BigInt(result.result);
    }
    return 0n;
  } catch {
    return 0n;
  }
}

/**
 * Check if an address is an EOA (not a contract)
 */
async function isEOA(address: string): Promise<boolean> {
  if (!SIMULATION_RPC_URL) return false;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (SIMULATION_RPC_AUTH) {
    headers["Authorization"] = `Basic ${SIMULATION_RPC_AUTH}`;
  }

  try {
    const response = await crossFetch(SIMULATION_RPC_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getCode",
        params: [address, "latest"],
      }),
    });

    const result = (await response.json()) as { result?: string };
    return result.result === "0x" || result.result === "0x0" || !result.result;
  } catch {
    return false;
  }
}

/**
 * Fetch holders from token-holders API (or fallback to direct Moralis)
 */
async function fetchHolders(
  token: string,
  minAmount: bigint,
  maxHolders: number = 3
): Promise<string[]> {
  // Try API endpoint first
  if (TOKEN_HOLDER_API_KEY) {
    try {
      const response = await crossFetch(TOKEN_HOLDER_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": TOKEN_HOLDER_API_KEY,
        },
        body: JSON.stringify({
          token,
          minBalance: minAmount.toString(),
          maxHolders,
        }),
      });

      const data = (await response.json()) as {
        success?: boolean;
        holders?: string[];
        cached?: boolean;
      };
      if (data.success && Array.isArray(data.holders)) {
        return data.holders;
      }
    } catch (err) {
      console.warn("Token holders API failed, falling back to Moralis:", err);
    }
  }

  // Fallback: Direct Moralis API
  if (!MORALIS_API_KEY) return [];

  try {
    const url = `https://deep-index.moralis.io/api/v2.2/erc20/${token}/owners?chain=eth&limit=20&order=DESC`;

    const response = await crossFetch(url, {
      headers: {
        Accept: "application/json",
        "X-API-Key": MORALIS_API_KEY,
      },
    });

    const data = (await response.json()) as {
      result?: Array<{ owner_address: string }>;
    };
    const holders: string[] = [];

    if (Array.isArray(data.result)) {
      for (const holder of data.result) {
        if (holders.length >= maxHolders) break;

        const address = holder.owner_address;

        // Skip contracts - we need EOAs
        if (!(await isEOA(address))) continue;

        const balance = await getTokenBalance(token, address);
        if (balance >= minAmount) {
          holders.push(address);
        }
      }
    }
    return holders;
  } catch (err) {
    console.warn("Moralis API lookup failed:", err);
    return [];
  }
}

/**
 * Find a wallet with sufficient balance of a token
 */
async function findWalletWithBalance(
  token: string,
  minAmount: bigint
): Promise<string | null> {
  const holders = await fetchHolders(token, minAmount, 1);
  return holders.length > 0 ? holders[0] : null;
}

// ============================================================================
// Storage Slot Computation
// ============================================================================

/**
 * Compute storage slot for ERC20 allowance mapping
 */
function computeAllowanceSlot(
  owner: string,
  spender: string,
  baseSlot: number,
  isVyper = false
): string {
  const paddedOwner = pad(owner.toLowerCase() as `0x${string}`, { size: 32 });
  const paddedSpender = pad(spender.toLowerCase() as `0x${string}`, { size: 32 });
  const paddedSlot = pad(toHex(baseSlot), { size: 32 });

  // First compute owner's position in the mapping
  const ownerData = isVyper ? concat([paddedSlot, paddedOwner]) : concat([paddedOwner, paddedSlot]);
  const ownerSlot = keccak256(ownerData);

  // Then compute spender's position within owner's allowance mapping
  const spenderData = isVyper
    ? concat([ownerSlot, paddedSpender])
    : concat([paddedSpender, ownerSlot]);

  return keccak256(spenderData);
}

// ============================================================================
// RPC Utilities
// ============================================================================

/**
 * Make RPC call with optional auth
 */
async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (SIMULATION_RPC_AUTH) {
    headers["Authorization"] = `Basic ${SIMULATION_RPC_AUTH}`;
  }

  const response = await crossFetch(SIMULATION_RPC_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  const data = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (data.error) {
    throw new Error(data.error.message);
  }
  return data.result;
}

/**
 * Simulate a transaction using debug_traceCall with state overrides
 */
async function simulateTransaction(params: {
  from: string;
  to: string;
  data: string;
  stateOverrides: Record<string, { stateDiff: Record<string, string> }>;
}): Promise<{ success: boolean; error?: string; returnData?: string }> {
  try {
    const result = await rpcCall("debug_traceCall", [
      {
        from: params.from,
        to: params.to,
        data: params.data,
        gas: "0x1000000", // 16M gas limit
      },
      "latest",
      {
        tracer: "callTracer",
        stateOverrides: params.stateOverrides,
      },
    ]);

    const trace = result as { output?: string; error?: string; revertReason?: string };

    if (trace.error || trace.revertReason) {
      return {
        success: false,
        error: trace.revertReason || trace.error || "Transaction reverted",
      };
    }

    return { success: true, returnData: trace.output };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : "Simulation failed",
    };
  }
}

/**
 * Call a view function (eth_call) with state overrides
 */
async function callWithOverrides(params: {
  to: string;
  data: string;
  stateOverrides?: Record<string, { stateDiff: Record<string, string> }>;
}): Promise<string> {
  const result = await rpcCall("eth_call", [
    { to: params.to, data: params.data },
    "latest",
    params.stateOverrides || {},
  ]);
  return result as string;
}

// ============================================================================
// Tests
// ============================================================================

describe("Direct ERC4626 Vault Operations", () => {
  beforeAll(() => {
    if (!SIMULATION_RPC_URL) {
      console.warn("DEBUG_RPC_URL not set - skipping ERC4626 vault integration tests");
    }
  });

  describe("Deposit Operations", () => {
    Object.entries(VAULT_CONFIGS).forEach(([_key, config]) => {
      skipIfNoRpc(
        `${config.underlyingName} → ${config.name}: direct deposit succeeds`,
        async () => {
          const depositAmount = parseEther("10"); // Use smaller amount

          // Find actual holder of underlying token
          const holder = await findWalletWithBalance(config.underlying, depositAmount);

          if (!holder) {
            console.warn(
              `No holder found with sufficient ${config.underlyingName} balance - skipping`
            );
            return;
          }

          console.log(`Using ${config.underlyingName} holder: ${holder}`);

          // Only need to override allowance (holder already has the tokens)
          const underlyingAllowanceSlot = computeAllowanceSlot(
            holder,
            config.vault,
            config.underlyingAllowanceSlot
          );

          const stateOverrides = {
            [config.underlying]: {
              stateDiff: {
                // Set allowance for vault to spend holder's tokens
                [underlyingAllowanceSlot]: pad(toHex(depositAmount), { size: 32 }),
              },
            },
          };

          // First check previewDeposit to see expected shares
          const previewData = encodeFunctionData({
            abi: ERC4626_ABI,
            functionName: "previewDeposit",
            args: [depositAmount],
          });

          let expectedShares: bigint;
          try {
            const previewResult = await callWithOverrides({
              to: config.vault,
              data: previewData,
            });
            expectedShares = BigInt(previewResult);
            console.log(
              `${config.name} previewDeposit: ${expectedShares} shares for ${depositAmount} assets`
            );
          } catch (e) {
            console.warn(`${config.name} previewDeposit failed:`, e);
            expectedShares = 0n;
          }

          // Now simulate the actual deposit
          const depositData = encodeFunctionData({
            abi: ERC4626_ABI,
            functionName: "deposit",
            args: [depositAmount, holder as `0x${string}`],
          });

          const result = await simulateTransaction({
            from: holder,
            to: config.vault,
            data: depositData,
            stateOverrides,
          });

          if (!result.success) {
            console.error(`${config.name} deposit failed:`, result.error);
          }

          expect(result.success).toBe(true);

          // If we got return data, verify it matches expected shares
          if (result.returnData && expectedShares > 0n) {
            const actualShares = BigInt(result.returnData);
            expect(actualShares).toBe(expectedShares);
          }
        },
        TEST_TIMEOUT
      );
    });
  });

  describe("Redeem Operations", () => {
    Object.entries(VAULT_CONFIGS).forEach(([_key, config]) => {
      skipIfNoRpc(
        `${config.name} → ${config.underlyingName}: direct redeem succeeds`,
        async () => {
          const redeemShares = parseEther("1"); // Use small amount

          // Find actual holder of vault shares
          const holder = await findWalletWithBalance(config.vault, redeemShares);

          if (!holder) {
            console.warn(`No holder found with sufficient ${config.name} shares - skipping`);
            return;
          }

          console.log(`Using ${config.name} holder: ${holder}`);

          // No state overrides needed - vault has real underlying tokens from real deposits

          // First check previewRedeem to see expected assets
          const previewData = encodeFunctionData({
            abi: ERC4626_ABI,
            functionName: "previewRedeem",
            args: [redeemShares],
          });

          let expectedAssets: bigint;
          try {
            const previewResult = await callWithOverrides({
              to: config.vault,
              data: previewData,
            });
            expectedAssets = BigInt(previewResult);
            console.log(
              `${config.name} previewRedeem: ${expectedAssets} assets for ${redeemShares} shares`
            );
          } catch (e) {
            console.warn(`${config.name} previewRedeem failed:`, e);
            expectedAssets = 0n;
          }

          // Now simulate the actual redeem
          const redeemData = encodeFunctionData({
            abi: ERC4626_ABI,
            functionName: "redeem",
            args: [redeemShares, holder as `0x${string}`, holder as `0x${string}`],
          });

          const result = await simulateTransaction({
            from: holder,
            to: config.vault,
            data: redeemData,
            stateOverrides: {},
          });

          if (!result.success) {
            console.error(`${config.name} redeem failed:`, result.error);
          }

          expect(result.success).toBe(true);

          // If we got return data, verify it matches expected assets
          if (result.returnData && expectedAssets > 0n) {
            const actualAssets = BigInt(result.returnData);
            expect(actualAssets).toBe(expectedAssets);
          }
        },
        TEST_TIMEOUT
      );
    });
  });

  describe("Preview Functions", () => {
    Object.entries(VAULT_CONFIGS).forEach(([_key, config]) => {
      skipIfNoRpc(
        `${config.name}: previewDeposit returns non-zero for valid amount`,
        async () => {
          const depositAmount = parseEther("100");

          const previewData = encodeFunctionData({
            abi: ERC4626_ABI,
            functionName: "previewDeposit",
            args: [depositAmount],
          });

          const result = await callWithOverrides({
            to: config.vault,
            data: previewData,
          });

          const shares = BigInt(result);
          console.log(`${config.name} previewDeposit(100): ${shares} shares`);

          // Shares should be > 0 for a valid deposit
          expect(shares).toBeGreaterThan(0n);
        },
        TEST_TIMEOUT
      );

      skipIfNoRpc(
        `${config.name}: previewRedeem returns non-zero for valid amount`,
        async () => {
          const redeemShares = parseEther("100");

          const previewData = encodeFunctionData({
            abi: ERC4626_ABI,
            functionName: "previewRedeem",
            args: [redeemShares],
          });

          const result = await callWithOverrides({
            to: config.vault,
            data: previewData,
          });

          const assets = BigInt(result);
          console.log(`${config.name} previewRedeem(100): ${assets} assets`);

          // Assets should be > 0 for a valid redeem
          expect(assets).toBeGreaterThan(0n);
        },
        TEST_TIMEOUT
      );
    });
  });
});
