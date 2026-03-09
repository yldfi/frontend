"use client";

import { useCallback } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { useDirectSendTransaction } from "@/hooks/useDirectSendTransaction";
import { useFlashbotsProtect } from "@/hooks/useFlashbotsProtect";
import { useTestNetwork } from "@/contexts/TestNetworkContext";

/**
 * Shared transaction sender with universal gas estimation, Flashbots MEV protection,
 * and VNet impersonation support.
 *
 * Flow:
 *   1. Estimate gas with 30% buffer (unless caller provides `gas`)
 *   2. Flashbots route (mainnet, enabled, not on test network)
 *   3. Default → wagmi sendTransactionAsync (test-network-aware via useDirectSendTransaction)
 */
export function useSendTx() {
  const publicClient = usePublicClient();
  const { address: userAddress, chainId } = useAccount();
  const { testNetworkType } = useTestNetwork();
  const { isFlashbotsEnabled, isFlashbotsSupported, sendViaFlashbots } = useFlashbotsProtect();
  const { sendTransactionAsync } = useDirectSendTransaction();

  const sendTx = useCallback(
    async (params: {
      to: `0x${string}`;
      data: `0x${string}`;
      value?: bigint;
      gas?: bigint;
    }): Promise<`0x${string}`> => {
      const isDev = process.env.NODE_ENV === "development";

      if (isDev) {
        console.log("[sendTx] routing decision:", {
          to: params.to,
          selector: params.data.slice(0, 10),
          value: params.value?.toString() ?? "0",
          callerGas: params.gas?.toString(),
          chainId,
          testNetworkType,
          isFlashbotsEnabled,
          isFlashbotsSupported,
          willUseFlashbots: isFlashbotsEnabled && isFlashbotsSupported && testNetworkType === null && chainId === 1,
        });
      }

      // 1. Gas estimation with 30% buffer (skip if caller provided gas)
      let gas = params.gas;
      if (!gas && publicClient && userAddress) {
        try {
          const estimate = await publicClient.estimateGas({
            account: userAddress,
            to: params.to,
            data: params.data,
            value: params.value,
          });
          gas = (estimate * 130n) / 100n;
          if (isDev) {
            console.log(`[sendTx] gas estimate: ${estimate} → limit: ${gas} (130%)`);
          }
        } catch {
          // Estimation failed — leave undefined so wallet estimates
          if (isDev) {
            console.log("[sendTx] gas estimation failed, relying on wallet");
          }
        }
      }

      const txParams = {
        to: params.to,
        data: params.data,
        value: params.value,
        ...(gas ? { gas } : {}),
      };

      // 2. Flashbots path (mainnet only, not on test networks, wallet must support signTransaction)
      if (isFlashbotsEnabled && isFlashbotsSupported && testNetworkType === null && chainId === 1) {
        if (isDev) console.log("[sendTx] → Flashbots Protect");
        try {
          const hash = await sendViaFlashbots(txParams);
          if (isDev) console.log("[sendTx] Flashbots hash:", hash);
          return hash;
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          // Wallet doesn't support eth_signTransaction — fall back to regular send
          const isUnsupportedMethod =
            errorMsg.includes("eth_signTransaction") &&
            (errorMsg.includes("not supported") || errorMsg.includes("does not exist"));
          if (isUnsupportedMethod) {
            if (isDev) console.log("[sendTx] → Flashbots fallback to wallet (eth_signTransaction unsupported)");
            const hash = await sendTransactionAsync(txParams);
            if (isDev) console.log("[sendTx] wallet hash:", hash);
            return hash;
          }
          throw err;
        }
      }

      // 3. Default — wagmi (test-network-aware via useDirectSendTransaction)
      if (isDev) console.log("[sendTx] → wallet sendTransaction");
      const hash = await sendTransactionAsync(txParams);
      if (isDev) console.log("[sendTx] wallet hash:", hash);
      return hash;
    },
    [publicClient, userAddress, chainId, testNetworkType, isFlashbotsEnabled, isFlashbotsSupported, sendViaFlashbots, sendTransactionAsync]
  );

  return { sendTx };
}
