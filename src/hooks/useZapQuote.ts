"use client";

import { useEffect, useMemo, useRef } from "react";
import { useAccount, usePublicClient } from "wagmi";

import { useUniversalZap } from "@/hooks/useUniversalZap";
import { useTestNetwork } from "@/contexts/TestNetworkContext";
import { getVaultByAddress } from "@/config/vaults";

import type { EnsoToken, ZapDirection } from "@/types/enso";

interface UseZapQuoteParams {
  inputToken: EnsoToken | null;
  outputToken: EnsoToken | null;
  inputAmount: string;
  direction: ZapDirection;
  vaultAddress: string;
  underlyingToken?: string;
  slippage?: string;
  underlyingTokenPrice?: number;
  paused?: boolean;
}

function buildVaultToken(vaultAddress: string): EnsoToken | null {
  if (!vaultAddress) return null;

  const vault = getVaultByAddress(vaultAddress);
  if (!vault) {
    return {
      address: vaultAddress,
      chainId: 1,
      name: "Vault Shares",
      symbol: "Vault Shares",
      decimals: 18,
      type: "defi",
    };
  }

  return {
    address: vault.address,
    chainId: 1,
    name: vault.name,
    symbol: vault.symbol,
    decimals: vault.decimals,
    logoURI: vault.logoSmall,
    type: "defi",
  };
}

export function useZapQuote({
  inputToken,
  outputToken,
  inputAmount,
  direction,
  vaultAddress,
  underlyingToken: _underlyingToken,
  slippage = "50",
  underlyingTokenPrice: _underlyingTokenPrice,
  paused = false,
}: UseZapQuoteParams) {
  const { address: userAddress } = useAccount();
  const publicClient = usePublicClient();
  const { isTestNetwork } = useTestNetwork();

  const vaultToken = useMemo(() => buildVaultToken(vaultAddress), [vaultAddress]);
  const universalInputToken = direction === "in" ? inputToken : vaultToken;
  const universalOutputToken = direction === "in" ? vaultToken : outputToken;

  // Vault-page zaps are a constrained form of the universal zap flow:
  // one side is always the current vault token, the other is user-selected.
  const {
    quote,
    isLoading,
    error,
    refetch,
  } = useUniversalZap({
    inputToken: universalInputToken,
    outputToken: universalOutputToken,
    inputAmount,
    slippage,
    paused,
  });

  // Validate quote with eth_call on quote refresh (dev only)
  // - Mainnet: use debug trace API (DEBUG_RPC_URL) for detailed traces
  // - VNet: use publicClient.call() directly (goes to VNet RPC via Frame)
  const prevTxDataRef = useRef<string | null>(null);
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    if (!quote?.tx || !userAddress || !publicClient) return;

    const txKey = `${quote.tx.to}-${quote.tx.data}`;
    if (prevTxDataRef.current === txKey) return;
    prevTxDataRef.current = txKey;

    if (isTestNetwork) {
      publicClient
        .call({
          account: userAddress,
          to: quote.tx.to as `0x${string}`,
          data: quote.tx.data as `0x${string}`,
          value: quote.tx.value ? BigInt(quote.tx.value) : 0n,
        })
        .then((result) => {
          console.log("[TestNet] eth_call SUCCESS", { data: result.data });
        })
        .catch((callError: Error) => {
          console.log("[TestNet] eth_call FAILED:", callError.message);
          console.warn(
            "[TestNet] Note: Test forks don't stay in sync with mainnet. " +
            "Enso quotes are based on current mainnet state, which may differ from your fork's state. " +
            "If this failure seems unexpected, try creating a fresher fork."
          );
        });
      return;
    }

    fetch("/api/debug-trace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: userAddress,
        to: quote.tx.to,
        data: quote.tx.data,
        value: quote.tx.value ? `0x${BigInt(quote.tx.value).toString(16)}` : "0x0",
      }),
    })
      .then((res) =>
        res.json() as Promise<{
          success: boolean;
          ethCallSuccess?: boolean;
          error?: string;
          debugInfo?: {
            ethCallError?: { message?: string; code?: number };
            trace?: { error?: string; revertReason?: string; from?: string; to?: string };
            failingCall?: {
              to?: string;
              error?: string;
              revertReason?: string;
              functionSelector?: string;
            };
            fullTrace?: unknown;
          };
        }>,
      )
      .then((result) => {
        if (!result.success) {
          if (result.error !== "DEBUG_RPC_URL not configured") {
            console.log("[Debug RPC] API error:", result.error);
          }
        } else if (result.ethCallSuccess) {
          console.log("[Debug RPC] eth_call SUCCESS");
        } else if (result.debugInfo) {
          console.log("[Debug RPC] eth_call FAILED:", result.debugInfo.ethCallError);
          if (result.debugInfo.trace) {
            console.log("[Debug RPC] Trace result:", result.debugInfo.trace);
          }
          if (result.debugInfo.failingCall) {
            console.log("[Debug RPC] Failing call:", result.debugInfo.failingCall);
          }
          if (result.debugInfo.fullTrace) {
            console.log("[Debug RPC] Full trace (copy to .json file for analysis):");
            console.log(JSON.stringify(result.debugInfo.fullTrace, null, 2));
          }
        }
      })
      .catch(() => {
        // Silently ignore - debug trace is optional
      });
  }, [quote?.tx, userAddress, isTestNetwork, publicClient]);

  return {
    quote,
    isLoading,
    error,
    refetch,
  };
}
