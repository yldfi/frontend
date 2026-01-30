"use client";

import { useState, useCallback } from "react";
import { useAccount, usePublicClient, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import {
  fetchCreateLoanBundle,
  fetchAddCollateralBundle,
  fetchRemoveCollateralBundle,
  fetchBorrowMoreBundle,
  fetchRepayBundle,
} from "@/lib/curve-lending";
import type { EnsoBundleResponse } from "@/types/enso";

export type LendingStatus =
  | "idle"
  | "building" // Building the transaction bundle
  | "approving" // Waiting for approval
  | "waitingApproval" // Waiting for approval tx to confirm
  | "executing" // Sending main transaction
  | "waitingTx" // Waiting for main tx to confirm
  | "success"
  | "reverted"
  | "error";

export interface LendingActionResult {
  status: LendingStatus;
  txHash: `0x${string}` | null;
  error: string | null;
  bundleResponse: EnsoBundleResponse | null;
}

export interface UseCurveLendingActionsResult {
  // Action functions
  createLoan: (
    vaultAddress: `0x${string}`,
    collateralAmount: string,
    debtAmount: string,
    bands: number
  ) => Promise<void>;
  addCollateral: (
    vaultAddress: `0x${string}`,
    collateralAmount: string
  ) => Promise<void>;
  removeCollateral: (
    vaultAddress: `0x${string}`,
    collateralAmount: string
  ) => Promise<void>;
  borrowMore: (
    vaultAddress: `0x${string}`,
    additionalCollateral: string,
    additionalDebt: string
  ) => Promise<void>;
  repay: (
    vaultAddress: `0x${string}`,
    repayAmount: string
  ) => Promise<void>;

  // State
  status: LendingStatus;
  txHash: `0x${string}` | null;
  error: string | null;
  reset: () => void;
}

function parseErrorMessage(error: unknown): string {
  if (!error) return "Unknown error";

  const errorStr = String(error);

  // User rejection
  if (errorStr.includes("User rejected") || errorStr.includes("user rejected")) {
    return "Transaction cancelled";
  }

  // Insufficient balance
  if (errorStr.includes("insufficient") || errorStr.includes("exceeds balance")) {
    return "Insufficient balance";
  }

  // Slippage
  if (errorStr.includes("slippage") || errorStr.includes("INSUFFICIENT_OUTPUT")) {
    return "Price moved too much. Try increasing slippage.";
  }

  // Health check
  if (errorStr.includes("health") || errorStr.includes("Health")) {
    return "Position would be unhealthy";
  }

  // Generic revert
  if (errorStr.includes("revert")) {
    const match = errorStr.match(/reason="([^"]+)"/);
    if (match) return `Transaction failed: ${match[1]}`;
    return "Transaction failed";
  }

  return "Transaction failed. Please try again.";
}

export function useCurveLendingActions(): UseCurveLendingActionsResult {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [status, setStatus] = useState<LendingStatus>("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Wait for transaction receipt
  useWaitForTransactionReceipt({
    hash: txHash ?? undefined,
    query: {
      enabled: !!txHash && (status === "waitingTx" || status === "waitingApproval"),
    },
  });

  const reset = useCallback(() => {
    setStatus("idle");
    setTxHash(null);
    setError(null);
  }, []);

  const executeBundle = useCallback(async (
    bundleFn: () => Promise<EnsoBundleResponse>
  ): Promise<void> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      setStatus("error");
      return;
    }

    try {
      setStatus("building");
      setError(null);
      setTxHash(null);

      // Build the bundle
      const bundle = await bundleFn();

      // Execute the transaction
      setStatus("executing");

      const hash = await writeContractAsync({
        address: bundle.tx.to as `0x${string}`,
        abi: [
          {
            type: "function",
            name: "execute",
            inputs: [{ type: "bytes", name: "data" }],
            outputs: [],
            stateMutability: "payable",
          },
        ],
        functionName: "execute",
        args: [bundle.tx.data as `0x${string}`],
        value: bundle.tx.value ? BigInt(bundle.tx.value) : 0n,
      });

      setTxHash(hash);
      setStatus("waitingTx");

      // Wait for confirmation
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
      console.error("[LendingActions] Error:", err);
      setError(parseErrorMessage(err));
      setStatus("error");
    }
  }, [address, publicClient, writeContractAsync]);

  const createLoan = useCallback(async (
    vaultAddress: `0x${string}`,
    collateralAmount: string,
    debtAmount: string,
    bands: number
  ) => {
    if (!address) return;
    await executeBundle(() =>
      fetchCreateLoanBundle({
        fromAddress: address,
        vaultAddress,
        collateralAmount,
        debtAmount,
        bands,
      })
    );
  }, [address, executeBundle]);

  const addCollateral = useCallback(async (
    vaultAddress: `0x${string}`,
    collateralAmount: string
  ) => {
    if (!address) return;
    await executeBundle(() =>
      fetchAddCollateralBundle({
        fromAddress: address,
        vaultAddress,
        collateralAmount,
      })
    );
  }, [address, executeBundle]);

  const removeCollateral = useCallback(async (
    vaultAddress: `0x${string}`,
    collateralAmount: string
  ) => {
    if (!address) return;
    await executeBundle(() =>
      fetchRemoveCollateralBundle({
        fromAddress: address,
        vaultAddress,
        collateralAmount,
      })
    );
  }, [address, executeBundle]);

  const borrowMore = useCallback(async (
    vaultAddress: `0x${string}`,
    additionalCollateral: string,
    additionalDebt: string
  ) => {
    if (!address) return;
    await executeBundle(() =>
      fetchBorrowMoreBundle({
        fromAddress: address,
        vaultAddress,
        additionalCollateral,
        additionalDebt,
      })
    );
  }, [address, executeBundle]);

  const repay = useCallback(async (
    vaultAddress: `0x${string}`,
    repayAmount: string
  ) => {
    if (!address) return;
    await executeBundle(() =>
      fetchRepayBundle({
        fromAddress: address,
        vaultAddress,
        repayAmount,
      })
    );
  }, [address, executeBundle]);

  return {
    createLoan,
    addCollateral,
    removeCollateral,
    borrowMore,
    repay,
    status,
    txHash,
    error,
    reset,
  };
}
