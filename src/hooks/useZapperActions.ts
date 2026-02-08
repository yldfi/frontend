"use client";

import { useState, useCallback, useMemo } from "react";
import { useAccount, usePublicClient, useSendTransaction, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { encodeFunctionData, maxUint256 } from "viem";
import {
  ZAPPER_ADDRESS,
  ZAPPER_ABI,
  CONTROLLER_APPROVE_ABI,
  CRVUSD_ADDRESS,
  fetchZapperSwapData,
  getDeadline,
} from "@/lib/zapper";
import { ERC20_APPROVAL_ABI } from "@/lib/abis";
import type { SimulationResult } from "@/types/enso";
import { useTenderly } from "@/contexts/TenderlyContext";

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

export interface PendingApproval {
  type: "erc20" | "controller";
  token: `0x${string}`;
  tokenSymbol: string;
  spender: `0x${string}`;
  amount?: bigint; // only for ERC20
}

interface PendingTx {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  inputToken: string;
}

function parseErrorMessage(error: unknown): string {
  if (!error) return "Unknown error";
  const errorStr = String(error);

  if (errorStr.includes("User rejected") || errorStr.includes("user rejected")) {
    return "Transaction cancelled";
  }
  if (errorStr.includes("insufficient") || errorStr.includes("exceeds balance")) {
    return "Insufficient balance";
  }
  if (errorStr.includes("slippage") || errorStr.includes("INSUFFICIENT_OUTPUT")) {
    return "Price moved too much. Try increasing slippage.";
  }
  if (errorStr.includes("health") || errorStr.includes("Health")) {
    return "Position would be unhealthy";
  }
  if (errorStr.includes("revert")) {
    const match = errorStr.match(/reason="([^"]+)"/);
    if (match) return `Transaction failed: ${match[1]}`;
    return "Transaction failed";
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
  selfLiquidate: (
    controller: `0x${string}`,
    percentage: bigint,
    collateralToken: `0x${string}`,
    slippage?: number,
    previewOnly?: boolean
  ) => Promise<SimulationResult | null>;

  // Approval
  pendingApproval: PendingApproval | null;
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
  executeAfterPreview: () => Promise<void>;
}

export function useZapperActions(): UseZapperActionsResult {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient();
  const { sendTransactionAsync } = useSendTransaction();
  const { isTenderlyVNet } = useTenderly();

  const [status, setStatus] = useState<ZapperStatus>("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);
  const [pendingTx, setPendingTx] = useState<PendingTx | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);

  // Approval tx
  const {
    writeContract: writeApprove,
    data: approveHash,
    reset: resetApprove,
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

  const reset = useCallback(() => {
    setStatus("idle");
    setTxHash(null);
    setError(null);
    setSimulationResult(null);
    setPendingTx(null);
    setPendingApproval(null);
    resetApprove();
  }, [resetApprove]);

  const approve = useCallback((exactAmount?: boolean) => {
    if (!address || !pendingApproval) return;
    setStatus("approving");

    if (pendingApproval.type === "erc20") {
      writeApprove({
        address: pendingApproval.token,
        abi: ERC20_APPROVAL_ABI,
        functionName: "approve",
        args: [pendingApproval.spender, exactAmount && pendingApproval.amount ? pendingApproval.amount : maxUint256],
      });
    } else {
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

    // Simulate (skip on VNet or local)
    if (!isTenderlyVNet && chainId !== 1337) {
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
            return { ok: true as const };
          } catch (err) {
            return {
              ok: false as const,
              errorMessage: err instanceof Error ? err.message : "eth_call failed",
            };
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

      if (!tenderlyResult.ok && !ethCallResult.ok) {
        const errorMsg = tenderlyResult.errorMessage || ethCallResult.errorMessage || "Simulation failed";
        setError(parseErrorMessage(new Error(errorMsg)));
        setStatus("error");
        return tenderlyResult.result;
      }
    } else if (previewOnly) {
      setStatus("idle");
      return null;
    }

    // Execute
    setStatus("executing");
    const hash = await sendTransactionAsync({
      to: txData.to,
      data: txData.data,
      value: txData.value,
    });

    setTxHash(hash);
    setStatus("waitingTx");

    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
    });

    if (receipt.status === "success") {
      setStatus("success");
    } else {
      setStatus("reverted");
      setError("Transaction reverted");
    }

    return simulationResult;
  }, [address, publicClient, sendTransactionAsync, isTenderlyVNet, chainId, simulationResult]);

  const executeAfterApproval = useCallback(async () => {
    if (!pendingTx) {
      setError("No pending transaction");
      setStatus("error");
      return;
    }
    setPendingApproval(null);
    try {
      await simulateAndExecute(pendingTx, false);
    } catch (err) {
      setError(parseErrorMessage(err));
      setStatus("error");
    }
  }, [pendingTx, simulateAndExecute]);

  const executeAfterPreview = useCallback(async () => {
    if (!pendingTx || !publicClient) {
      setError("No pending transaction");
      setStatus("error");
      return;
    }

    try {
      setStatus("executing");
      const hash = await sendTransactionAsync({
        to: pendingTx.to,
        data: pendingTx.data,
        value: pendingTx.value,
      });

      setTxHash(hash);
      setStatus("waitingTx");

      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
      });

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
  }, [pendingTx, publicClient, sendTransactionAsync]);

  // Check both ERC20 and controller approvals, return first missing
  const checkApprovals = useCallback(async (
    collateralToken: `0x${string}`,
    controller: `0x${string}`,
    inputAmount: bigint,
    tokenSymbol: string
  ): Promise<PendingApproval | null> => {
    if (!publicClient || !address) return null;

    // Check ERC20 allowance first
    if (inputAmount > 0n) {
      const allowance = await checkAllowance(
        publicClient,
        address,
        collateralToken,
        ZAPPER_ADDRESS as `0x${string}`
      );
      if (allowance < inputAmount) {
        return {
          type: "erc20",
          token: collateralToken,
          tokenSymbol,
          spender: ZAPPER_ADDRESS as `0x${string}`,
          amount: inputAmount,
        };
      }
    }

    // Check controller approval
    const controllerApproved = await checkControllerApproval(
      publicClient,
      controller,
      address,
      ZAPPER_ADDRESS as `0x${string}`
    );
    if (!controllerApproved) {
      return {
        type: "controller",
        token: controller,
        tokenSymbol: "Controller",
        spender: ZAPPER_ADDRESS as `0x${string}`,
      };
    }

    return null;
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
        to: ZAPPER_ADDRESS as `0x${string}`,
        data: data as `0x${string}`,
        value: 0n,
        inputToken: collateralToken,
      };
      setPendingTx(tx);

      // Check approvals
      const missingApproval = await checkApprovals(collateralToken, controller, userCollateral, "ycvxCRV");
      if (missingApproval) {
        setPendingApproval(missingApproval);
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
        to: ZAPPER_ADDRESS as `0x${string}`,
        data: data as `0x${string}`,
        value: 0n,
        inputToken: collateralToken,
      };
      setPendingTx(tx);

      const missingApproval = await checkApprovals(collateralToken, controller, additionalCollateral, "ycvxCRV");
      if (missingApproval) {
        setPendingApproval(missingApproval);
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
        to: ZAPPER_ADDRESS as `0x${string}`,
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
        ZAPPER_ADDRESS as `0x${string}`
      );
      if (!controllerApproved) {
        setPendingApproval({
          type: "controller",
          token: controller,
          tokenSymbol: "Controller",
          spender: ZAPPER_ADDRESS as `0x${string}`,
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
          swapData as `0x${string}`,
          getDeadline(),
        ],
      });

      const tx: PendingTx = {
        to: ZAPPER_ADDRESS as `0x${string}`,
        data: data as `0x${string}`,
        value: 0n,
        inputToken: collateralToken,
      };
      setPendingTx(tx);

      const controllerApproved = await checkControllerApproval(
        publicClient,
        controller,
        address,
        ZAPPER_ADDRESS as `0x${string}`
      );
      if (!controllerApproved) {
        setPendingApproval({
          type: "controller",
          token: controller,
          tokenSymbol: "Controller",
          spender: ZAPPER_ADDRESS as `0x${string}`,
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

  return {
    createLeveragedLoan,
    leverageUp,
    deleverage,
    selfLiquidate,
    pendingApproval,
    approve,
    isApproving,
    isApprovalSuccess,
    executeAfterApproval,
    status,
    txHash,
    error,
    simulationResult,
    reset,
    executeAfterPreview,
  };
}
