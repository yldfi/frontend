import type { Chain } from "viem";
import { ERC20_APPROVAL_ABI } from "@/lib/abis";
import type { SimulationResult } from "@/types/enso";

// ---------------------------------------------------------------------------
// Enso hex error decoder
// Decodes: error(uint256 step, address target, string message) — selector 0xef3dcb2f
// ---------------------------------------------------------------------------

export function parseEnsoError(hexData: string): { step: number; target: string; message: string } | null {
  const data = hexData.replace(/^0x/, "").replace(/\.\s*$/, "");
  if (!data.toLowerCase().startsWith("ef3dcb2f")) return null;
  const body = data.slice(8);
  if (body.length < 192) return null;
  const step = parseInt(body.slice(0, 64), 16);
  const target = "0x" + body.slice(88, 128);
  const strLen = parseInt(body.slice(192, 256), 16);
  if (strLen > 0 && strLen <= 256 && 256 + strLen * 2 <= body.length) {
    const strHex = body.slice(256, 256 + strLen * 2);
    try {
      const message = strHex.match(/.{2}/g)!.map(b => String.fromCharCode(parseInt(b, 16))).join("");
      if (/^[\x20-\x7e]+$/.test(message)) return { step, target, message };
    } catch { /* invalid */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unwrap Zapper SwapFailed(bytes) — selector 0xd9d027cc
// Inner bytes are typically Enso ExecutionFailed(uint256,address,string)
// ---------------------------------------------------------------------------

export function parseSwapFailedError(hexData: string): { step: number; target: string; message: string } | null {
  const data = hexData.replace(/^0x/, "").replace(/\.\s*$/, "");
  if (!data.toLowerCase().startsWith("d9d027cc")) return null;
  // SwapFailed(bytes): selector(4B) + offset(32B) + length(32B) + data
  const body = data.slice(8);
  if (body.length < 128) return null;
  const offset = parseInt(body.slice(0, 64), 16);
  if (offset !== 32) return null;
  const length = parseInt(body.slice(64, 128), 16);
  if (length === 0 || 128 + length * 2 > body.length) return null;
  const innerData = body.slice(128, 128 + length * 2);
  return parseEnsoError(innerData);
}

// ---------------------------------------------------------------------------
// Fallback: scan ABI-encoded hex for any embedded string
// ---------------------------------------------------------------------------

export function extractStringFromHex(hex: string): string | null {
  const data = hex.replace(/^0x/, "").replace(/^[0-9a-f]{8}/i, "");
  for (let i = 0; i < data.length - 64; i += 64) {
    const possibleLen = parseInt(data.slice(i, i + 64), 16);
    if (possibleLen > 0 && possibleLen <= 256 && i + 64 + possibleLen * 2 <= data.length) {
      const strHex = data.slice(i + 64, i + 64 + possibleLen * 2);
      try {
        const decoded = strHex.match(/.{2}/g)!.map(b => String.fromCharCode(parseInt(b, 16))).join("");
        if (decoded.length > 2 && /^[\x20-\x7e]+$/.test(decoded)) return decoded;
      } catch { /* not valid utf8 */ }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Known custom error selectors from Enso router and common DeFi contracts
// ---------------------------------------------------------------------------

export const CUSTOM_ERROR_SELECTORS: Record<string, string> = {
  "0x97a6f3b9": "Slippage too high - price moved, try increasing slippage tolerance",
  "0x8baa579f": "Insufficient output amount",
  "0x39d35496": "Excessive input amount",
  "0x13be252b": "Insufficient balance",
  "0x756688fe": "Deadline expired - transaction took too long",
  "0x675cae38": "Invalid path",
  "0x7939f424": "Transfer failed",
  "0xd9d027cc": "Swap failed during transaction. Try refreshing the quote or increasing slippage.",
};

export const CURVE_DEBT_TOO_HIGH_MESSAGE =
  "Curve rejected this partial repay: Debt too high. Repay more debt or close the loan.";
export const SWAP_OUTPUT_BELOW_MINIMUM_MESSAGE =
  "Swap output below minimum. Increase the amount or slippage.";

// ---------------------------------------------------------------------------
// Unified error parser — merges all detection from 4 former implementations
// ---------------------------------------------------------------------------

export function parseErrorMessage(error: unknown, defaultMsg?: string): string {
  if (!error) return defaultMsg ?? "Unknown error";

  const errorStr = String(error);
  const lower = errorStr.toLowerCase();

  if (lower.includes("debt too high")) {
    return CURVE_DEBT_TOO_HIGH_MESSAGE;
  }

  if (lower.includes("no swap route could produce enough")) {
    return "No swap route could produce enough crvUSD for this close. Increase the amount, increase slippage, or use crvUSD.";
  }
  if (lower.includes("no swap route could be quoted")) {
    return "No swap route could be quoted for this transaction. Increase the amount, increase slippage, or use a different token.";
  }
  if (lower.includes("could not quote shortcuts") || lower.includes("could not quote")) {
    return "No swap route could be quoted for this transaction. Increase the amount, increase slippage, or use a different token.";
  }

  // User rejection
  if (lower.includes("user rejected") || lower.includes("user denied") || lower.includes("user declined")) {
    return "Transaction cancelled";
  }

  // ERC20 allowance failures
  if (
    lower.includes("insufficient allowance") ||
    lower.includes("transfer amount exceeds allowance") ||
    (lower.includes("erc20") && lower.includes("exceeds allowance"))
  ) {
    return "Token approval is missing or too low. Approve the token for Enso Router and try again.";
  }

  // Insufficient balance / funds
  if (lower.includes("transfer amount exceeds balance")) {
    return "Transaction would fail: swap conditions changed, try refreshing the quote";
  }
  if (lower.includes("insufficient") || lower.includes("exceeds balance")) {
    return "Insufficient balance";
  }
  if (lower.includes("insufficient funds")) {
    return "Insufficient funds for gas";
  }

  // Slippage
  if (lower.includes("slippage") || lower.includes("insufficient_output")) {
    return SWAP_OUTPUT_BELOW_MINIMUM_MESSAGE;
  }

  // Health check (Curve lending)
  if (lower.includes("health")) {
    return "Position would be unhealthy";
  }

  // Pre-parsed Enso error from devEthCall (enso:Message format)
  const ensoPrefixMatch = errorStr.match(/enso:(.+)/);
  if (ensoPrefixMatch) {
    const ensoMsg = ensoPrefixMatch[1].toLowerCase();
    if (ensoMsg.includes("condition not met") || ensoMsg.includes("return amount is not enough")) {
      return SWAP_OUTPUT_BELOW_MINIMUM_MESSAGE;
    }
    if (ensoMsg.includes("call failed")) return "Swap route failed. Try increasing slippage or use a different token.";
    if (ensoMsg === "unknown") return "Swap failed during transaction. Try refreshing the quote or increasing slippage.";
    return `Transaction failed: ${ensoPrefixMatch[1]}`;
  }

  // Parse Enso Shortcuts custom error from hex: error(uint256 step, address target, string message)
  const ensoHexMatch = errorStr.match(/custom error 0xef3dcb2f[:\s]*([0-9a-f.]+)/i);
  if (ensoHexMatch) {
    const parsed = parseEnsoError("ef3dcb2f" + ensoHexMatch[1].replace(/\.\s*$/, ""));
    if (parsed) {
      if (process.env.NODE_ENV === "development") console.log("[Enso error]", { step: parsed.step, target: parsed.target, message: parsed.message });
      const msg = parsed.message.toLowerCase();
      if (msg.includes("condition not met") || msg.includes("return amount is not enough")) {
        return SWAP_OUTPUT_BELOW_MINIMUM_MESSAGE;
      }
      if (msg.includes("call failed")) {
        return "Swap route failed. Try increasing slippage or use a different token.";
      }
      return `Transaction failed: ${parsed.message}`;
    }
  }

  // Unwrap Zapper SwapFailed(bytes) wrapping Enso ExecutionFailed
  const swapFailedMatch = errorStr.match(/custom error 0xd9d027cc[:\s]*([0-9a-f.]+)/i);
  if (swapFailedMatch) {
    const parsed = parseSwapFailedError("d9d027cc" + swapFailedMatch[1].replace(/\.\s*$/, ""));
    if (parsed) {
      if (process.env.NODE_ENV === "development") console.log("[SwapFailed → Enso error]", { step: parsed.step, target: parsed.target, message: parsed.message });
      const msg = parsed.message.toLowerCase();
      if (msg.includes("condition not met") || msg.includes("return amount is not enough")) {
        return SWAP_OUTPUT_BELOW_MINIMUM_MESSAGE;
      }
      if (msg.includes("call failed")) {
        return "Swap route failed. Try increasing slippage or use a different token.";
      }
      if (msg === "unknown") {
        return "Swap failed during transaction. Try refreshing the quote or increasing slippage.";
      }
      return `Swap failed: ${parsed.message}`;
    }
  }

  // Known custom error selectors (0x + 8 hex chars)
  const selectorMatch = errorStr.match(/custom error (0x[a-fA-F0-9]{8})/i)
    || errorStr.match(/reverted with (0x[a-fA-F0-9]{8})/i)
    || errorStr.match(/error (0x[a-fA-F0-9]{8})/i);
  if (selectorMatch) {
    const selector = selectorMatch[1].toLowerCase();
    const friendlyMessage = CUSTOM_ERROR_SELECTORS[selector];
    if (friendlyMessage) return friendlyMessage;
  }

  // Generic Enso/DEX assertion failures (when hex parsing fails)
  if (lower.includes("condition not met") || lower.includes("return amount is not enough")) {
    return SWAP_OUTPUT_BELOW_MINIMUM_MESSAGE;
  }
  if (lower.includes("call failed")) {
    return "Swap route failed. Try increasing slippage or use a different token.";
  }

  // Other custom errors with hex data — try to extract embedded string
  const customErrorMatch = errorStr.match(/custom error (0x[0-9a-f]+):\s*([0-9a-f]+)/i);
  if (customErrorMatch) {
    const extracted = extractStringFromHex(customErrorMatch[1] + customErrorMatch[2]);
    if (extracted) return `Transaction failed: ${extracted}`;
  }

  // Simulation/estimation errors (from useZapActions/useVaultActions)
  if (lower.includes("estimategasexecutionerror") || lower.includes("simulatecontract")) {
    const shortReason = errorStr.match(/reason:\s*(.+?)(?:\n|Contract Call:|$)/i);
    if (shortReason) return `Simulation failed: ${shortReason[1].trim()}`;
    return "Transaction simulation failed";
  }

  // Gas errors
  if (lower.includes("gas required exceeds") || lower.includes("out of gas")) {
    return "Transaction would fail: out of gas";
  }

  // Generic revert — try to extract the reason string
  if (lower.includes("revert")) {
    const match = errorStr.match(/reason="([^"]+)"/)
      || errorStr.match(/reason string '([^']+)'/)
      || errorStr.match(/reverted with the following reason:\s*\n?\s*(.+?)(?:\n|$)/i)
      || errorStr.match(/reverted[^:]*:\s*(.+?)(?:\n|$)/i);
    if (match) {
      const reason = match[1].trim();
      if (reason.toLowerCase() === "execution reverted") {
        return "Transaction failed: execution reverted";
      }
      return `Transaction failed: ${reason}`;
    }
  }

  // Fallback: truncate very long messages
  if (errorStr.length > 100) {
    const firstLine = errorStr.split('\n')[0];
    if (firstLine.length <= 100) return firstLine;
    return errorStr.slice(0, 97) + "...";
  }

  return defaultMsg ?? "Transaction failed. Please try again.";
}

// ---------------------------------------------------------------------------
// Tenderly simulation via /api/simulate
// ---------------------------------------------------------------------------

export async function runTenderlySimulation(
  userAddress: string,
  txTo: string,
  txData: string,
  txValue: string,
  inputToken: string,
  label?: string
): Promise<{ ok: boolean; result: SimulationResult | null; errorMessage?: string }> {
  const tag = label ? `[Tenderly Simulation - ${label}]` : "[Tenderly Simulation]";
  try {
    const nonceResponse = await fetch("/api/simulate/nonce", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    const nonceResult = (await nonceResponse.json()) as {
      success: boolean;
      nonce?: string;
      expires?: number;
      sig?: string;
    };

    if (!nonceResult.success || !nonceResult.nonce || !nonceResult.expires || !nonceResult.sig) {
      return { ok: false, result: null, errorMessage: "Failed to obtain simulation nonce" };
    }

    const response = await fetch("/api/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: userAddress,
        to: txTo,
        data: txData,
        value: txValue,
        inputToken,
        nonce: nonceResult.nonce,
        expires: nonceResult.expires,
        sig: nonceResult.sig,
      }),
      signal: AbortSignal.timeout(45_000),
    });

    const result = (await response.json()) as SimulationResult & { retryable?: boolean };

    if (process.env.NODE_ENV === "development") {
      console.log(tag, {
        success: result.success,
        simulationId: result.simulationId,
        tenderlyUrl: result.tenderlyUrl,
        gasUsed: result.gasUsed,
        errorMessage: result.errorMessage,
        assetChanges: result.assetChanges?.length ?? 0,
      });
    }

    if (result.success) {
      return { ok: true, result };
    }
    const errMsg = typeof result.errorMessage === "string"
      ? result.errorMessage
      : result.errorMessage?.message ?? "Simulation failed";
    return { ok: false, result, errorMessage: errMsg };
  } catch (error) {
    if (process.env.NODE_ENV === "development") {
      console.error(tag, "fetch failed:", error instanceof Error ? error.message : error);
    }
    return {
      ok: false,
      result: null,
      errorMessage: error instanceof Error ? error.message : "Simulation failed",
    };
  }
}

// ---------------------------------------------------------------------------
// Direct eth_call for Anvil — bypasses fallback transport to avoid silent
// retry on DRPC mainnet where the fork account has no balance.
// Dynamic import ensures createPublicClient/http are tree-shaken in production.
// ---------------------------------------------------------------------------

export async function anvilCall(
  publicClient: { call: (args: { account: `0x${string}`; to: `0x${string}`; data: `0x${string}`; value?: bigint }) => Promise<unknown>; chain: Chain },
  params: { account: `0x${string}`; to: `0x${string}`; data: `0x${string}`; value?: bigint },
): Promise<void> {
  const anvilRpc = process.env.NEXT_PUBLIC_ANVIL_RPC;
  if (anvilRpc) {
    const { createPublicClient, http } = await import("viem");
    const direct = createPublicClient({ chain: publicClient.chain, transport: http(anvilRpc) });
    await direct.call(params);
  } else {
    await publicClient.call(params);
  }
}

// ---------------------------------------------------------------------------
// ERC20 allowance check
// ---------------------------------------------------------------------------

export async function checkAllowance(
  publicClient: { readContract: (args: { address: `0x${string}`; abi: typeof ERC20_APPROVAL_ABI; functionName: "allowance"; args: [`0x${string}`, `0x${string}`] }) => Promise<unknown> } | undefined | null,
  owner: `0x${string}`,
  token: `0x${string}`,
  spender: `0x${string}`
): Promise<bigint> {
  if (!publicClient) return 0n;
  try {
    const allowance = await publicClient.readContract({
      address: token,
      abi: ERC20_APPROVAL_ABI,
      functionName: "allowance",
      args: [owner, spender],
    });
    return allowance as bigint;
  } catch {
    return 0n;
  }
}
