"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import { useAccount, usePublicClient, useWaitForTransactionReceipt } from "wagmi";
import { useVNetSendTransaction as useSendTransaction } from "@/hooks/useVNetSendTransaction";
import { useVNetWriteContract as useWriteContract } from "@/hooks/useVNetWriteContract";
import { maxUint256 } from "viem";
import {
  fetchAddCollateralWithSwapBundle,
  fetchCreateLoanWithSwapBundle,
  fetchCreateLoanWithOutputSwapBundle,
  fetchRemoveCollateralAndSwapBundle,
  fetchRepayBundle,
  fetchRepayWithSwapBundle,
  fetchRepayAndWithdrawBundle,
  fetchBorrowAndSwapBundle,
  fetchBorrowWithSwapCollateralBundle,
  getVaultInfo,
  CURVE_CONTROLLERS,
} from "@/lib/curve-lending";
import { TOKENS, getVaultByAddress } from "@/config/vaults";
import { ERC20_APPROVAL_ABI, CONTROLLER_APPROVE_ABI } from "@/lib/abis";
import { ETH_ADDRESS, ENSO_SHORTCUTS } from "@/lib/enso";
import { CRVUSD_ADDRESS } from "@/lib/zapper";
import type { EnsoBundleResponse, SimulationResult } from "@/types/enso";
import { useTenderly } from "@/contexts/TenderlyContext";
import { useFlashbotsProtect } from "@/hooks/useFlashbotsProtect";
import { runVNetSimulation } from "@/lib/vnet-simulation";
import { snapshotTx, logTxDiff } from "@/lib/dev-logging";

async function devEthCall(
  publicClient: ReturnType<typeof usePublicClient>,
  params: { account: `0x${string}`; to: `0x${string}`; data: `0x${string}`; value?: bigint },
): Promise<{ ok: true } | { ok: false; errorMessage: string }> {
  try {
    await publicClient!.call(params);
    if (process.env.NODE_ENV === "development") console.log("[eth_call]", { ok: true, to: params.to });
    return { ok: true };
  } catch (err: unknown) {
    // viem puts raw revert data in cause.data for unrecognized custom errors
    const viemErr = err as { shortMessage?: string; message?: string; data?: string; cause?: { reason?: string; data?: string; message?: string } };
    const revertData = viemErr.data || viemErr.cause?.data;
    let msg = viemErr.message || viemErr.shortMessage || viemErr.cause?.reason || "eth_call failed";
    // If we have raw revert data, try structured Enso error parsing first
    if (revertData && typeof revertData === "string" && revertData.startsWith("0x")) {
      const enso = parseEnsoError(revertData.replace(/^0x/, ""));
      if (enso) {
        if (process.env.NODE_ENV === "development") console.log("[eth_call] Enso error", { step: enso.step, target: enso.target, message: enso.message });
        msg = `enso:${enso.message}`; // prefix so parseErrorMessage can match
      } else {
        // Append raw hex so parseErrorMessage regex can find it
        msg = msg + " custom error " + revertData;
      }
    }
    if (process.env.NODE_ENV === "development") console.log("[eth_call]", { ok: false, to: params.to, error: msg.slice(0, 300), revertData: revertData?.slice(0, 100) });
    return { ok: false, errorMessage: msg };
  }
}

export type LendingStatus =
  | "idle"
  | "building" // Building the transaction bundle
  | "simulating" // Running Tenderly simulation
  | "needsApproval" // Waiting for user to approve
  | "approving" // Approval tx sent, waiting for confirmation
  | "executing" // Sending main transaction
  | "waitingTx" // Waiting for main tx to confirm
  | "success"
  | "reverted"
  | "error";

export type { PendingApproval } from "@/types/approval";
import type { PendingApproval } from "@/types/approval";

export interface UseCurveLendingActionsResult {
  // Action functions - now support previewOnly option
  createLoan: (
    vaultAddress: `0x${string}`,
    collateralAmount: string,
    debtAmount: string,
    bands: number,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ) => Promise<SimulationResult | null>;
  createLoanWithSwap: (
    vaultAddress: `0x${string}`,
    tokenIn: string,
    amountIn: string,
    debtAmount: string,
    bands: number,
    slippage?: number,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ) => Promise<SimulationResult | null>;
  createLoanWithOutputSwap: (
    vaultAddress: `0x${string}`,
    tokenIn: string | undefined,
    amountIn: string,
    debtAmount: string,
    bands: number,
    tokenOut: string,
    slippage?: number,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ) => Promise<SimulationResult | null>;
  addCollateral: (
    vaultAddress: `0x${string}`,
    collateralAmount: string,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ) => Promise<SimulationResult | null>;
  removeCollateral: (
    vaultAddress: `0x${string}`,
    collateralAmount: string,
    options?: { previewOnly?: boolean }
  ) => Promise<SimulationResult | null>;
  addCollateralWithSwap: (
    vaultAddress: `0x${string}`,
    tokenIn: string,
    amountIn: string,
    slippage?: number,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ) => Promise<SimulationResult | null>;
  removeCollateralAndSwap: (
    vaultAddress: `0x${string}`,
    collateralAmount: string,
    tokenOut: string,
    slippage?: number,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ) => Promise<SimulationResult | null>;
  borrowMore: (
    vaultAddress: `0x${string}`,
    additionalCollateral: string,
    additionalDebt: string,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ) => Promise<SimulationResult | null>;
  borrowMoreWithSwap: (
    vaultAddress: `0x${string}`,
    tokenIn: string,
    amountIn: string,
    additionalDebt: string,
    decimals?: number,
    slippage?: number,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ) => Promise<SimulationResult | null>;
  repay: (
    vaultAddress: `0x${string}`,
    repayAmount: string,
    options?: { previewOnly?: boolean }
  ) => Promise<SimulationResult | null>;
  repayDirect: (
    controllerAddress: `0x${string}`,
    repayAmount: bigint,
    options?: { previewOnly?: boolean; closeLoan?: boolean }
  ) => Promise<SimulationResult | null>;
  repayWithSwap: (
    vaultAddress: `0x${string}`,
    tokenIn: string,
    amountIn: string,
    decimals?: number,
    slippage?: number,
    options?: { previewOnly?: boolean; tokenSymbol?: string; inSoftLiquidation?: boolean; withdrawAmount?: string; withdrawTokenOut?: string; withdrawTokenSymbol?: string }
  ) => Promise<SimulationResult | null>;
  repayAndWithdraw: (
    controllerAddress: `0x${string}`,
    repayAmount: bigint,
    withdrawAmount: bigint,
    vaultAddress: `0x${string}`,
    options?: { previewOnly?: boolean; closeLoan?: boolean; withdrawTokenOut?: string; withdrawTokenSymbol?: string }
  ) => Promise<SimulationResult | null>;
  borrowAndSwap: (
    vaultAddress: `0x${string}`,
    tokenOut: string,
    debtAmount: string,
    slippage: number,
    options?: { previewOnly?: boolean; tokenSymbol?: string; estimatedSwapOutput?: bigint; collateralAmount?: string }
  ) => Promise<SimulationResult | null>;
  selfLiquidate: (
    vaultAddress: `0x${string}`,
    slippage?: number,
    options?: { previewOnly?: boolean }
  ) => Promise<SimulationResult | null>;

  // Approval - now based on bundle.tx.to
  pendingApproval: PendingApproval | null;
  approvalProgress: {
    step: number;
    total: number;
    steps: { label: string; description: string; done: boolean; spender?: string }[];
  } | null;
  approve: (exactApproval?: boolean) => void;
  isApproving: boolean;
  isApprovalSuccess: boolean;
  executeAfterApproval: () => Promise<void>;

  // State
  status: LendingStatus;
  txHash: `0x${string}` | null;
  error: string | null;
  simulationResult: SimulationResult | null;
  pendingBundle: EnsoBundleResponse | null;
  reset: () => void;
  clearError: () => void;
  // Execute after preview
  executeAfterPreview: () => Promise<void>;
}

// Decode Enso Shortcuts error: error(uint256 step, address target, string message)
// Selector: 0xef3dcb2f
function parseEnsoError(hexData: string): { step: number; target: string; message: string } | null {
  const data = hexData.replace(/^0x/, "").replace(/\.\s*$/, "");
  // Must start with ef3dcb2f selector
  if (!data.toLowerCase().startsWith("ef3dcb2f")) return null;
  const body = data.slice(8); // remove selector
  if (body.length < 192) return null; // need at least 3 words + string length + data
  const step = parseInt(body.slice(0, 64), 16);
  const target = "0x" + body.slice(88, 128); // address is right-padded in 32 bytes
  const strOffset = parseInt(body.slice(128, 192), 16) * 2; // byte offset → hex offset
  const strLenHex = body.slice(192, 256);
  const strLen = parseInt(strLenHex, 16);
  if (strLen > 0 && strLen <= 256 && 256 + strLen * 2 <= body.length) {
    const strHex = body.slice(256, 256 + strLen * 2);
    try {
      const message = strHex.match(/.{2}/g)!.map(b => String.fromCharCode(parseInt(b, 16))).join("");
      if (/^[\x20-\x7e]+$/.test(message)) {
        return { step, target, message };
      }
    } catch { /* invalid */ }
  }
  return null;
}

// Fallback: scan ABI-encoded hex for any embedded string
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

  // User rejection
  if (lower.includes("user rejected") || lower.includes("user denied")) {
    return "Transaction cancelled";
  }

  // Insufficient balance
  if (lower.includes("insufficient") || lower.includes("exceeds balance")) {
    return "Insufficient balance";
  }

  // Slippage
  if (lower.includes("slippage") || lower.includes("insufficient_output")) {
    return "Price moved too much. Try increasing slippage.";
  }

  // Health check
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

  // Generic Enso/DEX assertion failures (when hex parsing fails)
  if (lower.includes("condition not met") || lower.includes("return amount is not enough")) {
    return "Swap output below minimum. Try increasing slippage.";
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

  // Generic revert — try to extract the reason string
  if (lower.includes("revert")) {
    // viem format: reason="..." or reverted with reason string '...'
    const match = errorStr.match(/reason="([^"]+)"/) || errorStr.match(/reason string '([^']+)'/) || errorStr.match(/reverted[^:]*:\s*(.+?)(?:\n|$)/i);
    if (match) return `Transaction failed: ${match[1].trim()}`;
  }

  return "Transaction failed. Please try again.";
}

// Run Tenderly simulation
async function runTenderlySimulation(
  userAddress: string,
  txTo: string,
  txData: string,
  txValue: string,
  inputToken: string
): Promise<{ ok: boolean; result: SimulationResult | null; errorMessage?: string }> {
  try {
    // Get nonce first
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

    // Run simulation
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
      console.log("[Tenderly Simulation - Lending]", {
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
    const msg = result.errorMessage;
    const errorStr = typeof msg === "string" ? msg : msg?.message ?? "Simulation failed";
    return { ok: false, result, errorMessage: errorStr };
  } catch (error) {
    return {
      ok: false,
      result: null,
      errorMessage: error instanceof Error ? error.message : "Simulation failed",
    };
  }
}

// Check allowance for a token against a spender
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

export function useCurveLendingActions(): UseCurveLendingActionsResult {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient();
  const { sendTransactionAsync } = useSendTransaction();
  const { writeContractAsync } = useWriteContract();
  const { testNetworkType } = useTenderly();
  const { isFlashbotsEnabled, sendViaFlashbots } = useFlashbotsProtect();

  // Flashbots-aware transaction sender: routes through private mempool on mainnet
  const sendTx = useCallback(async (
    txParams: { to: `0x${string}`; data: `0x${string}`; value?: bigint }
  ): Promise<`0x${string}`> => {
    if (isFlashbotsEnabled && testNetworkType === null && chainId === 1) {
      try {
        return await sendViaFlashbots(txParams);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        // Wallet doesn't support eth_signTransaction — fall back to regular send
        const isUnsupportedMethod = errorMsg.includes("eth_signTransaction") &&
          (errorMsg.includes("not supported") || errorMsg.includes("does not exist"));
        if (isUnsupportedMethod) {
          return sendTransactionAsync(txParams);
        }
        throw err;
      }
    }
    return sendTransactionAsync(txParams);
  }, [isFlashbotsEnabled, sendViaFlashbots, sendTransactionAsync, testNetworkType, chainId]);

  const [status, setStatus] = useState<LendingStatus>("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);
  const [pendingBundle, setPendingBundle] = useState<EnsoBundleResponse | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [approvalProgress, setApprovalProgress] = useState<{
    step: number;
    total: number;
    steps: { label: string; description: string; done: boolean; spender?: string }[];
  } | null>(null);
  const [pendingInputToken, setPendingInputToken] = useState<string | null>(null);
  const [pendingController, setPendingController] = useState<`0x${string}` | null>(null);

  // Approve contract
  const {
    writeContract: writeApprove,
    data: approveHash,
    reset: resetApprove,
    isError: isApproveError,
  } = useWriteContract();

  // Wait for approval tx
  const { isLoading: isApprovalPending, isSuccess: isApprovalSuccess } = useWaitForTransactionReceipt({
    hash: approveHash,
    pollingInterval: 1_000,
  });

  // Wait for main transaction receipt
  useWaitForTransactionReceipt({
    hash: txHash ?? undefined,
    query: {
      enabled: !!txHash && status === "waitingTx",
    },
  });

  // Derive isApproving from status and approval pending state
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
    setPendingBundle(null);
    setPendingApproval(null);
    setApprovalProgress(null);
    setPendingInputToken(null);
    setPendingController(null);
    resetApprove();
  }, [resetApprove]);

  // Light reset: clears error/status but keeps simulation + bundle cached
  const clearError = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  // Approve using the pending approval info — supports both ERC20 and controller approval
  // When exactApproval is true and amount is available, approve only the needed amount
  const approve = useCallback((exactApproval?: boolean) => {
    if (!address || !pendingApproval) return;
    setStatus("approving");

    if (pendingApproval.type === "controller") {
      // Controller approve(address, bool)
      writeApprove({
        address: pendingApproval.token, // controller address
        abi: CONTROLLER_APPROVE_ABI,
        functionName: "approve",
        args: [pendingApproval.spender, true],
      });
    } else {
      const approvalAmount = exactApproval && pendingApproval.amount
        ? pendingApproval.amount
        : maxUint256;
      // ERC20 approve(address, uint256)
      writeApprove({
        address: pendingApproval.token,
        abi: ERC20_APPROVAL_ABI,
        functionName: "approve",
        args: [pendingApproval.spender, approvalAmount],
      });
    }
  }, [address, pendingApproval, writeApprove]);

  // Execute the pending bundle after approval
  const executeAfterApproval = useCallback(async () => {
    if (!pendingBundle || !publicClient || !address || !pendingInputToken) {
      setError("No pending transaction");
      setStatus("error");
      return;
    }

    try {
      // Clear approval state
      setPendingApproval(null);

      // Simulate: mainnet → REST API, tenderly VNet → RPC sim, anvil → eth_call only
      const bundleTxParams = {
        to: pendingBundle.tx.to as `0x${string}`,
        data: pendingBundle.tx.data as `0x${string}`,
        value: pendingBundle.tx.value ? BigInt(pendingBundle.tx.value) : 0n,
      };

      if (testNetworkType === null && chainId !== 1337) {
        setStatus("simulating");

        const [tenderlyResult, ethCallResult] = await Promise.all([
          runTenderlySimulation(
            address,
            pendingBundle.tx.to,
            pendingBundle.tx.data,
            pendingBundle.tx.value || "0",
            pendingInputToken
          ),
          devEthCall(publicClient, { account: address, ...bundleTxParams }),
        ]);

        if (tenderlyResult.result) {
          setSimulationResult(tenderlyResult.result);
        }

        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return;
        }
        if (!tenderlyResult.ok) {
          if (process.env.NODE_ENV === "development") console.log("[Simulation] Tenderly failed but eth_call passed, proceeding");
        }
      } else if (testNetworkType === "tenderly") {
        setStatus("simulating");

        const [vnetResult, ethCallResult] = await Promise.all([
          runVNetSimulation(
            publicClient.transport,
            { from: address, to: pendingBundle.tx.to, data: pendingBundle.tx.data, value: `0x${bundleTxParams.value.toString(16)}` },
            address,
          ),
          devEthCall(publicClient, { account: address, ...bundleTxParams }),
        ]);

        if (vnetResult.result) {
          setSimulationResult(vnetResult.result);
        }

        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return;
        }
        if (!vnetResult.ok) {
          if (process.env.NODE_ENV === "development") console.log("[Simulation] VNet sim failed but eth_call passed, proceeding");
        }
      } else {
        const ethCallResult = await devEthCall(publicClient, { account: address, ...bundleTxParams });
        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return;
        }
      }

      // Snapshot position + balances before TX
      let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
      if (process.env.NODE_ENV === "development" && address) {
        snapBefore = await snapshotTx(publicClient, address, pendingController, [pendingInputToken]);
      }

      // Execute the transaction
      setStatus("executing");

      if (process.env.NODE_ENV === "development") console.log("[TX]", { to: pendingBundle.tx.to, selector: (pendingBundle.tx.data as string).slice(0, 10), data: pendingBundle.tx.data });
      const hash = await sendTx({
        to: pendingBundle.tx.to as `0x${string}`,
        data: pendingBundle.tx.data as `0x${string}`,
        value: pendingBundle.tx.value ? BigInt(pendingBundle.tx.value) : 0n,
      });

      setTxHash(hash);
      setStatus("waitingTx");

      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: 60_000,
        pollingInterval: 1_000,
      });

      if (process.env.NODE_ENV === "development") {
        console.log("[TX Receipt]", { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() });
        if (snapBefore && address) {
          const snapAfter = await snapshotTx(publicClient, address, pendingController, [pendingInputToken]);
          logTxDiff("Lending TX", snapBefore, snapAfter);
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
  }, [pendingBundle, publicClient, address, pendingInputToken, sendTx, testNetworkType, chainId, pendingController]);

  // Execute a pending bundle after preview confirmation
  const executeAfterPreview = useCallback(async () => {
    if (!pendingBundle || !publicClient) {
      setError("No pending transaction");
      setStatus("error");
      return;
    }

    try {
      // Snapshot position + balances before TX
      let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
      if (process.env.NODE_ENV === "development" && address) {
        snapBefore = await snapshotTx(publicClient, address, pendingController, [pendingInputToken ?? ""]);
      }

      setStatus("executing");

      if (process.env.NODE_ENV === "development") console.log("[TX]", { to: pendingBundle.tx.to, selector: (pendingBundle.tx.data as string).slice(0, 10), data: pendingBundle.tx.data });
      const hash = await sendTx({
        to: pendingBundle.tx.to as `0x${string}`,
        data: pendingBundle.tx.data as `0x${string}`,
        value: pendingBundle.tx.value ? BigInt(pendingBundle.tx.value) : 0n,
      });

      setTxHash(hash);
      setStatus("waitingTx");

      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: 60_000,
        pollingInterval: 1_000,
      });

      if (process.env.NODE_ENV === "development") {
        console.log("[TX Receipt]", { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() });
        if (snapBefore && address) {
          const snapAfter = await snapshotTx(publicClient, address, pendingController, [pendingInputToken ?? ""]);
          logTxDiff("Lending TX", snapBefore, snapAfter);
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
  }, [pendingBundle, publicClient, sendTx, address, pendingController, pendingInputToken]);

  const executeBundle = useCallback(async (
    bundleFn: () => Promise<EnsoBundleResponse>,
    inputToken: string,
    inputAmount: bigint,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
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
      setPendingBundle(null);
      setPendingApproval(null);

      // Build the bundle
      const bundle = await bundleFn();

      // Store the bundle and input token for potential execution after approval/preview
      setPendingBundle(bundle);
      setPendingInputToken(inputToken);

      // In router mode, bundle.tx.to is ENSO_ROUTER_EXECUTOR, but the actual
      // token pull (transferFrom) is done by ENSO_SHORTCUTS inside the bundle.
      // We must check/request approval for ENSO_SHORTCUTS, not the router executor.
      const spender = ENSO_SHORTCUTS as `0x${string}`;

      // Check allowance against the actual spender (ENSO_SHORTCUTS)
      // Skip for actions that don't require approval:
      // - ETH (native token, not ERC20)
      // - Remove collateral, self-liquidate (we receive tokens, not send)
      const isEth = inputToken.toLowerCase() === ETH_ADDRESS.toLowerCase();
      if (inputAmount > 0n && !isEth) {
        const currentAllowance = await checkAllowance(
          publicClient,
          address,
          inputToken as `0x${string}`,
          spender
        );

        if (currentAllowance < inputAmount) {
          // Need approval - set state and return
          setPendingApproval({
            token: inputToken as `0x${string}`,
            tokenSymbol: options?.tokenSymbol ?? "tokens",
            spender,
            spenderName: "Enso Shortcuts",
            amount: inputAmount,
          });
          setStatus("needsApproval");
          return null;
        }
      }

      // Simulate: mainnet → REST API, tenderly VNet → RPC sim, anvil → eth_call only
      const bundleTxParams = {
        to: bundle.tx.to as `0x${string}`,
        data: bundle.tx.data as `0x${string}`,
        value: bundle.tx.value ? BigInt(bundle.tx.value) : 0n,
      };

      if (testNetworkType === null && chainId !== 1337) {
        setStatus("simulating");

        const [tenderlyResult, ethCallResult] = await Promise.all([
          runTenderlySimulation(address, bundle.tx.to, bundle.tx.data, bundle.tx.value || "0", inputToken),
          devEthCall(publicClient, { account: address, ...bundleTxParams }),
        ]);

        if (tenderlyResult.result) setSimulationResult(tenderlyResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return tenderlyResult.result;
        }

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
        setStatus("simulating");

        const [vnetResult, ethCallResult] = await Promise.all([
          runVNetSimulation(
            publicClient.transport,
            { from: address, to: bundle.tx.to, data: bundle.tx.data, value: `0x${bundleTxParams.value.toString(16)}` },
            address,
          ),
          devEthCall(publicClient, { account: address, ...bundleTxParams }),
        ]);

        if (vnetResult.result) setSimulationResult(vnetResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return vnetResult.result;
        }

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
        setStatus("simulating");
        const ethCallResult = await devEthCall(publicClient, { account: address, ...bundleTxParams });
        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return null;
        }
      }
      // On test networks, no simulation to preview — execute directly

      // Snapshot position + balances before TX
      let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
      if (process.env.NODE_ENV === "development" && address) {
        snapBefore = await snapshotTx(publicClient, address, pendingController, [inputToken]);
      }

      // Execute the transaction
      setStatus("executing");

      if (process.env.NODE_ENV === "development") console.log("[TX]", { to: bundle.tx.to, selector: (bundle.tx.data as string).slice(0, 10), data: bundle.tx.data });
      const hash = await sendTx({
        to: bundle.tx.to as `0x${string}`,
        data: bundle.tx.data as `0x${string}`,
        value: bundle.tx.value ? BigInt(bundle.tx.value) : 0n,
      });

      setTxHash(hash);
      setStatus("waitingTx");

      // Wait for confirmation
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: 60_000,
        pollingInterval: 1_000,
      });

      if (process.env.NODE_ENV === "development") {
        console.log("[TX Receipt]", { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() });
        if (snapBefore && address) {
          const snapAfter = await snapshotTx(publicClient, address, pendingController, [inputToken]);
          logTxDiff("Lending TX", snapBefore, snapAfter);
        }
      }
      if (receipt.status === "success") {
        setStatus("success");
      } else {
        setStatus("reverted");
        setError("Transaction reverted");
      }

      return simulationResult;
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, sendTx, testNetworkType, chainId, simulationResult, pendingController]);

  // Direct controller call for create_loan (no Enso bundle needed)
  const createLoan = useCallback(async (
    vaultAddress: `0x${string}`,
    collateralAmount: string,
    debtAmount: string,
    bands: number,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    const controllerAddress = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (!controllerAddress) {
      setError("Controller not found for this vault");
      setStatus("error");
      return null;
    }

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingBundle(null);
      setPendingApproval(null);
      setPendingController(controllerAddress as `0x${string}`);

      const { parseUnits, encodeFunctionData } = await import("viem");
      const amountWei = parseUnits(collateralAmount, 18); // Vault tokens are 18 decimals

      const callData = encodeFunctionData({
        abi: [{
          name: "create_loan",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            { name: "collateral", type: "uint256" },
            { name: "debt", type: "uint256" },
            { name: "N", type: "uint256" },
          ],
          outputs: [],
        }],
        functionName: "create_loan",
        args: [amountWei, BigInt(debtAmount), BigInt(bands)],
      });

      // Store pending tx for executeAfterPreview / executeAfterApproval
      setPendingBundle({
        tx: { to: controllerAddress, data: callData, value: "0", from: address },
        gas: "0",
        amountsOut: {},
      });
      setPendingInputToken(vaultAddress);

      // Check vault token allowance to controller
      const currentAllowance = await checkAllowance(
        publicClient, address, vaultAddress, controllerAddress as `0x${string}`
      );
      if (currentAllowance < amountWei) {
        setPendingApproval({
          token: vaultAddress,
          tokenSymbol: options?.tokenSymbol ?? "collateral",
          spender: controllerAddress as `0x${string}`,
          spenderName: "Curve Controller",
          amount: amountWei,
        });
        setStatus("needsApproval");
        return null;
      }

      // Simulate: mainnet → REST API, tenderly VNet → RPC sim, anvil → eth_call only
      if (testNetworkType === null && chainId !== 1337) {
        setStatus("simulating");

        const [tenderlyResult, ethCallResult] = await Promise.all([
          runTenderlySimulation(address, controllerAddress, callData, "0", vaultAddress),
          devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` }),
        ]);

        if (tenderlyResult.result) setSimulationResult(tenderlyResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return tenderlyResult.result;
        }

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
        setStatus("simulating");

        const [vnetResult, ethCallResult] = await Promise.all([
          runVNetSimulation(
            publicClient.transport,
            { from: address, to: controllerAddress, data: callData },
            address,
          ),
          devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` }),
        ]);

        if (vnetResult.result) setSimulationResult(vnetResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return vnetResult.result;
        }

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
        const ethCallResult = await devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` });
        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return null;
        }
        if (options?.previewOnly) {
          setStatus("idle");
          return null;
        }
      }

      // Snapshot position + balances before TX
      let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
      if (process.env.NODE_ENV === "development" && address) {
        snapBefore = await snapshotTx(publicClient, address, controllerAddress as `0x${string}`, [vaultAddress]);
      }

      // Execute
      setStatus("executing");
      if (process.env.NODE_ENV === "development") console.log("[TX]", { to: controllerAddress, selector: (callData as string).slice(0, 10), data: callData });
      const hash = await sendTx({
        to: controllerAddress as `0x${string}`,
        data: callData as `0x${string}`,
      });

      setTxHash(hash);
      setStatus("waitingTx");

      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 1_000 });
      if (process.env.NODE_ENV === "development") {
        console.log("[TX Receipt]", { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() });
        if (snapBefore && address) {
          const snapAfter = await snapshotTx(publicClient, address, controllerAddress as `0x${string}`, [vaultAddress]);
          logTxDiff("createLoan", snapBefore, snapAfter);
        }
      }
      if (receipt.status === "success") {
        setStatus("success");
      } else {
        setStatus("reverted");
        setError("Transaction reverted");
      }

      return simulationResult;
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, sendTx, testNetworkType, chainId, simulationResult]);

  // Create loan with swap: tokenIn → vaultToken → create_loan (Enso bundle)
  const createLoanWithSwap = useCallback(async (
    vaultAddress: `0x${string}`,
    tokenIn: string,
    amountIn: string,
    debtAmount: string,
    bands: number,
    slippage: number = 100,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ): Promise<SimulationResult | null> => {
    if (!address) return null;
    const { parseUnits } = await import("viem");
    const amountWei = parseUnits(amountIn, 18);
    const ctrl = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (ctrl) setPendingController(ctrl as `0x${string}`);
    return executeBundle(
      () => fetchCreateLoanWithSwapBundle({
        fromAddress: address,
        vaultAddress,
        tokenIn,
        amountIn: amountWei.toString(),
        debtAmount,
        bands,
        slippage,
      }),
      tokenIn,
      amountWei,
      options
    );
  }, [address, executeBundle]);

  // Create loan with output swap: create_loan → crvUSD → swap to tokenOut
  // Optionally swaps input token to vault token first (double swap)
  const createLoanWithOutputSwap = useCallback(async (
    vaultAddress: `0x${string}`,
    tokenIn: string | undefined, // undefined = vault token directly
    amountIn: string,
    debtAmount: string,
    bands: number,
    tokenOut: string,
    slippage: number = 100,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ): Promise<SimulationResult | null> => {
    if (!address) return null;
    const { parseUnits } = await import("viem");
    const decimals = tokenIn ? 18 : 18; // vault tokens are always 18 decimals
    const amountWei = parseUnits(amountIn, decimals);
    const ctrl = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (ctrl) setPendingController(ctrl as `0x${string}`);
    return executeBundle(
      () => fetchCreateLoanWithOutputSwapBundle({
        fromAddress: address,
        vaultAddress,
        tokenIn,
        amountIn: amountWei.toString(),
        debtAmount,
        bands,
        tokenOut,
        slippage,
      }),
      tokenIn ?? vaultAddress,
      amountWei,
      options
    );
  }, [address, executeBundle]);

  // Direct controller call for add_collateral (no Enso bundle needed)
  const addCollateral = useCallback(async (
    vaultAddress: `0x${string}`,
    collateralAmount: string,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    const controllerAddress = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (!controllerAddress) {
      setError("Controller not found for this vault");
      setStatus("error");
      return null;
    }

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingBundle(null);
      setPendingApproval(null);
      setPendingController(controllerAddress as `0x${string}`);

      const { parseUnits, encodeFunctionData } = await import("viem");
      const amountWei = parseUnits(collateralAmount, 18);

      const callData = encodeFunctionData({
        abi: [{
          name: "add_collateral",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            { name: "collateral", type: "uint256" },
            { name: "_for", type: "address" },
          ],
          outputs: [],
        }],
        functionName: "add_collateral",
        args: [amountWei, address],
      });

      // Store pending tx for executeAfterPreview / executeAfterApproval
      setPendingBundle({
        tx: { to: controllerAddress, data: callData, value: "0", from: address },
        gas: "0",
        amountsOut: {},
      });
      setPendingInputToken(vaultAddress);

      // Check vault token allowance to controller
      const currentAllowance = await checkAllowance(
        publicClient, address, vaultAddress, controllerAddress as `0x${string}`
      );
      if (currentAllowance < amountWei) {
        setPendingApproval({
          token: vaultAddress,
          tokenSymbol: options?.tokenSymbol ?? "collateral",
          spender: controllerAddress as `0x${string}`,
          spenderName: "Curve Controller",
          amount: amountWei,
        });
        setStatus("needsApproval");
        return null;
      }

      // Simulate: mainnet → REST API, tenderly VNet → RPC sim, anvil → eth_call only
      if (testNetworkType === null && chainId !== 1337) {
        setStatus("simulating");

        const [tenderlyResult, ethCallResult] = await Promise.all([
          runTenderlySimulation(address, controllerAddress, callData, "0", vaultAddress),
          devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` }),
        ]);

        if (tenderlyResult.result) setSimulationResult(tenderlyResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return tenderlyResult.result;
        }

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
        setStatus("simulating");

        const [vnetResult, ethCallResult] = await Promise.all([
          runVNetSimulation(
            publicClient.transport,
            { from: address, to: controllerAddress, data: callData },
            address,
          ),
          devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` }),
        ]);

        if (vnetResult.result) setSimulationResult(vnetResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return vnetResult.result;
        }

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
        const ethCallResult = await devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` });
        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return null;
        }
        if (options?.previewOnly) {
          setStatus("idle");
          return null;
        }
      }

      // Execute
      // Snapshot position + balances before TX
      let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
      if (process.env.NODE_ENV === "development" && address) {
        snapBefore = await snapshotTx(publicClient, address, controllerAddress as `0x${string}`, [vaultAddress]);
      }

      setStatus("executing");
      if (process.env.NODE_ENV === "development") console.log("[TX]", { to: controllerAddress, selector: (callData as string).slice(0, 10), data: callData });
      const hash = await sendTx({
        to: controllerAddress as `0x${string}`,
        data: callData as `0x${string}`,
      });

      setTxHash(hash);
      setStatus("waitingTx");

      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 1_000 });
      if (process.env.NODE_ENV === "development") {
        console.log("[TX Receipt]", { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() });
        if (snapBefore && address) {
          const snapAfter = await snapshotTx(publicClient, address, controllerAddress as `0x${string}`, [vaultAddress]);
          logTxDiff("addCollateral", snapBefore, snapAfter);
        }
      }
      if (receipt.status === "success") {
        setStatus("success");
      } else {
        setStatus("reverted");
        setError("Transaction reverted");
      }

      return simulationResult;
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, sendTx, testNetworkType, chainId, simulationResult]);

  // Direct controller call for remove_collateral (no Enso bundle needed)
  const removeCollateral = useCallback(async (
    vaultAddress: `0x${string}`,
    collateralAmount: string,
    options?: { previewOnly?: boolean }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    const controllerAddress = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (!controllerAddress) {
      setError("Controller not found for this vault");
      setStatus("error");
      return null;
    }

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingBundle(null);
      setPendingApproval(null);
      setPendingController(controllerAddress as `0x${string}`);

      const { parseUnits, encodeFunctionData } = await import("viem");
      const amountWei = parseUnits(collateralAmount, 18);

      const callData = encodeFunctionData({
        abi: [{
          name: "remove_collateral",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            { name: "collateral", type: "uint256" },
          ],
          outputs: [],
        }],
        functionName: "remove_collateral",
        args: [amountWei],
      });

      // Store pending tx for executeAfterPreview
      setPendingBundle({
        tx: { to: controllerAddress, data: callData, value: "0", from: address },
        gas: "0",
        amountsOut: {},
      });
      setPendingInputToken(vaultAddress);

      // No approval needed for removing collateral (we receive tokens)

      // Simulate: mainnet → REST API, tenderly VNet → RPC sim, anvil → eth_call only
      if (testNetworkType === null && chainId !== 1337) {
        setStatus("simulating");

        const [tenderlyResult, ethCallResult] = await Promise.all([
          runTenderlySimulation(address, controllerAddress, callData, "0", vaultAddress),
          devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` }),
        ]);

        if (tenderlyResult.result) setSimulationResult(tenderlyResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return tenderlyResult.result;
        }

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
        setStatus("simulating");

        const [vnetResult, ethCallResult] = await Promise.all([
          runVNetSimulation(
            publicClient.transport,
            { from: address, to: controllerAddress, data: callData },
            address,
          ),
          devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` }),
        ]);

        if (vnetResult.result) setSimulationResult(vnetResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return vnetResult.result;
        }

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
        const ethCallResult = await devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` });
        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return null;
        }
        if (options?.previewOnly) {
          setStatus("idle");
          return null;
        }
      }

      // Snapshot position + balances before TX
      let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
      if (process.env.NODE_ENV === "development" && address) {
        snapBefore = await snapshotTx(publicClient, address, controllerAddress as `0x${string}`, [vaultAddress]);
      }

      // Execute
      setStatus("executing");
      if (process.env.NODE_ENV === "development") console.log("[TX]", { to: controllerAddress, selector: (callData as string).slice(0, 10), data: callData });
      const hash = await sendTx({
        to: controllerAddress as `0x${string}`,
        data: callData as `0x${string}`,
      });

      setTxHash(hash);
      setStatus("waitingTx");

      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 1_000 });
      if (process.env.NODE_ENV === "development") {
        console.log("[TX Receipt]", { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() });
        if (snapBefore && address) {
          const snapAfter = await snapshotTx(publicClient, address, controllerAddress as `0x${string}`, [vaultAddress]);
          logTxDiff("removeCollateral", snapBefore, snapAfter);
        }
      }
      if (receipt.status === "success") {
        setStatus("success");
      } else {
        setStatus("reverted");
        setError("Transaction reverted");
      }

      return simulationResult;
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, sendTx, testNetworkType, chainId, simulationResult]);

  const addCollateralWithSwap = useCallback(async (
    vaultAddress: `0x${string}`,
    tokenIn: string,
    amountIn: string,
    slippage: number = 100,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ): Promise<SimulationResult | null> => {
    if (!address) return null;
    const { parseUnits } = await import("viem");
    const amountWei = parseUnits(amountIn, 18);
    const ctrl = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (ctrl) setPendingController(ctrl as `0x${string}`);
    return executeBundle(
      () => fetchAddCollateralWithSwapBundle({
        fromAddress: address,
        vaultAddress,
        tokenIn,
        amountIn: amountWei.toString(),
        slippage,
      }),
      tokenIn,
      amountWei,
      options
    );
  }, [address, executeBundle]);

  // Remove collateral + swap to any token in a single Enso bundle.
  // Uses the "recursive routeMulti" pattern with 2-arg remove_collateral(amount, _for).
  // Requires one-time controller approval + vault token approval for ENSO_SHORTCUTS.
  const removeCollateralAndSwap = useCallback(async (
    vaultAddress: `0x${string}`,
    collateralAmount: string,
    tokenOut: string,
    slippage: number = 100,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    const controllerAddress = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (!controllerAddress) {
      setError("Controller not found for this vault");
      setStatus("error");
      return null;
    }

    const { parseUnits } = await import("viem");
    const amountWei = parseUnits(collateralAmount, 18);
    setPendingController(controllerAddress as `0x${string}`);

    // Check ALL approvals in parallel (controller + vault token for ENSO_SHORTCUTS)
    setStatus("building");
    setError(null);

    const [controllerApproved, vaultTokenAllowance] = await Promise.all([
      publicClient.readContract({
        address: controllerAddress as `0x${string}`,
        abi: CONTROLLER_APPROVE_ABI,
        functionName: "approval",
        args: [address, ENSO_SHORTCUTS as `0x${string}`],
      }).catch(() => true) as Promise<boolean>,
      checkAllowance(publicClient, address, vaultAddress, ENSO_SHORTCUTS as `0x${string}`),
    ]);

    const tokenSymbol = options?.tokenSymbol ?? "token";
    const allApprovals: { approval: PendingApproval; needed: boolean; label: string; description: string; spender: string }[] = [
      {
        approval: {
          type: "controller",
          token: controllerAddress as `0x${string}`,
          tokenSymbol: "Controller",
          spender: ENSO_SHORTCUTS as `0x${string}`,
        },
        needed: !controllerApproved,
        label: "Lending Access",
        description: "Approve Enso Router to manage collateral on your behalf",
        spender: ENSO_SHORTCUTS,
      },
      {
        approval: {
          token: vaultAddress,
          tokenSymbol: tokenSymbol,
          spender: ENSO_SHORTCUTS as `0x${string}`,
          spenderName: "Enso",
          amount: amountWei,
        },
        needed: vaultTokenAllowance < amountWei,
        label: tokenSymbol,
        description: `Approve ${tokenSymbol} spending for Enso`,
        spender: ENSO_SHORTCUTS,
      },
    ];

    const total = allApprovals.length;
    const steps = allApprovals.map((a) => ({ label: a.label, description: a.description, done: !a.needed, spender: a.spender }));
    const firstNeededIdx = allApprovals.findIndex((a) => a.needed);

    if (firstNeededIdx >= 0) {
      const step = firstNeededIdx + 1;
      setApprovalProgress({ step, total, steps });
      setPendingApproval(allApprovals[firstNeededIdx].approval);
      setStatus("needsApproval");
      return null;
    }

    // All approvals satisfied — clear progress
    setApprovalProgress(null);

    // Pass inputAmount=0n to skip executeBundle's built-in approval check
    return executeBundle(
      () => fetchRemoveCollateralAndSwapBundle({
        fromAddress: address,
        vaultAddress,
        collateralAmount: amountWei.toString(),
        tokenOut,
        slippage,
      }),
      vaultAddress,
      0n,
      options
    );
  }, [address, publicClient, executeBundle]);

  // Direct contract call to controller.borrow_more(collateral, debt)
  // User IS msg.sender — no Enso bundle needed, no controller approval needed.
  const borrowMore = useCallback(async (
    vaultAddress: `0x${string}`,
    additionalCollateral: string,
    additionalDebt: string,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    const controllerAddress = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (!controllerAddress) {
      setError("Controller not found for this vault");
      setStatus("error");
      return null;
    }

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingBundle(null);
      setPendingApproval(null);
      setPendingController(controllerAddress as `0x${string}`);

      const { parseUnits, encodeFunctionData } = await import("viem");
      const collateralWei = additionalCollateral ? parseUnits(additionalCollateral, 18) : 0n;
      const debtWei = BigInt(additionalDebt);

      const callData = encodeFunctionData({
        abi: [{
          name: "borrow_more",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            { name: "collateral", type: "uint256" },
            { name: "debt", type: "uint256" },
          ],
          outputs: [],
        }],
        functionName: "borrow_more",
        args: [collateralWei, debtWei],
      });

      // Store pending tx for executeAfterPreview / executeAfterApproval
      setPendingBundle({
        tx: { to: controllerAddress, data: callData, value: "0", from: address },
        gas: "0",
        amountsOut: {},
      });
      setPendingInputToken(vaultAddress);

      // Check collateral token allowance to controller (only if adding collateral)
      if (collateralWei > 0n) {
        const currentAllowance = await checkAllowance(
          publicClient, address, vaultAddress, controllerAddress as `0x${string}`
        );
        if (currentAllowance < collateralWei) {
          setPendingApproval({
            token: vaultAddress,
            tokenSymbol: options?.tokenSymbol ?? "collateral",
            spender: controllerAddress as `0x${string}`,
            spenderName: "Curve Controller",
            amount: collateralWei,
          });
          setStatus("needsApproval");
          return null;
        }
      }

      // Simulate: mainnet → REST API, tenderly VNet → RPC sim, anvil → eth_call only
      if (testNetworkType === null && chainId !== 1337) {
        setStatus("simulating");

        const [tenderlyResult, ethCallResult] = await Promise.all([
          runTenderlySimulation(address, controllerAddress, callData, "0", vaultAddress),
          devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` }),
        ]);

        if (tenderlyResult.result) setSimulationResult(tenderlyResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return tenderlyResult.result;
        }

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
        setStatus("simulating");

        const [vnetResult, ethCallResult] = await Promise.all([
          runVNetSimulation(
            publicClient.transport,
            { from: address, to: controllerAddress, data: callData },
            address,
          ),
          devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` }),
        ]);

        if (vnetResult.result) setSimulationResult(vnetResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return vnetResult.result;
        }

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
        const ethCallResult = await devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` });
        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return null;
        }
        if (options?.previewOnly) {
          setStatus("idle");
          return null;
        }
      }

      // Snapshot position + balances before TX
      let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
      if (process.env.NODE_ENV === "development" && address) {
        snapBefore = await snapshotTx(publicClient, address, controllerAddress as `0x${string}`, [vaultAddress]);
      }

      // Execute
      setStatus("executing");
      if (process.env.NODE_ENV === "development") console.log("[TX]", { to: controllerAddress, selector: (callData as string).slice(0, 10), data: callData });
      const hash = await sendTx({
        to: controllerAddress as `0x${string}`,
        data: callData as `0x${string}`,
      });

      setTxHash(hash);
      setStatus("waitingTx");

      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 1_000 });
      if (process.env.NODE_ENV === "development") {
        console.log("[TX Receipt]", { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() });
        if (snapBefore && address) {
          const snapAfter = await snapshotTx(publicClient, address, controllerAddress as `0x${string}`, [vaultAddress]);
          logTxDiff("borrowMore", snapBefore, snapAfter);
        }
      }
      if (receipt.status === "success") {
        setStatus("success");
      } else {
        setStatus("reverted");
        setError("Transaction reverted");
      }

      return simulationResult;
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, sendTx, testNetworkType, chainId, simulationResult]);

  // Swap any token to vault collateral + borrow_more in a single Enso bundle (delegate mode).
  // User provides tokenIn (e.g., ETH, USDC) which gets swapped to vault token, then
  // borrow_more(swappedCollateral, debtAmount) adds collateral and borrows crvUSD atomically.
  const borrowMoreWithSwap = useCallback(async (
    vaultAddress: `0x${string}`,
    tokenIn: string,
    amountIn: string,
    additionalDebt: string,
    decimals: number = 18,
    slippage: number = 100,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ): Promise<SimulationResult | null> => {
    if (!address) return null;
    const { parseUnits: pu } = await import("viem");
    const amountWei = pu(amountIn, decimals);
    const ctrl = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (ctrl) setPendingController(ctrl as `0x${string}`);
    return executeBundle(
      () => fetchBorrowWithSwapCollateralBundle({
        fromAddress: address,
        vaultAddress,
        tokenIn,
        amountIn: amountWei.toString(),
        debtAmount: additionalDebt,
        slippage,
      }),
      tokenIn,
      amountWei,
      options
    );
  }, [address, executeBundle]);

  const repay = useCallback(async (
    vaultAddress: `0x${string}`,
    repayAmount: string,
    options?: { previewOnly?: boolean }
  ): Promise<SimulationResult | null> => {
    if (!address) return null;
    const { parseUnits } = await import("viem");
    const amountWei = parseUnits(repayAmount, 18);
    const ctrl = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (ctrl) setPendingController(ctrl as `0x${string}`);
    return executeBundle(
      () => fetchRepayBundle({
        fromAddress: address,
        vaultAddress,
        repayAmount: amountWei.toString(),
      }),
      CRVUSD_ADDRESS,
      amountWei,
      { ...options, tokenSymbol: "crvUSD" }
    );
  }, [address, executeBundle]);

  // Direct controller repay - bypasses Enso, calls controller.repay() with crvUSD
  const repayDirect = useCallback(async (
    controllerAddress: `0x${string}`,
    repayAmount: bigint,
    options?: { previewOnly?: boolean; closeLoan?: boolean }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    const CRVUSD = CRVUSD_ADDRESS;

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingBundle(null);
      setPendingApproval(null);
      setPendingController(controllerAddress);

      // Encode controller.repay(_d_debt, _for, max_active_band)
      // When closing loan, pass maxUint256 as _d_debt so interest accrual
      // between quote and TX confirmation can't prevent closure.
      // The controller caps at actual debt: d_debt = min(debt, _d_debt)
      const { encodeFunctionData, maxUint256 } = await import("viem");
      const isClosing = options?.closeLoan;
      const contractRepayAmount = isClosing ? maxUint256 : repayAmount;
      const callData = encodeFunctionData({
        abi: [{
          name: "repay",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            { name: "_d_debt", type: "uint256" },
            { name: "_for", type: "address" },
            { name: "max_active_band", type: "int256" },
          ],
          outputs: [],
        }],
        functionName: "repay",
        args: [contractRepayAmount, address, 2n ** 255n - 1n],
      });

      // Check crvUSD allowance to controller
      // Use actual repayAmount (not maxUint256) since controller only transfers min(debt, _d_debt)
      const currentAllowance = await checkAllowance(
        publicClient,
        address,
        CRVUSD,
        controllerAddress
      );

      if (currentAllowance < repayAmount) {
        // Store as a pseudo-bundle so executeAfterApproval can work
        setPendingBundle({
          tx: { to: controllerAddress, data: callData, value: "0" },
          gas: "0",
          createdAt: Date.now(),
        } as unknown as EnsoBundleResponse);
        setPendingInputToken(CRVUSD);
        setPendingApproval({
          token: CRVUSD,
          tokenSymbol: "crvUSD",
          spender: controllerAddress,
          spenderName: "Curve Controller",
          amount: repayAmount,
        });
        setStatus("needsApproval");
        return null;
      }

      // Simulate: mainnet → REST API, tenderly VNet → RPC sim, anvil → eth_call only
      if (testNetworkType === null && chainId !== 1337) {
        setStatus("simulating");

        const [tenderlyResult, ethCallResult] = await Promise.all([
          runTenderlySimulation(address, controllerAddress, callData, "0", CRVUSD),
          devEthCall(publicClient, { account: address, to: controllerAddress, data: callData as `0x${string}` }),
        ]);

        if (tenderlyResult.result) setSimulationResult(tenderlyResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return tenderlyResult.result;
        }

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
        setStatus("simulating");

        const [vnetResult, ethCallResult] = await Promise.all([
          runVNetSimulation(
            publicClient.transport,
            { from: address, to: controllerAddress, data: callData },
            address,
          ),
          devEthCall(publicClient, { account: address, to: controllerAddress, data: callData as `0x${string}` }),
        ]);

        if (vnetResult.result) setSimulationResult(vnetResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return vnetResult.result;
        }

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
        const ethCallResult = await devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` });
        if (!ethCallResult.ok) {
          const errorMsg = ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return null;
        }
        if (options?.previewOnly) {
          setStatus("idle");
          return null;
        }
      }

      // Snapshot position + balances before TX
      let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
      if (process.env.NODE_ENV === "development" && address) {
        snapBefore = await snapshotTx(publicClient, address, controllerAddress, [CRVUSD]);
      }

      // Execute the transaction
      setStatus("executing");
      if (process.env.NODE_ENV === "development") console.log("[TX]", { to: controllerAddress, selector: (callData as string).slice(0, 10), data: callData });

      const hash = await sendTx({
        to: controllerAddress,
        data: callData as `0x${string}`,
      });

      setTxHash(hash);
      setStatus("waitingTx");

      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: 60_000,
        pollingInterval: 1_000,
      });

      if (process.env.NODE_ENV === "development") {
        console.log("[TX Receipt]", { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() });
        if (snapBefore && address) {
          const snapAfter = await snapshotTx(publicClient, address, controllerAddress, [CRVUSD]);
          logTxDiff("repayDirect", snapBefore, snapAfter);
        }
      }
      if (receipt.status === "success") {
        setStatus("success");
      } else {
        setStatus("reverted");
        setError("Transaction reverted");
      }

      return simulationResult;
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, sendTx, testNetworkType, chainId, simulationResult]);

  // Repay crvUSD debt + withdraw collateral in a single Enso bundle.
  // Requires controller approval + crvUSD approval for ENSO_SHORTCUTS.
  const repayAndWithdraw = useCallback(async (
    controllerAddress: `0x${string}`,
    repayAmount: bigint,
    withdrawAmount: bigint,
    vaultAddress: `0x${string}`,
    options?: { previewOnly?: boolean; closeLoan?: boolean; withdrawTokenOut?: string; withdrawTokenSymbol?: string }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    setPendingController(controllerAddress);

    // Determine if withdrawal needs a swap (output token differs from collateral)
    const isWithdrawSwap = options?.withdrawTokenOut && options.withdrawTokenOut.toLowerCase() !== vaultAddress.toLowerCase();

    // Check ALL approvals in parallel (controller + crvUSD + optional collateral for swap)
    setStatus("building");
    setError(null);

    const [controllerApproved, crvUsdAllowance, collateralAllowance] = await Promise.all([
      publicClient.readContract({
        address: controllerAddress,
        abi: CONTROLLER_APPROVE_ABI,
        functionName: "approval",
        args: [address, ENSO_SHORTCUTS as `0x${string}`],
      }).catch(() => true) as Promise<boolean>,
      checkAllowance(publicClient, address, CRVUSD_ADDRESS as `0x${string}`, ENSO_SHORTCUTS as `0x${string}`),
      isWithdrawSwap
        ? checkAllowance(publicClient, address, vaultAddress, ENSO_SHORTCUTS as `0x${string}`)
        : Promise.resolve(BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")),
    ]);

    const allApprovals: { approval: PendingApproval; needed: boolean; label: string; description: string; spender: string }[] = [
      {
        approval: {
          type: "controller",
          token: controllerAddress,
          tokenSymbol: "Controller",
          spender: ENSO_SHORTCUTS as `0x${string}`,
        },
        needed: !controllerApproved,
        label: "Lending Access",
        description: "Approve Enso Router to manage your loan",
        spender: ENSO_SHORTCUTS,
      },
      {
        approval: {
          token: CRVUSD_ADDRESS as `0x${string}`,
          tokenSymbol: "crvUSD",
          spender: ENSO_SHORTCUTS as `0x${string}`,
          amount: repayAmount,
        },
        needed: crvUsdAllowance < repayAmount,
        label: "crvUSD",
        description: "Approve crvUSD for debt repayment",
        spender: ENSO_SHORTCUTS,
      },
      ...(isWithdrawSwap ? [{
        approval: {
          token: vaultAddress,
          tokenSymbol: options?.withdrawTokenSymbol ?? (getVaultByAddress(vaultAddress)?.symbol ?? "Collateral"),
          spender: ENSO_SHORTCUTS as `0x${string}`,
          spenderName: "Enso",
          amount: withdrawAmount,
        },
        needed: collateralAllowance < withdrawAmount,
        label: options?.withdrawTokenSymbol ?? (getVaultByAddress(vaultAddress)?.symbol ?? "Collateral"),
        description: `Approve ${options?.withdrawTokenSymbol ?? (getVaultByAddress(vaultAddress)?.symbol ?? "collateral")} for swap routing via Enso`,
        spender: ENSO_SHORTCUTS,
      }] : []),
    ];

    const total = allApprovals.length;
    const steps = allApprovals.map((a) => ({ label: a.label, description: a.description, done: !a.needed, spender: a.spender }));
    const firstNeededIdx = allApprovals.findIndex((a) => a.needed);

    if (firstNeededIdx >= 0) {
      const step = firstNeededIdx + 1;
      setApprovalProgress({ step, total, steps });
      setPendingApproval(allApprovals[firstNeededIdx].approval);
      setStatus("needsApproval");
      return null;
    }

    // All approvals satisfied — clear progress
    setApprovalProgress(null);

    // Pass inputAmount=0n to skip executeBundle's built-in approval check
    return executeBundle(
      () => fetchRepayAndWithdrawBundle({
        fromAddress: address,
        vaultAddress,
        repayAmount: repayAmount.toString(),
        withdrawAmount: withdrawAmount.toString(),
        closeLoan: options?.closeLoan,
        withdrawTokenOut: options?.withdrawTokenOut,
      }),
      CRVUSD_ADDRESS,
      0n,
      options
    );
  }, [address, publicClient, executeBundle]);

  const repayWithSwap = useCallback(async (
    vaultAddress: `0x${string}`,
    tokenIn: string,
    amountIn: string,
    decimals: number = 18,
    slippage: number = 100,
    options?: { previewOnly?: boolean; tokenSymbol?: string; inSoftLiquidation?: boolean; withdrawAmount?: string; withdrawTokenOut?: string; withdrawTokenSymbol?: string }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) return null;
    const { parseUnits } = await import("viem");
    const amountWei = parseUnits(amountIn, decimals);
    const ctrl = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (ctrl) setPendingController(ctrl as `0x${string}`);

    const hasWithdrawal = options?.withdrawAmount && options.withdrawAmount !== "0";
    const isWithdrawSwap = options?.withdrawTokenOut && options.withdrawTokenOut.toLowerCase() !== vaultAddress.toLowerCase();

    // When withdrawing collateral, need controller approval for ENSO_SHORTCUTS
    if (hasWithdrawal && ctrl) {
      setStatus("building");
      setError(null);

      const withdrawAmountWei = parseUnits(options.withdrawAmount!, 18);

      const [controllerApproved, tokenAllowance, collateralAllowance] = await Promise.all([
        publicClient.readContract({
          address: ctrl as `0x${string}`,
          abi: CONTROLLER_APPROVE_ABI,
          functionName: "approval",
          args: [address, ENSO_SHORTCUTS as `0x${string}`],
        }).catch(() => true) as Promise<boolean>,
        checkAllowance(publicClient, address, tokenIn as `0x${string}`, ENSO_SHORTCUTS as `0x${string}`),
        isWithdrawSwap
          ? checkAllowance(publicClient, address, vaultAddress, ENSO_SHORTCUTS as `0x${string}`)
          : Promise.resolve(BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")),
      ]);

      const tokenSymbol = options?.tokenSymbol ?? "token";
      const allApprovals: { approval: PendingApproval; needed: boolean; label: string; description: string; spender: string }[] = [
        {
          approval: {
            type: "controller",
            token: ctrl as `0x${string}`,
            tokenSymbol: "Controller",
            spender: ENSO_SHORTCUTS as `0x${string}`,
          },
          needed: !controllerApproved,
          label: "Lending Access",
          description: "Approve Enso Router to manage your loan",
          spender: ENSO_SHORTCUTS,
        },
        {
          approval: {
            token: tokenIn as `0x${string}`,
            tokenSymbol,
            spender: ENSO_SHORTCUTS as `0x${string}`,
            amount: amountWei,
          },
          needed: tokenAllowance < amountWei,
          label: tokenSymbol,
          description: `Approve ${tokenSymbol} for swap routing`,
          spender: ENSO_SHORTCUTS,
        },
        ...(isWithdrawSwap ? [{
          approval: {
            token: vaultAddress as `0x${string}`,
            tokenSymbol: options?.withdrawTokenSymbol ?? (getVaultByAddress(vaultAddress)?.symbol ?? "Collateral"),
            spender: ENSO_SHORTCUTS as `0x${string}`,
            spenderName: "Enso",
            amount: withdrawAmountWei,
          },
          needed: collateralAllowance < withdrawAmountWei,
          label: options?.withdrawTokenSymbol ?? (getVaultByAddress(vaultAddress)?.symbol ?? "Collateral"),
          description: `Approve ${options?.withdrawTokenSymbol ?? (getVaultByAddress(vaultAddress)?.symbol ?? "collateral")} for swap routing via Enso`,
          spender: ENSO_SHORTCUTS,
        }] : []),
      ];

      const total = allApprovals.length;
      const steps = allApprovals.map((a) => ({ label: a.label, description: a.description, done: !a.needed, spender: a.spender }));
      const firstNeededIdx = allApprovals.findIndex((a) => a.needed);

      if (firstNeededIdx >= 0) {
        const step = firstNeededIdx + 1;
        setApprovalProgress({ step, total, steps });
        setPendingApproval(allApprovals[firstNeededIdx].approval);
        setStatus("needsApproval");
        return null;
      }

      setApprovalProgress(null);

      return executeBundle(
        () => fetchRepayWithSwapBundle({
          fromAddress: address,
          vaultAddress,
          tokenIn,
          amountIn: amountWei.toString(),
          slippage,
          inSoftLiquidation: options?.inSoftLiquidation,
          withdrawAmount: options.withdrawAmount,
          withdrawTokenOut: options?.withdrawTokenOut,
        }),
        tokenIn,
        0n, // skip built-in approval check
        options
      );
    }

    return executeBundle(
      () => fetchRepayWithSwapBundle({
        fromAddress: address,
        vaultAddress,
        tokenIn,
        amountIn: amountWei.toString(),
        slippage,
        inSoftLiquidation: options?.inSoftLiquidation,
      }),
      tokenIn, // The token being swapped is the input
      amountWei,
      options
    );
  }, [address, publicClient, executeBundle]);

  // Borrow crvUSD + swap to any token in a single Enso bundle.
  // Uses the "recursive routeMulti" pattern to bypass routeSingle's token pull.
  // Requires one-time controller + crvUSD approvals for ENSO_SHORTCUTS.
  const borrowAndSwap = useCallback(async (
    vaultAddress: `0x${string}`,
    tokenOut: string,
    debtAmount: string, // crvUSD amount (human readable)
    slippage: number = 100,
    options?: { previewOnly?: boolean; tokenSymbol?: string; estimatedSwapOutput?: bigint; collateralAmount?: string }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    const controllerAddress = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (!controllerAddress) {
      setError("Controller not found for this vault");
      setStatus("error");
      return null;
    }

    const { parseUnits } = await import("viem");
    const debtWei = parseUnits(debtAmount, 18);
    setPendingController(controllerAddress as `0x${string}`);

    // Check ALL approvals in parallel (controller, crvUSD, swap target, vault token).
    // This lets us show "Step X of Y" progress instead of discovering them one-by-one.
    setStatus("building");
    setError(null);

    const vaultInfo = getVaultInfo(tokenOut);
    const needsSwapTargetApproval =
      vaultInfo && vaultInfo.underlying.toLowerCase() !== CRVUSD_ADDRESS.toLowerCase();
    const isCvgCvxVault = needsSwapTargetApproval &&
      vaultInfo!.underlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();
    const swapTarget = needsSwapTargetApproval
      ? (isCvgCvxVault ? TOKENS.CVX : vaultInfo!.underlying)
      : null;

    // Collateral: vault token amount (wei string) to include in borrow_more
    const collateralWei = options?.collateralAmount
      ? BigInt(options.collateralAmount)
      : 0n;

    const [controllerApproved, crvUsdAllowance, swapTargetAllowance, vaultTokenAllowance] = await Promise.all([
      publicClient.readContract({
        address: controllerAddress as `0x${string}`,
        abi: CONTROLLER_APPROVE_ABI,
        functionName: "approval",
        args: [address, ENSO_SHORTCUTS as `0x${string}`],
      }).catch(() => true) as Promise<boolean>,
      checkAllowance(publicClient, address, CRVUSD_ADDRESS as `0x${string}`, ENSO_SHORTCUTS as `0x${string}`),
      swapTarget
        ? checkAllowance(publicClient, address, swapTarget as `0x${string}`, ENSO_SHORTCUTS as `0x${string}`)
        : Promise.resolve(maxUint256),
      collateralWei > 0n
        ? checkAllowance(publicClient, address, vaultAddress, ENSO_SHORTCUTS as `0x${string}`)
        : Promise.resolve(maxUint256),
    ]);

    // Build full ordered list of all approvals with their status
    const swapTargetSymbol = swapTarget
      ? (isCvgCvxVault ? "CVX" : vaultInfo!.underlyingSymbol)
      : null;
    const tokenSymbol = options?.tokenSymbol ?? "token";
    const allApprovals: { approval: PendingApproval; needed: boolean; label: string; description: string; spender: string }[] = [
      {
        approval: {
          type: "controller",
          token: controllerAddress as `0x${string}`,
          tokenSymbol: "Controller",
          spender: ENSO_SHORTCUTS as `0x${string}`,
        },
        needed: !controllerApproved,
        label: "Lending Access",
        description: "Approve Enso Router to borrow on your behalf",
        spender: ENSO_SHORTCUTS,
      },
      {
        approval: {
          token: CRVUSD_ADDRESS as `0x${string}`,
          tokenSymbol: "crvUSD",
          spender: ENSO_SHORTCUTS as `0x${string}`,
          amount: debtWei,
        },
        needed: crvUsdAllowance < debtWei,
        label: "crvUSD",
        description: "Approve crvUSD spending for swap",
        spender: ENSO_SHORTCUTS,
      },
    ];
    if (collateralWei > 0n) {
      // Vault token needs approval for ENSO_SHORTCUTS to pull collateral
      const vaultConfig = getVaultByAddress(vaultAddress);
      const vaultSymbol = vaultConfig?.symbol ?? "Collateral";
      allApprovals.push({
        approval: {
          token: vaultAddress,
          tokenSymbol: vaultSymbol,
          spender: ENSO_SHORTCUTS as `0x${string}`,
          spenderName: "Enso",
          amount: collateralWei,
        },
        needed: vaultTokenAllowance < collateralWei,
        label: vaultSymbol,
        description: `Approve ${vaultSymbol} spending for Enso`,
        spender: ENSO_SHORTCUTS,
      });
    }
    if (swapTarget) {
      // Use estimated swap output + 5% buffer for exact approval option
      const swapAmount = options?.estimatedSwapOutput
        ? options.estimatedSwapOutput * 105n / 100n
        : undefined;
      allApprovals.push({
        approval: {
          token: swapTarget as `0x${string}`,
          tokenSymbol: swapTargetSymbol!,
          spender: ENSO_SHORTCUTS as `0x${string}`,
          amount: swapAmount,
        },
        needed: swapTargetAllowance === 0n,
        label: swapTargetSymbol!,
        description: `Approve ${swapTargetSymbol} spending for vault deposit`,
        spender: ENSO_SHORTCUTS,
      });
    }

    const total = allApprovals.length;
    const steps = allApprovals.map((a) => ({ label: a.label, description: a.description, done: !a.needed, spender: a.spender }));
    const firstNeededIdx = allApprovals.findIndex((a) => a.needed);

    if (firstNeededIdx >= 0) {
      const step = firstNeededIdx + 1; // 1-indexed position in full list
      setApprovalProgress({ step, total, steps });
      setPendingApproval(allApprovals[firstNeededIdx].approval);
      setStatus("needsApproval");
      return null;
    }

    // All approvals satisfied — clear progress
    setApprovalProgress(null);

    // Pass inputAmount=0n to skip executeBundle's built-in approval check
    return executeBundle(
      () => fetchBorrowAndSwapBundle({
        fromAddress: address,
        vaultAddress,
        tokenOut,
        debtAmount: debtWei.toString(),
        collateralAmount: collateralWei > 0n ? collateralWei.toString() : undefined,
        slippage,
      }),
      CRVUSD_ADDRESS,
      0n,
      { ...options, tokenSymbol: options?.tokenSymbol ?? "crvUSD" }
    );
  }, [address, publicClient, executeBundle]);

  const selfLiquidate = useCallback(async (
    vaultAddress: `0x${string}`,
    slippage: number = 0.5,
    options?: { previewOnly?: boolean }
  ): Promise<SimulationResult | null> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return null;
    }

    const controllerAddress = CURVE_CONTROLLERS[vaultAddress as keyof typeof CURVE_CONTROLLERS];
    if (!controllerAddress) {
      setError("Controller not found for this vault");
      setStatus("error");
      return null;
    }

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);
      setSimulationResult(null);
      setPendingController(controllerAddress as `0x${string}`);

      // Get user state to calculate min_x
      const userState = await publicClient.readContract({
        address: controllerAddress as `0x${string}`,
        abi: [
          {
            type: "function",
            name: "user_state",
            inputs: [{ name: "user", type: "address" }],
            outputs: [{ name: "", type: "uint256[4]" }],
            stateMutability: "view",
          },
        ],
        functionName: "user_state",
        args: [address],
      }) as readonly [bigint, bigint, bigint, bigint];

      const stablecoinInAmm = userState[1];
      const minX = (stablecoinInAmm * BigInt(Math.floor((100 - slippage) * 100))) / 10000n;

      // For self-liquidate, we need to encode the call data for simulation
      const { encodeFunctionData } = await import("viem");
      const callData = encodeFunctionData({
        abi: [
          {
            type: "function",
            name: "liquidate",
            inputs: [
              { name: "user", type: "address" },
              { name: "min_x", type: "uint256" },
            ],
            outputs: [],
            stateMutability: "nonpayable",
          },
        ],
        functionName: "liquidate",
        args: [address, minX],
      });

      // Simulate: mainnet → REST API, tenderly VNet → RPC sim, anvil → eth_call only
      if (testNetworkType === null && chainId !== 1337) {
        setStatus("simulating");

        const simResult = await runTenderlySimulation(
          address,
          controllerAddress,
          callData,
          "0",
          vaultAddress // collateral is what we're getting back
        );

        if (simResult.result) {
          setSimulationResult(simResult.result);
        }

        if (options?.previewOnly) {
          setStatus("idle");
          return simResult.result;
        }
      } else if (testNetworkType === "tenderly") {
        setStatus("simulating");

        const vnetResult = await runVNetSimulation(
          publicClient.transport,
          { from: address, to: controllerAddress, data: callData },
          address,
        );

        if (vnetResult.result) {
          setSimulationResult(vnetResult.result);
        }

        if (options?.previewOnly) {
          setStatus("idle");
          return vnetResult.result;
        }
      } else {
        if (process.env.NODE_ENV === "development") {
          await devEthCall(publicClient, { account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` });
        }
        if (options?.previewOnly) {
          setStatus("idle");
          return null;
        }
      }

      // Snapshot position + balances before TX
      let snapBefore: Awaited<ReturnType<typeof snapshotTx>> | undefined;
      if (process.env.NODE_ENV === "development" && address) {
        snapBefore = await snapshotTx(publicClient, address, controllerAddress as `0x${string}`, [vaultAddress]);
      }

      setStatus("executing");
      if (process.env.NODE_ENV === "development") console.log("[TX]", { fn: "liquidate", to: controllerAddress });

      const hash = await writeContractAsync({
        address: controllerAddress as `0x${string}`,
        abi: [
          {
            type: "function",
            name: "liquidate",
            inputs: [
              { name: "user", type: "address" },
              { name: "min_x", type: "uint256" },
            ],
            outputs: [],
            stateMutability: "nonpayable",
          },
        ],
        functionName: "liquidate",
        args: [address, minX],
      });

      setTxHash(hash);
      setStatus("waitingTx");

      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: 60_000,
        pollingInterval: 1_000,
      });

      if (process.env.NODE_ENV === "development") {
        console.log("[TX Receipt]", { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() });
        if (snapBefore && address) {
          const snapAfter = await snapshotTx(publicClient, address, controllerAddress as `0x${string}`, [vaultAddress]);
          logTxDiff("selfLiquidate", snapBefore, snapAfter);
        }
      }
      if (receipt.status === "success") {
        setStatus("success");
      } else {
        setStatus("reverted");
        setError("Transaction reverted");
      }

      return simulationResult;
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
      return null;
    }
  }, [address, publicClient, writeContractAsync, testNetworkType, chainId, simulationResult]);

  return {
    createLoan,
    createLoanWithSwap,
    createLoanWithOutputSwap,
    addCollateral,
    removeCollateral,
    addCollateralWithSwap,
    removeCollateralAndSwap,
    borrowMore,
    borrowMoreWithSwap,
    repay,
    repayDirect,
    repayAndWithdraw,
    repayWithSwap,
    borrowAndSwap,
    selfLiquidate,
    // Approval - based on bundle.tx.to
    pendingApproval,
    approvalProgress,
    approve,
    isApproving,
    isApprovalSuccess,
    executeAfterApproval,
    // State
    status,
    txHash,
    error,
    simulationResult,
    pendingBundle,
    reset,
    clearError,
    executeAfterPreview,
  };
}
