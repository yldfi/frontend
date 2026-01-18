"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { useWalletClient, usePublicClient, useAccount } from "wagmi";
import type { Hash, TransactionRequest } from "viem";
import { FLASHBOTS_RPC_URL } from "@/config/rpc";

const FLASHBOTS_STORAGE_KEY = "yldfi_flashbots_enabled";

/**
 * Wallets that don't support eth_signTransaction (sign without broadcast)
 * These wallets can only do eth_sendTransaction (sign + broadcast combined)
 */
const UNSUPPORTED_WALLET_PATTERNS = [
  "frame",           // Frame wallet
  "ledger",          // Ledger Live
  "trezor",          // Trezor Suite
  "safe",            // Safe (Gnosis Safe)
  "walletconnect",   // WalletConnect v1 (v2 may support it depending on wallet)
];

/**
 * Hook for sending transactions via Flashbots Protect RPC
 * Protects against MEV attacks (frontrunning, sandwich attacks)
 *
 * When enabled:
 * - Transaction is signed by wallet
 * - Signed tx is submitted to Flashbots private mempool
 * - Transaction is not visible in public mempool
 *
 * User can disable to use their wallet's default RPC
 */
export function useFlashbotsProtect() {
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const { connector } = useAccount();

  // Load preference from localStorage
  const [isEnabled, setIsEnabled] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Detect if wallet supports eth_signTransaction
  const isFlashbotsSupported = useMemo(() => {
    if (!connector) return true; // Assume supported until we know

    const connectorName = connector.name?.toLowerCase() ?? "";
    const connectorId = connector.id?.toLowerCase() ?? "";

    // Also check window.ethereum for provider info (some wallets inject this)
    const providerInfo = typeof window !== "undefined"
      ? (window.ethereum as { isFrame?: boolean })?.isFrame
      : false;

    // Check if wallet is in the unsupported list
    const isUnsupported = UNSUPPORTED_WALLET_PATTERNS.some(
      (pattern) => connectorName.includes(pattern) || connectorId.includes(pattern)
    ) || providerInfo; // Frame sets isFrame = true

    return !isUnsupported;
  }, [connector]);

  // Load saved preference on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem(FLASHBOTS_STORAGE_KEY);
      // Default to true (enabled) if not set
      setIsEnabled(saved !== "false");
    }
  }, []);

  // Toggle Flashbots protection
  const toggleFlashbots = useCallback((enabled: boolean) => {
    setIsEnabled(enabled);
    if (typeof window !== "undefined") {
      localStorage.setItem(FLASHBOTS_STORAGE_KEY, String(enabled));
    }
  }, []);

  /**
   * Send transaction via Flashbots Protect RPC
   * Returns transaction hash
   */
  const sendViaFlashbots = useCallback(async (
    tx: TransactionRequest
  ): Promise<Hash> => {
    if (!walletClient) {
      throw new Error("Wallet not connected");
    }
    if (!publicClient) {
      throw new Error("Public client not available");
    }

    setIsLoading(true);
    setError(null);

    try {
      // Prepare transaction with gas estimation if not provided
      const preparedTx = {
        ...tx,
        account: walletClient.account,
        chain: walletClient.chain,
      };

      // Sign the transaction (wallet popup)
      const signedTx = await walletClient.signTransaction(preparedTx);

      // Submit signed transaction to Flashbots RPC
      const response = await fetch(FLASHBOTS_RPC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_sendRawTransaction",
          params: [signedTx],
        }),
      });

      const result = await response.json() as {
        result?: string;
        error?: { message?: string };
      };

      if (result.error) {
        throw new Error(result.error.message || "Flashbots submission failed");
      }

      if (!result.result) {
        throw new Error("No transaction hash returned from Flashbots");
      }

      const hash = result.result as Hash;
      return hash;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [walletClient, publicClient]);

  return {
    isFlashbotsEnabled: isEnabled,
    isFlashbotsSupported,
    toggleFlashbots,
    sendViaFlashbots,
    isLoading,
    error,
  };
}
