"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import { useAccount, usePublicClient, useWaitForTransactionReceipt } from "wagmi";
import { useVNetSendTransaction as useSendTransaction } from "@/hooks/useVNetSendTransaction";
import { useVNetWriteContract as useWriteContract } from "@/hooks/useVNetWriteContract";
import { encodeFunctionData, formatUnits, maxUint256, toFunctionSelector } from "viem";
import {
  ZAPPER_V2_ADDRESS,
  ZAPPER_ABI,
  CONTROLLER_APPROVE_ABI,
  CRVUSD_ADDRESS,
  fetchZapperSwapData,
  fetchFromTokenSwapData,
  getDeadline,
} from "@/lib/zapper";

// ABI for direct controller.liquidate (no Zapper needed)
const CONTROLLER_LIQUIDATE_ABI = [
  {
    name: "liquidate",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "min_x", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "liquidate_extended",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "min_x", type: "uint256" },
      { name: "frac", type: "uint256" },
      { name: "callbacker", type: "address" },
      { name: "callback_args", type: "uint256[]" },
    ],
    outputs: [],
  },
] as const;
import { ERC20_APPROVAL_ABI } from "@/lib/abis";
import type { SimulationResult } from "@/types/enso";
import { useTenderly } from "@/contexts/TenderlyContext";
import { runVNetSimulation } from "@/lib/vnet-simulation";
import { snapshotTx, logTxDiff } from "@/lib/dev-logging";

export type ZapperStatus =
  | "idle"
  | "building"       // Fetching Enso route + encoding tx
  | "simulating"     // Running Tenderly simulation
  | "needsApproval"  // Waiting for user to approve (ERC20 or controller)
  | "approving"      // Approval tx sent, waiting for confirmation
  | "executing"      // Sending main transaction
  | "waitingTx"      // Waiting for main tx to confirm
  | "success"
  | "reverted"
  | "error";

export type { PendingApproval } from "@/types/approval";
import type { PendingApproval } from "@/types/approval";

interface PendingTx {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  inputToken: string;
  controller?: `0x${string}`; // For dev-mode position logging
}

function parseEnsoError(hexData: string): { step: number; target: string; message: string } | null {
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

function extractStringFromHex(hex: string): string | null {
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

function parseErrorMessage(error: unknown): string {
  if (!error) return "Unknown error";
  const errorStr = String(error);
  const lower = errorStr.toLowerCase();

  if (lower.includes("user rejected") || lower.includes("user denied")) {
    return "Transaction cancelled";
  }
  if (lower.includes("insufficient") || lower.includes("exceeds balance")) {
    return "Insufficient balance";
  }
  if (lower.includes("slippage") || lower.includes("insufficient_output")) {
    return "Price moved too much. Try increasing slippage.";
  }
  if (lower.includes("health")) {
    return "Position would be unhealthy";
  }
  // Pre-parsed Enso error from devEthCall (enso:Message format)
  const ensoPrefixMatch = errorStr.match(/enso:(.+)/);
  if (ensoPrefixMatch) {
    const ensoMsg = ensoPrefixMatch[1].toLowerCase();
    if (ensoMsg.includes("condition not met") || ensoMsg.includes("return amount is not enough")) {
      return "Swap output below minimum. Try increasing slippage.";
    }
    if (ensoMsg.includes("call failed")) return "Swap route failed. Try increasing slippage or use a different token.";
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
        return "Swap output below minimum. Try increasing slippage.";
      }
      if (msg.includes("call failed")) {
        return "Swap route failed. Try increasing slippage or use a different token.";
      }
      return `Transaction failed: ${parsed.message}`;
    }
  }
  if (lower.includes("condition not met") || lower.includes("return amount is not enough")) {
    return "Swap output below minimum. Try increasing slippage.";
  }
  if (lower.includes("call failed")) {
    return "Swap route failed. Try increasing slippage or use a different token.";
  }
  const customErrorMatch = errorStr.match(/custom error (0x[0-9a-f]+):\s*([0-9a-f]+)/i);
  if (customErrorMatch) {
    const extracted = extractStringFromHex(customErrorMatch[1] + customErrorMatch[2]);
    if (extracted) return `Transaction failed: ${extracted}`;
  }
  if (lower.includes("revert")) {
    const match = errorStr.match(/reason="([^"]+)"/) || errorStr.match(/reason string '([^']+)'/) || errorStr.match(/reverted[^:]*:\s*(.+?)(?:\n|$)/i);
    if (match) return `Transaction failed: ${match[1].trim()}`;
  }
  return "Transaction failed. Please try again.";
}

async function runTenderlySimulation(
  userAddress: string,
  txTo: string,
  txData: string,
  txValue: string,
  inputToken: string
): Promise<{ ok: boolean; result: SimulationResult | null; errorMessage?: string }> {
  try {
    const nonceResponse = await fetch("/api/simulate/nonce", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
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
    });

    const result = (await response.json()) as SimulationResult & { retryable?: boolean };

    if (process.env.NODE_ENV === "development") {
      console.log("[Tenderly Simulation - Zapper]", {
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
    return {
      ok: false,
      result: null,
      errorMessage: error instanceof Error ? error.message : "Simulation failed",
    };
  }
}

async function checkAllowance(
  publicClient: ReturnType<typeof usePublicClient>,
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

async function checkControllerApproval(
  publicClient: ReturnType<typeof usePublicClient>,
  controller: `0x${string}`,
  owner: `0x${string}`,
  spender: `0x${string}`
): Promise<boolean> {
  if (!publicClient) return false;
  try {
    const approved = await publicClient.readContract({
      address: controller,
      abi: CONTROLLER_APPROVE_ABI,
      functionName: "approval",
      args: [owner, spender],
    });
    return approved as boolean;
  } catch {
    return false;
  }
}

export interface UseZapperActionsResult {
  // Actions
  createLeveragedLoan: (
    controller: `0x${string}`,
    userCollateral: bigint,
    debt: bigint,
    N: number,
    collateralToken: `0x${string}`,
    slippage?: number,
    previewOnly?: boolean
  ) => Promise<SimulationResult | null>;
  leverageUp: (
    controller: `0x${string}`,
    additionalCollateral: bigint,
    additionalDebt: bigint,
    collateralToken: `0x${string}`,
    slippage?: number,
    previewOnly?: boolean
  ) => Promise<SimulationResult | null>;
  deleverage: (
    controller: `0x${string}`,
    collateralToSell: bigint,
    collateralToken: `0x${string}`,
    slippage?: number,
    previewOnly?: boolean
  ) => Promise<SimulationResult | null>;
  deleverageAndWithdraw: (
    controller: `0x${string}`,
    collateralToSell: bigint,
    withdrawAmount: bigint,
    collateralToken: `0x${string}`,
    slippage?: number,
    previewOnly?: boolean
  ) => Promise<SimulationResult | null>;
  deleverageAndWithdrawToToken: (
    controller: `0x${string}`,
    collateralToSell: bigint,
    withdrawAmount: bigint,
    collateralToken: `0x${string}`,
    outputToken: `0x${string}`,
    outputTokenSymbol: string,
    slippage?: number,
    previewOnly?: boolean
  ) => Promise<SimulationResult | null>;
  selfLiquidate: (
    controller: `0x${string}`,
    percentage: bigint,
    collateralToken: `0x${string}`,
    slippage?: number,
    previewOnly?: boolean
  ) => Promise<SimulationResult | null>;
  directLiquidate: (
    controller: `0x${string}`,
    percentage: bigint,
    previewOnly?: boolean,
    crvUsdGap?: bigint
  ) => Promise<SimulationResult | null>;

  // ZapperV2 FromToken operations
  createLeveragedLoanFromToken: (
    controller: `0x${string}`,
    inputToken: `0x${string}`,
    inputAmount: bigint,
    debt: bigint,
    N: number,
    collateralToken: `0x${string}`,
    tokenSymbol: string,
    slippage?: number,
    previewOnly?: boolean
  ) => Promise<SimulationResult | null>;
  leverageUpFromToken: (
    controller: `0x${string}`,
    inputToken: `0x${string}`,
    inputAmount: bigint,
    additionalDebt: bigint,
    collateralToken: `0x${string}`,
    tokenSymbol: string,
    slippage?: number,
    previewOnly?: boolean
  ) => Promise<SimulationResult | null>;

  // Approval
  pendingApproval: PendingApproval | null;
  approvalProgress: {
    step: number;
    total: number;
    steps: { label: string; description: string; done: boolean; spender?: string }[];
  } | null;
  approve: (exactAmount?: boolean) => void;
  isApproving: boolean;
  isApprovalSuccess: boolean;
  executeAfterApproval: () => Promise<void>;

  // State
  status: ZapperStatus;
  txHash: `0x${string}` | null;
  error: string | null;
  simulationResult: SimulationResult | null;
  reset: () => void;
  clearError: () => void;
  executeAfterPreview: () => Promise<void>;
}

export function useZapperActions(): UseZapperActionsResult {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient();
  const { sendTransactionAsync } = useSendTransaction();
  const { isTenderlyVNet, testNetworkType } = useTenderly();

  const [status, setStatus] = useState<ZapperStatus>("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);
  const [pendingTx, setPendingTx] = useState<PendingTx | null>(null);
  const [pendingController, setPendingController] = useState<`0x${string}` | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [approvalQueue, setApprovalQueue] = useState<PendingApproval[]>([]);
  const [approvalProgress, setApprovalProgress] = useState<{
    step: number;
    total: number;
    steps: { label: string; description: string; done: boolean; spender?: string }[];
  } | null>(null);

  // Approval tx
  const {
    writeContract: writeApprove,
    data: approveHash,
    reset: resetApprove,
    isError: isApproveError,
  } = useWriteContract();

  const { isLoading: isApprovalPending, isSuccess: isApprovalSuccess } = useWaitForTransactionReceipt({
    hash: approveHash,
    pollingInterval: 1_000,
  });

  useWaitForTransactionReceipt({
    hash: txHash ?? undefined,
    query: { enabled: !!txHash && status === "waitingTx" },
  });

  const isApproving = useMemo(() => {
    return status === "approving" || isApprovalPending;
  }, [status, isApprovalPending]);

  // Reset to needsApproval if user rejects wallet approval
  useEffect(() => {
    if (isApproveError && status === "approving") {
      setStatus("needsApproval");
      resetApprove();
    }
  }, [isApproveError, status, resetApprove]);

  const reset = useCallback(() => {
    setStatus("idle");
    setTxHash(null);
    setError(null);
    setSimulationResult(null);
    setPendingTx(null);
    setPendingController(null);
    setPendingApproval(null);
    setApprovalQueue([]);
    setApprovalProgress(null);
    resetApprove();
  }, [resetApprove]);

  const clearError = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  const approve = useCallback((exactAmount?: boolean) => {
    if (!address || !pendingApproval) return;
    setStatus("approving");

    if (pendingApproval.type === "erc20") {
      const amount = exactAmount && pendingApproval.amount ? pendingApproval.amount : maxUint256;
      if (process.env.NODE_ENV === "development") {
        console.log(`[Approve TX] ERC20 ${pendingApproval.tokenSymbol} (${pendingApproval.token}) → spender ${pendingApproval.spender} | amount: ${amount === maxUint256 ? "MAX_UINT256" : amount.toString()} | exact: ${!!exactAmount}`);
      }
      writeApprove({
        address: pendingApproval.token,
        abi: ERC20_APPROVAL_ABI,
        functionName: "approve",
        args: [pendingApproval.spender, amount],
      });
    } else {
      if (process.env.NODE_ENV === "development") {
        console.log(`[Approve TX] Controller ${pendingApproval.token} → spender ${pendingApproval.spender} | approve(${pendingApproval.spender}, true)`);
      }
      // Controller approve(address, bool)
      writeApprove({
        address: pendingApproval.token, // controller address
        abi: CONTROLLER_APPROVE_ABI,
        functionName: "approve",
        args: [pendingApproval.spender, true],
      });
    }
  }, [address, pendingApproval, writeApprove]);

  const simulateAndExecute = useCallback(async (
    txData: PendingTx,
    previewOnly: boolean
  ): Promise<SimulationResult | null> => {
    if (!publicClient || !address) return null;

    if (process.env.NODE_ENV === "development") {
      const selector = txData.data.slice(0, 10);
      // Decode function name from known ABIs
      const knownSelectors: Record<string, string> = {};
      for (const entry of [...ZAPPER_ABI, ...CONTROLLER_LIQUIDATE_ABI]) {
        if (entry.type === "function") {
          const sig = `${entry.name}(${entry.inputs.map((i: { type: string }) => i.type).join(",")})`;
          try {
            knownSelectors[toFunctionSelector(sig)] = sig;
          } catch { /* skip malformed */ }
        }
      }
      const fnName = knownSelectors[selector] ?? `unknown(${selector})`;
      console.log(`[TX] ${fnName} → to: ${txData.to} | value: ${txData.value.toString()} wei | inputToken: ${txData.inputToken} | dataLen: ${txData.data.length} | previewOnly: ${previewOnly}`);
      console.log(`[TX data] ${txData.data}`);
    }

    // Three-way simulation:
    // 1. Mainnet (testNetworkType === null, chainId !== 1337) → Tenderly REST API + eth_call
    // 2. Tenderly VNet (testNetworkType === "tenderly") → VNet RPC simulation + eth_call
    // 3. Anvil (testNetworkType === "anvil" or chainId === 1337) → eth_call only
    if (testNetworkType === null && chainId !== 1337) {
      // --- Mainnet: Tenderly REST API + eth_call ---
      setStatus("simulating");

      const [tenderlyResult, ethCallResult] = await Promise.all([
        runTenderlySimulation(
          address,
          txData.to,
          txData.data,
          String(txData.value),
          txData.inputToken
        ),
        (async () => {
          try {
            await publicClient.call({
              account: address,
              to: txData.to,
              data: txData.data,
              value: txData.value,
            });
            if (process.env.NODE_ENV === "development") console.log(`[eth_call] OK | to: ${txData.to} | selector: ${txData.data.slice(0, 10)}`);
            return { ok: true as const };
          } catch (err: unknown) {
            const viemErr = err as { shortMessage?: string; message?: string; data?: string; cause?: { reason?: string; data?: string } };
            const revertData = viemErr.data || viemErr.cause?.data;
            let msg = viemErr.message || viemErr.shortMessage || viemErr.cause?.reason || "eth_call failed";
            if (revertData && typeof revertData === "string" && revertData.startsWith("0x")) {
              const enso = parseEnsoError(revertData.replace(/^0x/, ""));
              if (enso) {
                if (process.env.NODE_ENV === "development") console.log(`[eth_call] Enso error | step: ${enso.step} | target: ${enso.target} | message: ${enso.message}`);
                msg = `enso:${enso.message}`;
              } else {
                msg = msg + " custom error " + revertData;
              }
            }
            if (process.env.NODE_ENV === "development") console.log(`[eth_call] FAILED | to: ${txData.to} | selector: ${txData.data.slice(0, 10)} | error: ${msg.slice(0, 300)}`);
            return { ok: false as const, errorMessage: msg };
          }
        })(),
      ]);

      if (tenderlyResult.result) {
        setSimulationResult(tenderlyResult.result);
      }

      if (previewOnly) {
        setStatus("idle");
        return tenderlyResult.result;
      }

      // eth_call is the ground truth for the chain we're submitting to
      if (!ethCallResult.ok) {
        const errorMsg = ethCallResult.errorMessage || "Simulation failed";
        setError(parseErrorMessage(new Error(errorMsg)));
        setStatus("error");
        return tenderlyResult.result;
      }
      if (!tenderlyResult.ok) {
        if (process.env.NODE_ENV === "development") console.log("[Simulation] Tenderly failed but eth_call passed, proceeding");
      }
    } else if (testNetworkType === "tenderly") {
      // --- Tenderly VNet: RPC simulation + eth_call ---
      setStatus("simulating");

      const [vnetResult, ethCallResult] = await Promise.all([
        runVNetSimulation(
          publicClient.transport,
          { from: address, to: txData.to, data: txData.data, value: `0x${txData.value.toString(16)}` },
          address,
        ),
        (async () => {
          try {
            await publicClient.call({ account: address, to: txData.to, data: txData.data, value: txData.value });
            if (process.env.NODE_ENV === "development") console.log(`[eth_call] OK | to: ${txData.to} | selector: ${txData.data.slice(0, 10)}`);
            return { ok: true as const };
          } catch (err: unknown) {
            const viemErr = err as { shortMessage?: string; message?: string; data?: string; cause?: { reason?: string; data?: string } };
            const revertData = viemErr.data || viemErr.cause?.data;
            let msg = viemErr.message || viemErr.shortMessage || viemErr.cause?.reason || "eth_call failed";
            if (revertData && typeof revertData === "string" && revertData.startsWith("0x")) {
              const enso = parseEnsoError(revertData.replace(/^0x/, ""));
              if (enso) {
                if (process.env.NODE_ENV === "development") console.log(`[eth_call] Enso error | step: ${enso.step} | target: ${enso.target} | message: ${enso.message}`);
                msg = `enso:${enso.message}`;
              } else {
                msg = msg + " custom error " + revertData;
              }
            }
            if (process.env.NODE_ENV === "development") console.log(`[eth_call] FAILED | to: ${txData.to} | selector: ${txData.data.slice(0, 10)} | error: ${msg.slice(0, 300)}`);
            return { ok: false as const, errorMessage: msg };
          }
        })(),
      ]);

      if (vnetResult.result) {
        setSimulationResult(vnetResult.result);
      }

      if (previewOnly) {
        setStatus("idle");
        return vnetResult.result;
      }

      // eth_call is ground truth
      if (!ethCallResult.ok) {
        const errorMsg = ethCallResult.errorMessage || "Simulation failed";
        setError(parseErrorMessage(new Error(errorMsg)));
        setStatus("error");
        return vnetResult.result;
      }
      if (!vnetResult.ok) {
        if (process.env.NODE_ENV === "development") console.log("[Simulation] VNet sim failed but eth_call passed, proceeding");
      }
    } else {
      // --- Anvil / local: eth_call preflight only ---
      setStatus("simulating");
      try {
        await publicClient.call({ account: address, to: txData.to, data: txData.data, value: txData.value });
        if (process.env.NODE_ENV === "development") console.log(`[eth_call] OK | to: ${txData.to} | selector: ${txData.data.slice(0, 10)}`);
      } catch (err: unknown) {
        const viemErr = err as { shortMessage?: string; message?: string; data?: string; cause?: { reason?: string; data?: string } };
        const revertData = viemErr.data || viemErr.cause?.data;
        let msg = viemErr.message || viemErr.shortMessage || viemErr.cause?.reason || "eth_call failed";
        if (revertData && typeof revertData === "string" && revertData.startsWith("0x")) {
          const enso = parseEnsoError(revertData.replace(/^0x/, ""));
          if (enso) {
            if (process.env.NODE_ENV === "development") console.log(`[eth_call] Enso error | step: ${enso.step} | target: ${enso.target} | message: ${enso.message}`);
            msg = `enso:${enso.message}`;
          } else {
            msg = msg + " custom error " + revertData;
          }
        }
        if (process.env.NODE_ENV === "development") console.log(`[eth_call] FAILED | to: ${txData.to} | selector: ${txData.data.slice(0, 10)} | error: ${msg.slice(0, 300)}`);
        setError(parseErrorMessage(new Error(msg)));
        setStatus("error");
        return null;
      }
    }

    // Estimate gas explicitly (wallets like Rabby can underestimate on Anvil forks)
    let gasLimit: bigint | undefined;
    try {
      const gasEstimate = await publicClient.estimateGas({
        account: address,
        to: txData.to,
        data: txData.data,
        value: txData.value,
      });
      gasLimit = gasEstimate * 130n / 100n; // 30% buffer
      if (process.env.NODE_ENV === "development") console.log(`[Gas] estimate: ${gasEstimate} | limit: ${gasLimit} (130%)`);
    } catch {
      if (process.env.NODE_ENV === "development") console.log("[Gas] estimateGas failed, relying on wallet estimate");
    }

    // Snapshot position + balances before TX
    let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
    if (process.env.NODE_ENV === "development" && address) {
      snapBefore = await snapshotTx(publicClient, address, pendingController, [txData.inputToken]);
    }

    // Execute
    setStatus("executing");
    const hash = await sendTransactionAsync({
      to: txData.to,
      data: txData.data,
      value: txData.value,
      ...(gasLimit ? { gas: gasLimit } : {}),
    });

    setTxHash(hash);
    setStatus("waitingTx");

    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: 60_000, // 60s timeout (Anvil auto-mine can hang on block polling)
      pollingInterval: 1_000,
    });

    if (process.env.NODE_ENV === "development") {
      console.log(`[TX Receipt] hash: ${hash} | status: ${receipt.status} | gasUsed: ${receipt.gasUsed.toString()} | blockNumber: ${receipt.blockNumber.toString()}`);
      if (snapBefore && address) {
        const snapAfter = await snapshotTx(publicClient, address, pendingController, [txData.inputToken]);
        logTxDiff("Zapper TX", snapBefore, snapAfter);
      }
    }
    if (receipt.status === "success") {
      setStatus("success");
    } else {
      setStatus("reverted");
      setError("Transaction reverted");
    }

    return simulationResult;
  }, [address, publicClient, sendTransactionAsync, testNetworkType, chainId, simulationResult, pendingController]);

  const executeAfterApproval = useCallback(async () => {
    if (!pendingTx) {
      setError("No pending transaction");
      setStatus("error");
      return;
    }

    // If more approvals in queue, show the next one
    if (approvalQueue.length > 0) {
      const [next, ...rest] = approvalQueue;
      setPendingApproval(next);
      setApprovalQueue(rest);
      // Update progress: mark current step done, advance to next
      if (approvalProgress) {
        const updatedSteps = approvalProgress.steps.map((s, i) =>
          i < approvalProgress.step ? { ...s, done: true } : s
        );
        setApprovalProgress({ ...approvalProgress, step: approvalProgress.step + 1, steps: updatedSteps });
      }
      setStatus("needsApproval");
      resetApprove();
      return;
    }

    setPendingApproval(null);
    setApprovalProgress(null);
    try {
      await simulateAndExecute(pendingTx, false);
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
    }
  }, [pendingTx, approvalQueue, approvalProgress, simulateAndExecute, resetApprove]);

  const executeAfterPreview = useCallback(async () => {
    if (!pendingTx || !publicClient) {
      setError("No pending transaction");
      setStatus("error");
      return;
    }

    try {
      // Estimate gas explicitly (wallets like Rabby can underestimate on Anvil forks)
      let gasLimit: bigint | undefined;
      try {
        const gasEstimate = await publicClient.estimateGas({
          account: address,
          to: pendingTx.to,
          data: pendingTx.data,
          value: pendingTx.value,
        });
        gasLimit = gasEstimate * 130n / 100n;
        if (process.env.NODE_ENV === "development") console.log(`[Gas] estimate: ${gasEstimate} | limit: ${gasLimit} (130%)`);
      } catch {
        if (process.env.NODE_ENV === "development") console.log("[Gas] estimateGas failed, relying on wallet estimate");
      }

      // Snapshot position + balances before TX
      let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
      if (process.env.NODE_ENV === "development" && address) {
        snapBefore = await snapshotTx(publicClient, address, pendingController, [pendingTx.inputToken]);
      }

      setStatus("executing");
      const hash = await sendTransactionAsync({
        to: pendingTx.to,
        data: pendingTx.data,
        value: pendingTx.value,
        ...(gasLimit ? { gas: gasLimit } : {}),
      });

      setTxHash(hash);
      setStatus("waitingTx");

      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: 60_000,
        pollingInterval: 1_000,
      });

      if (process.env.NODE_ENV === "development") {
        console.log(`[TX Receipt] hash: ${hash} | status: ${receipt.status} | gasUsed: ${receipt.gasUsed.toString()} | blockNumber: ${receipt.blockNumber.toString()}`);
        if (snapBefore && address) {
          const snapAfter = await snapshotTx(publicClient, address, pendingController, [pendingTx.inputToken]);
          logTxDiff("Zapper TX", snapBefore, snapAfter);
        }
      }
      if (receipt.status === "success") {
        setStatus("success");
      } else {
        setStatus("reverted");
        setError("Transaction reverted");
      }
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
    }
  }, [pendingTx, publicClient, sendTransactionAsync, address, pendingController]);

  // Check both ERC20 and controller approvals, return first missing
  const checkApprovals = useCallback(async (
    collateralToken: `0x${string}`,
    controller: `0x${string}`,
    inputAmount: bigint,
    tokenSymbol: string
  ): Promise<PendingApproval[]> => {
    if (!publicClient || !address) return [];

    // Check both approvals in parallel
    const [erc20Allowance, controllerApproved] = await Promise.all([
      inputAmount > 0n
        ? checkAllowance(publicClient, address, collateralToken, ZAPPER_V2_ADDRESS as `0x${string}`)
        : Promise.resolve(inputAmount), // no check needed if 0
      checkControllerApproval(publicClient, controller, address, ZAPPER_V2_ADDRESS as `0x${string}`),
    ]);

    const erc20Needed = inputAmount > 0n && erc20Allowance < inputAmount;
    const controllerNeeded = !controllerApproved;

    // Build progress steps for all possible approvals
    const allSteps: { approval: PendingApproval; needed: boolean; label: string; description: string; spender: string }[] = [];

    if (inputAmount > 0n) {
      allSteps.push({
        approval: {
          type: "erc20",
          token: collateralToken,
          tokenSymbol,
          spender: ZAPPER_V2_ADDRESS as `0x${string}`,
          amount: inputAmount,
        },
        needed: erc20Needed,
        label: tokenSymbol,
        description: `Allow yld Zapper to spend ${tokenSymbol}`,
        spender: ZAPPER_V2_ADDRESS,
      });
    }

    allSteps.push({
      approval: {
        type: "controller",
        token: controller,
        tokenSymbol: "Controller",
        spender: ZAPPER_V2_ADDRESS as `0x${string}`,
      },
      needed: controllerNeeded,
      label: "yld Zapper",
      description: "Allow yld Zapper to manage position on LlamaLend controller",
      spender: ZAPPER_V2_ADDRESS,
    });

    const missing = allSteps.filter((s) => s.needed).map((s) => s.approval);

    // Set approval progress if any needed
    if (missing.length > 0) {
      const total = allSteps.length;
      const steps = allSteps.map((s) => ({ label: s.label, description: s.description, done: !s.needed, spender: s.spender }));
      const firstNeededIdx = allSteps.findIndex((s) => s.needed);
      setApprovalProgress({ step: firstNeededIdx + 1, total, steps });
    } else {
      setApprovalProgress(null);
    }

    return missing;
  }, [publicClient, address]);

  const createLeveragedLoan = useCallback(async (
    controller: `0x${string}`,
    userCollateral: bigint,
    debt: bigint,
    N: number,
    collateralToken: `0x${string}`,
    slippage: number = 100,
    previewOnly: boolean = false
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingTx(null);
      setPendingApproval(null);
      setPendingController(controller);

      // Fetch swap route: crvUSD -> collateral token
      const { swapData, expectedOut } = await fetchZapperSwapData({
        tokenIn: CRVUSD_ADDRESS,
        tokenOut: collateralToken,
        amountIn: debt.toString(),
        slippage: String(slippage),
      });

      // Min output with slippage
      const expectedOutBn = BigInt(expectedOut);
      const minCollateralFromSwap = expectedOutBn * BigInt(10000 - slippage) / 10000n;

      const data = encodeFunctionData({
        abi: ZAPPER_ABI,
        functionName: "createLeveragedLoan",
        args: [
          controller,
          userCollateral,
          debt,
          BigInt(N),
          minCollateralFromSwap,
          swapData as `0x${string}`,
          getDeadline(),
        ],
      });

      const tx: PendingTx = {
        to: ZAPPER_V2_ADDRESS as `0x${string}`,
        data: data as `0x${string}`,
        value: 0n,
        inputToken: collateralToken,
      };
      setPendingTx(tx);

      // Check approvals (may need ERC20 + controller)
      const missingApprovals = await checkApprovals(collateralToken, controller, userCollateral, "ycvxCRV");
      if (missingApprovals.length > 0) {
        setPendingApproval(missingApprovals[0]);
        setApprovalQueue(missingApprovals.slice(1));
        setStatus("needsApproval");
        return null;
      }

      return await simulateAndExecute(tx, previewOnly);
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, checkApprovals, simulateAndExecute]);

  const leverageUp = useCallback(async (
    controller: `0x${string}`,
    additionalCollateral: bigint,
    additionalDebt: bigint,
    collateralToken: `0x${string}`,
    slippage: number = 100,
    previewOnly: boolean = false
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingTx(null);
      setPendingApproval(null);
      setPendingController(controller);

      const { swapData, expectedOut } = await fetchZapperSwapData({
        tokenIn: CRVUSD_ADDRESS,
        tokenOut: collateralToken,
        amountIn: additionalDebt.toString(),
        slippage: String(slippage),
      });

      const expectedOutBn = BigInt(expectedOut);
      const minCollateralFromSwap = expectedOutBn * BigInt(10000 - slippage) / 10000n;

      const data = encodeFunctionData({
        abi: ZAPPER_ABI,
        functionName: "leverageUp",
        args: [
          controller,
          additionalCollateral,
          additionalDebt,
          minCollateralFromSwap,
          swapData as `0x${string}`,
          getDeadline(),
        ],
      });

      const tx: PendingTx = {
        to: ZAPPER_V2_ADDRESS as `0x${string}`,
        data: data as `0x${string}`,
        value: 0n,
        inputToken: collateralToken,
      };
      setPendingTx(tx);

      const missingApprovals = await checkApprovals(collateralToken, controller, additionalCollateral, "ycvxCRV");
      if (missingApprovals.length > 0) {
        setPendingApproval(missingApprovals[0]);
        setApprovalQueue(missingApprovals.slice(1));
        setStatus("needsApproval");
        return null;
      }

      return await simulateAndExecute(tx, previewOnly);
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, checkApprovals, simulateAndExecute]);

  const deleverage = useCallback(async (
    controller: `0x${string}`,
    collateralToSell: bigint,
    collateralToken: `0x${string}`,
    slippage: number = 100,
    previewOnly: boolean = false
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingTx(null);
      setPendingApproval(null);
      setPendingController(controller);

      // Swap collateral -> crvUSD
      const { swapData, expectedOut } = await fetchZapperSwapData({
        tokenIn: collateralToken,
        tokenOut: CRVUSD_ADDRESS,
        amountIn: collateralToSell.toString(),
        slippage: String(slippage),
      });

      const expectedOutBn = BigInt(expectedOut);
      const minCrvusdFromSwap = expectedOutBn * BigInt(10000 - slippage) / 10000n;

      const data = encodeFunctionData({
        abi: ZAPPER_ABI,
        functionName: "deleverage",
        args: [
          controller,
          collateralToSell,
          minCrvusdFromSwap,
          swapData as `0x${string}`,
          getDeadline(),
        ],
      });

      const tx: PendingTx = {
        to: ZAPPER_V2_ADDRESS as `0x${string}`,
        data: data as `0x${string}`,
        value: 0n,
        inputToken: collateralToken,
      };
      setPendingTx(tx);

      // Deleverage doesn't need ERC20 approval (collateral is in the controller)
      // but still needs controller approval
      const controllerApproved = await checkControllerApproval(
        publicClient,
        controller,
        address,
        ZAPPER_V2_ADDRESS as `0x${string}`
      );
      if (!controllerApproved) {
        setPendingApproval({
          type: "controller",
          token: controller,
          tokenSymbol: "Controller",
          spender: ZAPPER_V2_ADDRESS as `0x${string}`,
          spenderName: "yld Zapper",
        });
        setStatus("needsApproval");
        return null;
      }

      return await simulateAndExecute(tx, previewOnly);
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, simulateAndExecute]);

  const selfLiquidate = useCallback(async (
    controller: `0x${string}`,
    percentage: bigint,
    collateralToken: `0x${string}`,
    slippage: number = 100,
    previewOnly: boolean = false
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingTx(null);
      setPendingApproval(null);
      setPendingController(controller);

      // For self-liquidate, we need to estimate collateral being sold
      // Use a rough estimate based on position data
      // The zapper handles the actual amounts internally
      const { swapData, expectedOut } = await fetchZapperSwapData({
        tokenIn: collateralToken,
        tokenOut: CRVUSD_ADDRESS,
        // Self-liquidate sells collateral proportional to percentage
        // Use 1 unit as quote to get rate, actual amount handled by zapper
        amountIn: (10n ** 18n).toString(), // 1 token for rate quote
        slippage: String(slippage),
      });

      const expectedOutBn = BigInt(expectedOut);
      const minFromSwap = expectedOutBn * BigInt(10000 - slippage) / 10000n;

      const data = encodeFunctionData({
        abi: ZAPPER_ABI,
        functionName: "selfLiquidate",
        args: [
          controller,
          0n, // minFromAMM — AMM conversion minimum (0 = accept any)
          minFromSwap,
          percentage,
          true, // sellAllCollateral — adapts to actual collateral at execution time
          swapData as `0x${string}`,
          getDeadline(),
        ],
      });

      const tx: PendingTx = {
        to: ZAPPER_V2_ADDRESS as `0x${string}`,
        data: data as `0x${string}`,
        value: 0n,
        inputToken: collateralToken,
      };
      setPendingTx(tx);

      const controllerApproved = await checkControllerApproval(
        publicClient,
        controller,
        address,
        ZAPPER_V2_ADDRESS as `0x${string}`
      );
      if (!controllerApproved) {
        setPendingApproval({
          type: "controller",
          token: controller,
          tokenSymbol: "Controller",
          spender: ZAPPER_V2_ADDRESS as `0x${string}`,
          spenderName: "yld Zapper",
        });
        setStatus("needsApproval");
        return null;
      }

      return await simulateAndExecute(tx, previewOnly);
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, simulateAndExecute]);

  // Check approvals for FromToken operations (inputToken → ZapperV2, optionally controller → ZapperV2)
  const checkFromTokenApprovals = useCallback(async (
    inputToken: `0x${string}`,
    inputAmount: bigint,
    tokenSymbol: string,
    controller?: `0x${string}`,
  ): Promise<PendingApproval[]> => {
    if (!publicClient || !address) return [];

    const [erc20Allowance, controllerApproved] = await Promise.all([
      inputAmount > 0n
        ? checkAllowance(publicClient, address, inputToken, ZAPPER_V2_ADDRESS)
        : Promise.resolve(inputAmount),
      controller
        ? checkControllerApproval(publicClient, controller, address, ZAPPER_V2_ADDRESS)
        : Promise.resolve(true),
    ]);

    const erc20Needed = inputAmount > 0n && erc20Allowance < inputAmount;
    const controllerNeeded = controller ? !controllerApproved : false;

    const allSteps: { approval: PendingApproval; needed: boolean; label: string; description: string; spender: string }[] = [];

    if (inputAmount > 0n) {
      allSteps.push({
        approval: {
          type: "erc20",
          token: inputToken,
          tokenSymbol,
          spender: ZAPPER_V2_ADDRESS,
          amount: inputAmount,
        },
        needed: erc20Needed,
        label: tokenSymbol,
        description: `Allow yld Zapper to spend ${tokenSymbol}`,
        spender: ZAPPER_V2_ADDRESS,
      });
    }

    if (controller) {
      allSteps.push({
        approval: {
          type: "controller",
          token: controller,
          tokenSymbol: "Controller",
          spender: ZAPPER_V2_ADDRESS,
        },
        needed: controllerNeeded,
        label: "yld Zapper",
        description: "Allow yld Zapper to manage position on LlamaLend controller",
        spender: ZAPPER_V2_ADDRESS,
      });
    }

    const missing = allSteps.filter((s) => s.needed).map((s) => s.approval);

    if (missing.length > 0) {
      const total = allSteps.length;
      const steps = allSteps.map((s) => ({ label: s.label, description: s.description, done: !s.needed, spender: s.spender }));
      const firstNeededIdx = allSteps.findIndex((s) => s.needed);
      setApprovalProgress({ step: firstNeededIdx + 1, total, steps });
    } else {
      setApprovalProgress(null);
    }

    return missing;
  }, [publicClient, address]);

  // ZapperV2: Deleverage + withdraw collateral in one tx
  const deleverageAndWithdraw = useCallback(async (
    controller: `0x${string}`,
    collateralToSell: bigint,
    withdrawAmount: bigint,
    collateralToken: `0x${string}`,
    slippage: number = 100,
    previewOnly: boolean = false
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingTx(null);
      setPendingApproval(null);
      setPendingController(controller);

      // Swap collateral -> crvUSD
      const { swapData, expectedOut } = await fetchZapperSwapData({
        tokenIn: collateralToken,
        tokenOut: CRVUSD_ADDRESS,
        amountIn: collateralToSell.toString(),
        slippage: String(slippage),
      });

      const expectedOutBn = BigInt(expectedOut);
      const minCrvusdFromSwap = expectedOutBn * BigInt(10000 - slippage) / 10000n;

      const data = encodeFunctionData({
        abi: ZAPPER_ABI,
        functionName: "deleverageAndWithdraw",
        args: [
          controller,
          collateralToSell,
          minCrvusdFromSwap,
          withdrawAmount,
          swapData as `0x${string}`,
          getDeadline(),
        ],
      });

      const tx: PendingTx = {
        to: ZAPPER_V2_ADDRESS,
        data: data as `0x${string}`,
        value: 0n,
        inputToken: collateralToken,
      };
      setPendingTx(tx);

      // Need controller approval for ZapperV2 (no ERC20 approval — collateral is in the controller)
      const missingApprovals = await checkFromTokenApprovals(
        collateralToken, 0n, "", controller
      );
      if (missingApprovals.length > 0) {
        setPendingApproval(missingApprovals[0]);
        setApprovalQueue(missingApprovals.slice(1));
        setStatus("needsApproval");
        return null;
      }

      return await simulateAndExecute(tx, previewOnly);
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, checkFromTokenApprovals, simulateAndExecute]);

  // ZapperV2: Deleverage + withdraw collateral as a different token
  const deleverageAndWithdrawToToken = useCallback(async (
    controller: `0x${string}`,
    collateralToSell: bigint,
    withdrawAmount: bigint,
    collateralToken: `0x${string}`,
    outputToken: `0x${string}`,
    outputTokenSymbol: string,
    slippage: number = 100,
    previewOnly: boolean = false
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingTx(null);
      setPendingApproval(null);
      setPendingController(controller);

      // Two swap routes in parallel:
      // 1. collateral → crvUSD (deleverage swap)
      // 2. collateral → outputToken (withdrawal swap)
      const [deleverageRoute, outputRoute] = await Promise.all([
        fetchZapperSwapData({
          tokenIn: collateralToken,
          tokenOut: CRVUSD_ADDRESS,
          amountIn: collateralToSell.toString(),
          slippage: String(slippage),
        }),
        fetchZapperSwapData({
          tokenIn: collateralToken,
          tokenOut: outputToken,
          amountIn: withdrawAmount.toString(),
          slippage: String(slippage),
        }),
      ]);

      const minCrvusdFromSwap = BigInt(deleverageRoute.expectedOut) * BigInt(10000 - slippage) / 10000n;
      const minOutputFromSwap = BigInt(outputRoute.expectedOut) * BigInt(10000 - slippage) / 10000n;

      const data = encodeFunctionData({
        abi: ZAPPER_ABI,
        functionName: "deleverageAndWithdrawToToken",
        args: [
          controller,
          collateralToSell,
          minCrvusdFromSwap,
          withdrawAmount,
          outputToken,
          minOutputFromSwap,
          deleverageRoute.swapData as `0x${string}`,
          outputRoute.swapData as `0x${string}`,
          getDeadline(),
        ],
      });

      const tx: PendingTx = {
        to: ZAPPER_V2_ADDRESS,
        data: data as `0x${string}`,
        value: 0n,
        inputToken: collateralToken,
      };
      setPendingTx(tx);

      // Need controller approval for ZapperV2
      const missingApprovals = await checkFromTokenApprovals(
        collateralToken, 0n, "", controller
      );
      if (missingApprovals.length > 0) {
        setPendingApproval(missingApprovals[0]);
        setApprovalQueue(missingApprovals.slice(1));
        setStatus("needsApproval");
        return null;
      }

      return await simulateAndExecute(tx, previewOnly);
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, checkFromTokenApprovals, simulateAndExecute]);

  // ZapperV2: Create leveraged loan from any input token (pre-swap + loop leverage)
  const createLeveragedLoanFromToken = useCallback(async (
    controller: `0x${string}`,
    inputToken: `0x${string}`,
    inputAmount: bigint,
    debt: bigint,
    N: number,
    collateralToken: `0x${string}`,
    tokenSymbol: string,
    slippage: number = 100,
    previewOnly: boolean = false
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingTx(null);
      setPendingApproval(null);
      setPendingController(controller);

      const routes = await fetchFromTokenSwapData({
        inputToken,
        collateralToken,
        inputAmount: inputAmount.toString(),
        debtAmount: debt.toString(),
        slippage: String(slippage),
      });

      const minCollateralFromInput = BigInt(routes.inputExpectedOut) * BigInt(10000 - slippage) / 10000n;
      const minCollateralFromDebt = BigInt(routes.leverageExpectedOut) * BigInt(10000 - slippage) / 10000n;

      const data = encodeFunctionData({
        abi: ZAPPER_ABI,
        functionName: "createLeveragedLoanFromToken",
        args: [
          controller,
          inputToken,
          inputAmount,
          debt,
          BigInt(N),
          minCollateralFromInput,
          minCollateralFromDebt,
          routes.inputSwapData as `0x${string}`,
          routes.leverageSwapData as `0x${string}`,
          getDeadline(),
        ],
      });

      const tx: PendingTx = {
        to: ZAPPER_V2_ADDRESS,
        data: data as `0x${string}`,
        value: 0n,
        inputToken,
      };
      setPendingTx(tx);

      // Only need inputToken → ZapperV2 approval (no controller approval for new loans)
      const missingApprovals = await checkFromTokenApprovals(inputToken, inputAmount, tokenSymbol);
      if (missingApprovals.length > 0) {
        setPendingApproval(missingApprovals[0]);
        setApprovalQueue(missingApprovals.slice(1));
        setStatus("needsApproval");
        return null;
      }

      return await simulateAndExecute(tx, previewOnly);
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, checkFromTokenApprovals, simulateAndExecute]);

  // ZapperV2: Leverage up existing position from any input token
  const leverageUpFromToken = useCallback(async (
    controller: `0x${string}`,
    inputToken: `0x${string}`,
    inputAmount: bigint,
    additionalDebt: bigint,
    collateralToken: `0x${string}`,
    tokenSymbol: string,
    slippage: number = 100,
    previewOnly: boolean = false
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingTx(null);
      setPendingApproval(null);
      setPendingController(controller);

      const routes = await fetchFromTokenSwapData({
        inputToken,
        collateralToken,
        inputAmount: inputAmount.toString(),
        debtAmount: additionalDebt.toString(),
        slippage: String(slippage),
      });

      const minCollateralFromInput = BigInt(routes.inputExpectedOut) * BigInt(10000 - slippage) / 10000n;
      const minCollateralFromDebt = BigInt(routes.leverageExpectedOut) * BigInt(10000 - slippage) / 10000n;

      const data = encodeFunctionData({
        abi: ZAPPER_ABI,
        functionName: "leverageUpFromToken",
        args: [
          controller,
          inputToken,
          inputAmount,
          additionalDebt,
          minCollateralFromInput,
          minCollateralFromDebt,
          routes.inputSwapData as `0x${string}`,
          routes.leverageSwapData as `0x${string}`,
          getDeadline(),
        ],
      });

      const tx: PendingTx = {
        to: ZAPPER_V2_ADDRESS,
        data: data as `0x${string}`,
        value: 0n,
        inputToken,
      };
      setPendingTx(tx);

      // Need inputToken → ZapperV2 + controller → ZapperV2 (existing position)
      const missingApprovals = await checkFromTokenApprovals(inputToken, inputAmount, tokenSymbol, controller);
      if (missingApprovals.length > 0) {
        setPendingApproval(missingApprovals[0]);
        setApprovalQueue(missingApprovals.slice(1));
        setStatus("needsApproval");
        return null;
      }

      return await simulateAndExecute(tx, previewOnly);
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, checkFromTokenApprovals, simulateAndExecute]);

  // Direct liquidation — calls controller.liquidate() directly (no Zapper/swap needed)
  // User == msg.sender → no health check, no liquidation discount
  // If crvUsdGap > 0, user needs crvUSD in wallet + ERC20 approval to controller
  const directLiquidate = useCallback(async (
    controller: `0x${string}`,
    percentage: bigint, // 1e18 scale (100% = 10n**18n)
    previewOnly: boolean = false,
    crvUsdGap: bigint = 0n, // crvUSD user needs to provide from wallet
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingTx(null);
      setPendingApproval(null);
      setPendingController(controller);

      const isFullLiquidation = percentage >= 10n ** 18n;

      const data = isFullLiquidation
        ? encodeFunctionData({
            abi: CONTROLLER_LIQUIDATE_ABI,
            functionName: "liquidate",
            args: [address, 0n],
          })
        : encodeFunctionData({
            abi: CONTROLLER_LIQUIDATE_ABI,
            functionName: "liquidate_extended",
            args: [
              address,
              0n, // min_x
              percentage,
              "0x0000000000000000000000000000000000000000" as `0x${string}`, // no callbacker
              [], // no callback_args
            ],
          });

      const tx: PendingTx = {
        to: controller,
        data: data as `0x${string}`,
        value: 0n,
        inputToken: CRVUSD_ADDRESS,
      };
      setPendingTx(tx);

      // If user needs to provide crvUSD for the gap (debt > AMM stablecoin), check approval
      if (crvUsdGap > 0n) {
        const allowance = await checkAllowance(publicClient, address, CRVUSD_ADDRESS, controller);
        if (allowance < crvUsdGap) {
          const approval: PendingApproval = {
            type: "erc20",
            token: CRVUSD_ADDRESS,
            tokenSymbol: "crvUSD",
            spender: controller,
            amount: crvUsdGap,
          };
          setPendingApproval(approval);
          setApprovalQueue([]);
          setApprovalProgress({
            step: 1,
            total: 1,
            steps: [{
              label: "crvUSD",
              description: "Allow controller to spend crvUSD for debt gap",
              spender: controller,
              done: false,
            }],
          });
          setStatus("needsApproval");
          return null;
        }
      }

      return await simulateAndExecute(tx, previewOnly);
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, simulateAndExecute]);

  return {
    createLeveragedLoan,
    leverageUp,
    deleverage,
    deleverageAndWithdraw,
    deleverageAndWithdrawToToken,
    selfLiquidate,
    directLiquidate,
    createLeveragedLoanFromToken,
    leverageUpFromToken,
    pendingApproval,
    approvalProgress,
    approve,
    isApproving,
    isApprovalSuccess,
    executeAfterApproval,
    status,
    txHash,
    error,
    simulationResult,
    reset,
    clearError,
    executeAfterPreview,
  };
}
