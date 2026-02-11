"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import { useAccount, usePublicClient, useSendTransaction, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { maxUint256 } from "viem";
import {
  fetchAddCollateralWithSwapBundle,
  fetchCreateLoanWithSwapBundle,
  fetchCreateLoanWithOutputSwapBundle,
  fetchRemoveCollateralAndSwapBundle,
  fetchRepayBundle,
  fetchRepayWithSwapBundle,
  fetchBorrowAndSwapBundle,
  getVaultInfo,
  CURVE_CONTROLLERS,
} from "@/lib/curve-lending";
import { TOKENS } from "@/config/vaults";
import { ERC20_APPROVAL_ABI, CONTROLLER_APPROVE_ABI } from "@/lib/abis";
import { ETH_ADDRESS, ENSO_SHORTCUTS } from "@/lib/enso";
import { CRVUSD_ADDRESS } from "@/lib/zapper";
import type { EnsoBundleResponse, SimulationResult } from "@/types/enso";
import { useTenderly } from "@/contexts/TenderlyContext";

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

export interface PendingApproval {
  type?: "erc20" | "controller"; // defaults to "erc20"
  token: `0x${string}`;
  tokenSymbol: string;
  spender: `0x${string}`;
  amount?: bigint; // not needed for controller approval
}

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
  repay: (
    vaultAddress: `0x${string}`,
    repayAmount: string,
    options?: { previewOnly?: boolean }
  ) => Promise<SimulationResult | null>;
  repayDirect: (
    controllerAddress: `0x${string}`,
    repayAmount: bigint,
    options?: { previewOnly?: boolean }
  ) => Promise<SimulationResult | null>;
  repayWithSwap: (
    vaultAddress: `0x${string}`,
    tokenIn: string,
    amountIn: string,
    slippage?: number,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ) => Promise<SimulationResult | null>;
  borrowAndSwap: (
    vaultAddress: `0x${string}`,
    tokenOut: string,
    debtAmount: string,
    slippage: number,
    options?: { previewOnly?: boolean; tokenSymbol?: string; estimatedSwapOutput?: bigint }
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
    steps: { label: string; description: string; done: boolean }[];
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
  const { isTenderlyVNet } = useTenderly();

  const [status, setStatus] = useState<LendingStatus>("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);
  const [pendingBundle, setPendingBundle] = useState<EnsoBundleResponse | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [approvalProgress, setApprovalProgress] = useState<{
    step: number;
    total: number;
    steps: { label: string; description: string; done: boolean }[];
  } | null>(null);
  const [pendingInputToken, setPendingInputToken] = useState<string | null>(null);

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

      // Run simulation if not on VNet
      if (!isTenderlyVNet && chainId !== 1337) {
        setStatus("simulating");

        const txParams = {
          to: pendingBundle.tx.to as `0x${string}`,
          data: pendingBundle.tx.data as `0x${string}`,
          value: pendingBundle.tx.value ? BigInt(pendingBundle.tx.value) : 0n,
        };

        // Run Tenderly and eth_call in parallel
        const [tenderlyResult, ethCallResult] = await Promise.all([
          runTenderlySimulation(
            address,
            pendingBundle.tx.to,
            pendingBundle.tx.data,
            pendingBundle.tx.value || "0",
            pendingInputToken
          ),
          (async () => {
            try {
              await publicClient.call({
                account: address,
                ...txParams,
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

        // If BOTH simulations fail, block the transaction
        if (!tenderlyResult.ok && !ethCallResult.ok) {
          const errorMsg = tenderlyResult.errorMessage || ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return;
        }
      }

      // Execute the transaction
      setStatus("executing");

      const hash = await sendTransactionAsync({
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
  }, [pendingBundle, publicClient, address, pendingInputToken, sendTransactionAsync, isTenderlyVNet, chainId]);

  // Execute a pending bundle after preview confirmation
  const executeAfterPreview = useCallback(async () => {
    if (!pendingBundle || !publicClient) {
      setError("No pending transaction");
      setStatus("error");
      return;
    }

    try {
      setStatus("executing");

      const hash = await sendTransactionAsync({
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
  }, [pendingBundle, publicClient, sendTransactionAsync]);

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

      // Get the spender address from the bundle's tx.to
      const spender = bundle.tx.to as `0x${string}`;

      // Check allowance against the actual spender (bundle.tx.to)
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
            amount: inputAmount,
          });
          setStatus("needsApproval");
          return null;
        }
      }

      // Run Tenderly simulation + eth_call (skip on VNet or local)
      if (!isTenderlyVNet && chainId !== 1337) {
        setStatus("simulating");

        const txParams = {
          to: bundle.tx.to as `0x${string}`,
          data: bundle.tx.data as `0x${string}`,
          value: bundle.tx.value ? BigInt(bundle.tx.value) : 0n,
        };

        // Run Tenderly and eth_call in parallel
        const tenderlyPromise = runTenderlySimulation(
          address,
          bundle.tx.to,
          bundle.tx.data,
          bundle.tx.value || "0",
          inputToken
        );

        const ethCallPromise = (async () => {
          try {
            await publicClient.call({
              account: address,
              ...txParams,
            });
            return { ok: true as const };
          } catch (err) {
            return {
              ok: false as const,
              errorMessage: err instanceof Error ? err.message : "eth_call failed",
            };
          }
        })();

        const [tenderlyResult, ethCallResult] = await Promise.all([
          tenderlyPromise,
          ethCallPromise,
        ]);

        if (tenderlyResult.result) {
          setSimulationResult(tenderlyResult.result);
        }

        // If previewOnly, stop here and return the result
        if (options?.previewOnly) {
          setStatus("idle");
          return tenderlyResult.result;
        }

        // If BOTH simulations fail, block the transaction
        if (!tenderlyResult.ok && !ethCallResult.ok) {
          const errorMsg = tenderlyResult.errorMessage || ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return tenderlyResult.result;
        }
      }
      // On test networks, no simulation to preview — execute directly

      // Execute the transaction
      setStatus("executing");

      const hash = await sendTransactionAsync({
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
  }, [address, publicClient, sendTransactionAsync, isTenderlyVNet, chainId, simulationResult]);

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
          amount: amountWei,
        });
        setStatus("needsApproval");
        return null;
      }

      // Simulate
      if (!isTenderlyVNet && chainId !== 1337) {
        setStatus("simulating");

        const [tenderlyResult, ethCallResult] = await Promise.all([
          runTenderlySimulation(address, controllerAddress, callData, "0", vaultAddress),
          (async () => {
            try {
              await publicClient.call({ account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` });
              return { ok: true as const };
            } catch (err) {
              return { ok: false as const, errorMessage: err instanceof Error ? err.message : "eth_call failed" };
            }
          })(),
        ]);

        if (tenderlyResult.result) setSimulationResult(tenderlyResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return tenderlyResult.result;
        }

        if (!tenderlyResult.ok && !ethCallResult.ok) {
          const errorMsg = tenderlyResult.errorMessage || ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return tenderlyResult.result;
        }
      } else if (options?.previewOnly) {
        setStatus("idle");
        return null;
      }

      // Execute
      setStatus("executing");
      const hash = await sendTransactionAsync({
        to: controllerAddress as `0x${string}`,
        data: callData as `0x${string}`,
      });

      setTxHash(hash);
      setStatus("waitingTx");

      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 1_000 });
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
  }, [address, publicClient, sendTransactionAsync, isTenderlyVNet, chainId, simulationResult]);

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
          amount: amountWei,
        });
        setStatus("needsApproval");
        return null;
      }

      // Simulate
      if (!isTenderlyVNet && chainId !== 1337) {
        setStatus("simulating");

        const [tenderlyResult, ethCallResult] = await Promise.all([
          runTenderlySimulation(address, controllerAddress, callData, "0", vaultAddress),
          (async () => {
            try {
              await publicClient.call({ account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` });
              return { ok: true as const };
            } catch (err) {
              return { ok: false as const, errorMessage: err instanceof Error ? err.message : "eth_call failed" };
            }
          })(),
        ]);

        if (tenderlyResult.result) setSimulationResult(tenderlyResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return tenderlyResult.result;
        }

        if (!tenderlyResult.ok && !ethCallResult.ok) {
          const errorMsg = tenderlyResult.errorMessage || ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return tenderlyResult.result;
        }
      } else if (options?.previewOnly) {
        setStatus("idle");
        return null;
      }

      // Execute
      setStatus("executing");
      const hash = await sendTransactionAsync({
        to: controllerAddress as `0x${string}`,
        data: callData as `0x${string}`,
      });

      setTxHash(hash);
      setStatus("waitingTx");

      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 1_000 });
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
  }, [address, publicClient, sendTransactionAsync, isTenderlyVNet, chainId, simulationResult]);

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

      // Simulate
      if (!isTenderlyVNet && chainId !== 1337) {
        setStatus("simulating");

        const [tenderlyResult, ethCallResult] = await Promise.all([
          runTenderlySimulation(address, controllerAddress, callData, "0", vaultAddress),
          (async () => {
            try {
              await publicClient.call({ account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` });
              return { ok: true as const };
            } catch (err) {
              return { ok: false as const, errorMessage: err instanceof Error ? err.message : "eth_call failed" };
            }
          })(),
        ]);

        if (tenderlyResult.result) setSimulationResult(tenderlyResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return tenderlyResult.result;
        }

        if (!tenderlyResult.ok && !ethCallResult.ok) {
          const errorMsg = tenderlyResult.errorMessage || ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return tenderlyResult.result;
        }
      } else if (options?.previewOnly) {
        setStatus("idle");
        return null;
      }

      // Execute
      setStatus("executing");
      const hash = await sendTransactionAsync({
        to: controllerAddress as `0x${string}`,
        data: callData as `0x${string}`,
      });

      setTxHash(hash);
      setStatus("waitingTx");

      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 1_000 });
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
  }, [address, publicClient, sendTransactionAsync, isTenderlyVNet, chainId, simulationResult]);

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

  const removeCollateralAndSwap = useCallback(async (
    vaultAddress: `0x${string}`,
    collateralAmount: string,
    tokenOut: string,
    slippage: number = 100,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ): Promise<SimulationResult | null> => {
    if (!address) return null;
    const { parseUnits } = await import("viem");
    const amountWei = parseUnits(collateralAmount, 18);
    // No input amount for approval — we're removing collateral (receiving, not sending)
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
  }, [address, executeBundle]);

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

      // Check collateral token allowance to controller (only if adding collateral)
      if (collateralWei > 0n) {
        const currentAllowance = await checkAllowance(
          publicClient, address, vaultAddress, controllerAddress as `0x${string}`
        );
        if (currentAllowance < collateralWei) {
          setPendingBundle({
            tx: { to: controllerAddress, data: callData, value: "0", from: address },
            gas: "0",
            amountsOut: {},
          });
          setPendingInputToken(vaultAddress);
          setPendingApproval({
            token: vaultAddress,
            tokenSymbol: options?.tokenSymbol ?? "collateral",
            spender: controllerAddress as `0x${string}`,
            amount: collateralWei,
          });
          setStatus("needsApproval");
          return null;
        }
      }

      // Simulate
      if (!isTenderlyVNet && chainId !== 1337) {
        setStatus("simulating");

        const [tenderlyResult, ethCallResult] = await Promise.all([
          runTenderlySimulation(address, controllerAddress, callData, "0", vaultAddress),
          (async () => {
            try {
              await publicClient.call({ account: address, to: controllerAddress as `0x${string}`, data: callData as `0x${string}` });
              return { ok: true as const };
            } catch (err) {
              return { ok: false as const, errorMessage: err instanceof Error ? err.message : "eth_call failed" };
            }
          })(),
        ]);

        if (tenderlyResult.result) setSimulationResult(tenderlyResult.result);

        if (options?.previewOnly) {
          setStatus("idle");
          return tenderlyResult.result;
        }

        if (!tenderlyResult.ok && !ethCallResult.ok) {
          const errorMsg = tenderlyResult.errorMessage || ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return tenderlyResult.result;
        }
      } else if (options?.previewOnly) {
        setStatus("idle");
        return null;
      }

      // Execute
      setStatus("executing");
      const hash = await sendTransactionAsync({
        to: controllerAddress as `0x${string}`,
        data: callData as `0x${string}`,
      });

      setTxHash(hash);
      setStatus("waitingTx");

      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 1_000 });
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
  }, [address, publicClient, sendTransactionAsync, isTenderlyVNet, chainId, simulationResult]);

  const repay = useCallback(async (
    vaultAddress: `0x${string}`,
    repayAmount: string,
    options?: { previewOnly?: boolean }
  ): Promise<SimulationResult | null> => {
    if (!address) return null;
    const { parseUnits } = await import("viem");
    const amountWei = parseUnits(repayAmount, 18);
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
    options?: { previewOnly?: boolean }
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

      // Encode controller.repay(_d_debt, _for, max_active_band)
      const { encodeFunctionData } = await import("viem");
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
        args: [repayAmount, address, 2n ** 255n - 1n],
      });

      // Check crvUSD allowance to controller
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
          amount: repayAmount,
        });
        setStatus("needsApproval");
        return null;
      }

      // Simulate via Tenderly
      if (!isTenderlyVNet && chainId !== 1337) {
        setStatus("simulating");

        const [tenderlyResult, ethCallResult] = await Promise.all([
          runTenderlySimulation(address, controllerAddress, callData, "0", CRVUSD),
          (async () => {
            try {
              await publicClient.call({
                account: address,
                to: controllerAddress,
                data: callData as `0x${string}`,
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

        if (options?.previewOnly) {
          setStatus("idle");
          return tenderlyResult.result;
        }

        if (!tenderlyResult.ok && !ethCallResult.ok) {
          const errorMsg = tenderlyResult.errorMessage || ethCallResult.errorMessage || "Simulation failed";
          setError(parseErrorMessage(new Error(errorMsg)));
          setStatus("error");
          return tenderlyResult.result;
        }
      } else if (options?.previewOnly) {
        setStatus("idle");
        return null;
      }

      // Execute the transaction
      setStatus("executing");

      const hash = await sendTransactionAsync({
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
  }, [address, publicClient, sendTransactionAsync, isTenderlyVNet, chainId, simulationResult]);

  const repayWithSwap = useCallback(async (
    vaultAddress: `0x${string}`,
    tokenIn: string,
    amountIn: string,
    slippage: number = 100,
    options?: { previewOnly?: boolean; tokenSymbol?: string }
  ): Promise<SimulationResult | null> => {
    if (!address) return null;
    const { parseUnits } = await import("viem");
    // TODO: Get decimals from token - for now assume 18
    const amountWei = parseUnits(amountIn, 18);
    return executeBundle(
      () => fetchRepayWithSwapBundle({
        fromAddress: address,
        vaultAddress,
        tokenIn,
        amountIn: amountWei.toString(),
        slippage,
      }),
      tokenIn, // The token being swapped is the input
      amountWei,
      options
    );
  }, [address, executeBundle]);

  // Borrow crvUSD + swap to any token in a single Enso bundle.
  // Uses the "recursive routeMulti" pattern to bypass routeSingle's token pull.
  // Requires one-time controller + crvUSD approvals for ENSO_SHORTCUTS.
  const borrowAndSwap = useCallback(async (
    vaultAddress: `0x${string}`,
    tokenOut: string,
    debtAmount: string, // crvUSD amount (human readable)
    slippage: number = 100,
    options?: { previewOnly?: boolean; tokenSymbol?: string; estimatedSwapOutput?: bigint }
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

    // Check ALL approvals in parallel (controller, crvUSD, swap target).
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

    const [controllerApproved, crvUsdAllowance, swapTargetAllowance] = await Promise.all([
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
    ]);

    // Build full ordered list of all approvals with their status
    const swapTargetSymbol = swapTarget
      ? (isCvgCvxVault ? "CVX" : vaultInfo!.underlyingSymbol)
      : null;
    const tokenSymbol = options?.tokenSymbol ?? "token";
    const allApprovals: { approval: PendingApproval; needed: boolean; label: string; description: string }[] = [
      {
        approval: {
          type: "controller",
          token: controllerAddress as `0x${string}`,
          tokenSymbol: "Controller",
          spender: ENSO_SHORTCUTS as `0x${string}`,
        },
        needed: !controllerApproved,
        label: "Curve Lending",
        description: "Allow Enso Router to borrow on your behalf",
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
        description: "Allow Enso Router to swap borrowed crvUSD",
      },
    ];
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
        description: `Allow Enso Router to deposit ${swapTargetSymbol} into ${tokenSymbol} vault`,
      });
    }

    const total = allApprovals.length;
    const steps = allApprovals.map((a) => ({ label: a.label, description: a.description, done: !a.needed }));
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

      // Run simulation if not on VNet
      if (!isTenderlyVNet && chainId !== 1337) {
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
      } else if (options?.previewOnly) {
        setStatus("idle");
        return null;
      }

      setStatus("executing");

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
  }, [address, publicClient, writeContractAsync, isTenderlyVNet, chainId, simulationResult]);

  return {
    createLoan,
    createLoanWithSwap,
    createLoanWithOutputSwap,
    addCollateral,
    removeCollateral,
    addCollateralWithSwap,
    removeCollateralAndSwap,
    borrowMore,
    repay,
    repayDirect,
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
