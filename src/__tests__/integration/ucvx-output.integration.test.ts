// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crossFetch from "cross-fetch";

beforeAll(() => {
  globalThis.fetch = crossFetch;
});

afterAll(() => {
  globalThis.fetch = vi.fn();
});

import { ETH_ADDRESS, fetchAnyToPxCvxRoute, fetchPxCvxZapInRoute } from "@/lib/enso";
import { LLAMA_AIRFORCE, VAULT_ADDRESSES } from "@/config/vaults";

const TEST_WALLET = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const TEST_ETH_IN = "30000000000000000"; // 0.03 ETH
const API_TIMEOUT = 90000;

const SIMULATION_RPC_URL = process.env.DEBUG_RPC_URL || process.env.NEXT_PUBLIC_ALCHEMY_RPC_URL;
const SIMULATION_RPC_AUTH = process.env.DEBUG_RPC_AUTH;

function decodeRevertReason(error: { message?: string; data?: string }): string | undefined {
  if (error.message) return error.message;
  if (error.data) return error.data;
  return undefined;
}

async function simulateEthBundle(params: {
  from: string;
  to: string;
  data: string;
  value: string;
}): Promise<{
  success: boolean;
  error?: string;
  revertReason?: string;
  failingCall?: { type?: string; to?: string; error?: string };
}> {
  if (!SIMULATION_RPC_URL) {
    return { success: false, error: "No simulation RPC configured (set DEBUG_RPC_URL)" };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (SIMULATION_RPC_AUTH) {
    headers["Authorization"] = `Basic ${SIMULATION_RPC_AUTH}`;
  }

  const response = await crossFetch(SIMULATION_RPC_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        {
          from: params.from,
          to: params.to,
          data: params.data,
          value: "0x" + BigInt(params.value).toString(16),
        },
        "latest",
      ],
    }),
  });

  const result = await response.json() as { error?: { message?: string; data?: string }; result?: string };

  if (result.error) {
    let failingCall: { type?: string; to?: string; error?: string } | undefined;

    try {
      const traceResponse = await crossFetch(SIMULATION_RPC_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "debug_traceCall",
          params: [
            {
              from: params.from,
              to: params.to,
              data: params.data,
              value: "0x" + BigInt(params.value).toString(16),
            },
            "latest",
            { tracer: "callTracer" },
          ],
        }),
      });

      type TraceCall = { type?: string; to?: string; error?: string; calls?: TraceCall[] };
      const traceResult = await traceResponse.json() as { result?: TraceCall };

      const findFailingCall = (call: TraceCall): { type?: string; to?: string; error?: string } | undefined => {
        if (call.error) {
          return { type: call.type, to: call.to, error: call.error };
        }
        return call.calls?.map(findFailingCall).find(Boolean);
      };

      if (traceResult.result) {
        failingCall = findFailingCall(traceResult.result);
      }
    } catch {
      // debug_traceCall may not be available on the configured RPC
    }

    return {
      success: false,
      error: result.error.message,
      revertReason: decodeRevertReason(result.error),
      failingCall,
    };
  }

  return { success: true };
}

describe("uCVX output integration", () => {
  const runIfConfigured = SIMULATION_RPC_URL ? it : it.skip;

  runIfConfigured(
    "ETH -> yspxCVX builds and simulates",
    async () => {
      const result = await fetchPxCvxZapInRoute({
        fromAddress: TEST_WALLET,
        inputToken: ETH_ADDRESS,
        amountIn: TEST_ETH_IN,
        vaultAddress: VAULT_ADDRESSES.YSPXCVX,
      });

      expect(result.tx.to).toBeTruthy();
      expect(result.tx.data).toBeTruthy();

      const simulation = await simulateEthBundle({
        from: TEST_WALLET,
        to: result.tx.to,
        data: result.tx.data,
        value: TEST_ETH_IN,
      });

      if (!simulation.success) {
        console.error("ETH -> yspxCVX simulation failed:", simulation.error, simulation.revertReason, simulation.failingCall);
      }

      expect(simulation.success).toBe(true);
    },
    API_TIMEOUT,
  );

  runIfConfigured(
    "ETH -> pxCVX builds and simulates",
    async () => {
      const result = await fetchAnyToPxCvxRoute({
        fromAddress: TEST_WALLET,
        inputToken: ETH_ADDRESS,
        amountIn: TEST_ETH_IN,
      });

      expect(result.tx.to).toBeTruthy();
      expect(result.tx.data).toBeTruthy();

      const simulation = await simulateEthBundle({
        from: TEST_WALLET,
        to: result.tx.to,
        data: result.tx.data,
        value: TEST_ETH_IN,
      });

      if (!simulation.success) {
        console.error("ETH -> pxCVX simulation failed:", simulation.error, simulation.revertReason, simulation.failingCall);
      }

      expect(simulation.success).toBe(true);
    },
    API_TIMEOUT,
  );

  runIfConfigured(
    "ETH -> uCVX builds and simulates",
    async () => {
      const result = await fetchAnyToPxCvxRoute({
        fromAddress: TEST_WALLET,
        inputToken: ETH_ADDRESS,
        amountIn: TEST_ETH_IN,
        depositIntoVault: LLAMA_AIRFORCE.UCVX,
      });

      expect(result.tx.to).toBeTruthy();
      expect(result.tx.data).toBeTruthy();

      const simulation = await simulateEthBundle({
        from: TEST_WALLET,
        to: result.tx.to,
        data: result.tx.data,
        value: TEST_ETH_IN,
      });

      if (!simulation.success) {
        console.error("ETH -> uCVX simulation failed:", simulation.error, simulation.revertReason, simulation.failingCall);
      }

      expect(simulation.success).toBe(true);
    },
    API_TIMEOUT,
  );
});
