import type { Chain, PublicClient, Transport } from "viem";
import type { SimulationResult } from "@/types/enso";
import { anvilCall } from "@/lib/tx-utils";
import { runVNetSimulation } from "@/lib/vnet-simulation";
import { simulationNonceBinding } from "@/lib/simulation-nonce";

/**
 * Shared preflight for zap and vault transactions: fetch a signed nonce, POST
 * the transaction to the Tenderly API (or the connected VNet), and run a plain
 * eth_call in parallel. Each hook keeps its own state handling around this.
 */

export type PreflightSimResult = {
  ok: boolean;
  result?: (SimulationResult & { retryable?: boolean }) | null;
  errorMessage?: SimulationResult["errorMessage"];
  retryable?: boolean;
};

export type PreflightEthCallResult = { ok: true } | { ok: false; errorMessage: string };

export interface RunTxPreflightParams {
  publicClient: PublicClient<Transport, Chain>;
  userAddress: `0x${string}`;
  tx: { to: `0x${string}`; data: `0x${string}`; value: bigint };
  /** The exact object the hook passes to anvilCall today. */
  ethCall: Parameters<typeof anvilCall>[1];
  /** inputToken / spender / approvalTransactions, when the caller sends them. */
  simulateBodyExtra?: Record<string, unknown>;
  /** Value in the format the caller already passes to runVNetSimulation. */
  vnetValue: string;
  testNetworkType: "tenderly" | "anvil" | null;
  chainId: number | undefined;
  logTag: string;
}

/** Read a simulation error as text, whether it is a string or an object. */
export function getSimulationErrorText(
  errorMessage: SimulationResult["errorMessage"] | undefined,
): string | null {
  if (!errorMessage) return null;
  if (typeof errorMessage === "string") return errorMessage;
  return errorMessage.message || errorMessage.slug || null;
}

/** Build the "Tenderly unavailable, eth_call passed" result both hooks store. */
export function buildUnavailableSimulationResult(
  simResult: SimulationResult | null | undefined,
  reason: string,
): SimulationResult {
  if (simResult) {
    return {
      ...simResult,
      success: true,
      simulationUnavailable: true,
      simulationUnavailableReason: reason,
      errorMessage: null,
    };
  }
  return {
    success: true,
    gasUsed: null,
    simulationId: null,
    tenderlyUrl: null,
    assetChanges: [],
    errorMessage: null,
    simulationUnavailable: true,
    simulationUnavailableReason: reason,
  };
}

export async function runTxPreflight({
  publicClient,
  userAddress,
  tx,
  ethCall,
  simulateBodyExtra,
  vnetValue,
  testNetworkType,
  chainId,
  logTag,
}: RunTxPreflightParams): Promise<{
  simResult: PreflightSimResult;
  ethCallResult: PreflightEthCallResult;
}> {
  // Three-way simulation:
  // 1. Mainnet → Tenderly REST API
  // 2. Tenderly VNet → VNet RPC simulation
  // 3. Anvil / chainId 1337 → skip (eth_call only below)
  const simPromise: Promise<PreflightSimResult> = (testNetworkType === null && chainId !== 1337)
    ? (async () => {
        try {
          const nonceResponse = await fetch(
            `/api/simulate/nonce?bind=${simulationNonceBinding({
              from: userAddress,
              to: tx.to,
              data: tx.data,
              value: tx.value.toString(),
            })}`,
            {
              method: "GET",
              headers: { "Content-Type": "application/json" },
              signal: AbortSignal.timeout(5_000), // 5s timeout
            },
          );
          const nonceResult = (await nonceResponse.json()) as {
            success: boolean;
            nonce?: string;
            expires?: number;
            sig?: string;
          };

          if (!nonceResult.success || !nonceResult.nonce || !nonceResult.expires || !nonceResult.sig) {
            return {
              ok: false as const,
              errorMessage: "Failed to obtain simulation nonce",
              retryable: true,
            };
          }

          const response = await fetch("/api/simulate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              // Extras first: the four fields below are what the nonce binds,
              // so they must always win over any colliding extra.
              ...simulateBodyExtra,
              from: userAddress,
              to: tx.to,
              data: tx.data,
              value: tx.value.toString(),
              nonce: nonceResult.nonce,
              expires: nonceResult.expires,
              sig: nonceResult.sig,
            }),
            signal: AbortSignal.timeout(20_000), // 20s timeout
          });

          const result = (await response.json()) as SimulationResult & { retryable?: boolean };

          if (process.env.NODE_ENV === "development") {
            console.log(logTag, {
              success: result.success,
              simulationId: result.simulationId,
              tenderlyUrl: result.tenderlyUrl,
              gasUsed: result.gasUsed,
              errorMessage: result.errorMessage,
              assetChanges: result.assetChanges?.length ?? 0,
            });
          }

          if (result.success) return { ok: true as const, result };
          return {
            ok: false as const,
            result,
            errorMessage: result.errorMessage ?? "Tenderly simulation failed",
            retryable: Boolean(result.retryable),
          };
        } catch (error) {
          return {
            ok: false as const,
            result: null,
            errorMessage: error instanceof Error ? error.message : "Tenderly simulation failed",
            retryable: true,
          };
        }
      })()
    : (testNetworkType === "tenderly")
      ? runVNetSimulation(
          publicClient.transport,
          { from: userAddress, to: tx.to, data: tx.data, value: vnetValue },
          userAddress,
        )
      : Promise.resolve({ ok: true as const, result: null });

  const ethCallPromise: Promise<PreflightEthCallResult> = (async () => {
    try {
      await anvilCall(publicClient, ethCall);
      if (process.env.NODE_ENV === "development") console.log("[eth_call]", { ok: true, to: tx.to });
      return { ok: true as const };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      if (process.env.NODE_ENV === "development") console.log("[eth_call]", { ok: false, to: tx.to, error: msg });
      return {
        ok: false as const,
        errorMessage: msg,
      };
    }
  })();

  const [simResult, ethCallResult] = await Promise.all([simPromise, ethCallPromise]);

  return { simResult, ethCallResult };
}
