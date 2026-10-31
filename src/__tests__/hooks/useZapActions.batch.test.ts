import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, parseUnits } from "viem";
import { useAccount, usePublicClient, useReadContract, useWaitForTransactionReceipt, useWalletClient } from "wagmi";

import { useZapActions } from "@/hooks/useZapActions";
import { ENSO_ROUTER_V2 } from "@/lib/enso";
import { ERC20_APPROVAL_ABI } from "@/lib/abis";
import type { EnsoToken, ZapQuote } from "@/types/enso";

const { mockSendTx, mockSendBatch, mockWriteApprove, mockAnvilCall, batchState } = vi.hoisted(() => ({
  mockSendTx: vi.fn(),
  mockSendBatch: vi.fn(),
  mockWriteApprove: vi.fn(),
  mockAnvilCall: vi.fn(),
  batchState: { canBatch: true },
}));

vi.mock("@/hooks/useSafeBatch", () => ({
  useSafeBatch: () => ({ canBatch: batchState.canBatch, sendBatch: mockSendBatch }),
}));
vi.mock("@/hooks/useDirectWriteContract", () => ({
  useDirectWriteContract: vi.fn(() => ({ writeContract: mockWriteApprove, data: undefined, reset: vi.fn(), error: null })),
}));
vi.mock("@/contexts/TestNetworkContext", () => ({ useTestNetwork: vi.fn(() => ({ testNetworkType: null })) }));
vi.mock("@/hooks/useFlashbotsProtect", () => ({
  useFlashbotsProtect: vi.fn(() => ({ isFlashbotsEnabled: false, isFlashbotsSupported: false, toggleFlashbots: vi.fn() })),
}));
vi.mock("@/hooks/useSendTx", () => ({ useSendTx: vi.fn(() => ({ sendTx: mockSendTx })) }));
vi.mock("@/lib/tx-utils", () => ({
  anvilCall: mockAnvilCall,
  parseErrorMessage: (error: Error, prefix?: string) => (prefix ? `${prefix}: ${error.message}` : error.message),
}));

const SAFE = "0x8baecb301FD723Ff35FB1D9a6d595cAD35618A6f" as const;
const SAFE_TX_HASH = "0x25bc99a3a5b83fb8f7e012607ddbfcd4b7b86cf167c15914459c8fea276b9963";

const USDC: EnsoToken = {
  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  chainId: 1,
  name: "USD Coin",
  symbol: "USDC",
  decimals: 6,
  type: "base",
};
const QUOTE: ZapQuote = {
  inputToken: USDC,
  inputAmount: "1000",
  outputAmount: "1100000000000000000000",
  outputAmountFormatted: "1100",
  exchangeRate: 1.1,
  inputUsdValue: 1000,
  outputUsdValue: 990,
  priceImpact: 1.0,
  gasEstimate: "300000",
  tx: { to: "0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E", data: "0xabcdef", value: "0" },
  route: [],
};

describe("useZapActions Safe batch", () => {
  let simulateBodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.clearAllMocks();
    batchState.canBatch = true;
    simulateBodies = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/api/simulate/nonce")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, nonce: "n", expires: Date.now() + 60_000, sig: "s" }) });
      }
      if (url.includes("/api/simulate")) {
        simulateBodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, gasUsed: 1, simulationId: "sim", tenderlyUrl: null, assetChanges: [], errorMessage: null }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }));
    vi.mocked(useAccount).mockReturnValue({ address: SAFE, chainId: 1, isConnected: true } as unknown as ReturnType<typeof useAccount>);
    vi.mocked(usePublicClient).mockReturnValue({
      getBlockNumber: vi.fn().mockResolvedValue(26313129n),
      readContract: vi.fn().mockResolvedValue(0n), // no allowance
    } as unknown as ReturnType<typeof usePublicClient>);
    vi.mocked(useWalletClient).mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useWalletClient>);
    vi.mocked(useReadContract).mockReturnValue({ data: 0n, refetch: vi.fn() } as unknown as ReturnType<typeof useReadContract>);
    vi.mocked(useWaitForTransactionReceipt).mockReturnValue({ isLoading: false, isSuccess: false, data: undefined } as unknown as ReturnType<typeof useWaitForTransactionReceipt>);
    mockAnvilCall.mockRejectedValue(new Error("insufficient allowance"));
    mockSendBatch.mockResolvedValue(SAFE_TX_HASH);
  });

  it("approve skips the separate approval tx: preview simulates both, confirm sends one batch", async () => {
    const { result } = renderHook(() => useZapActions(QUOTE));

    // 1. Zap click: allowance is short, so the approval card appears.
    await act(async () => {
      await result.current.executeZap({ previewOnly: true });
    });
    expect(result.current.status).toBe("needsApproval");

    // 2. Approve (exact): no approval transaction, straight to the zap preview.
    await act(async () => {
      await result.current.approve(true);
    });
    expect(mockWriteApprove).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.simulationResult?.success).toBe(true));
    const exact = parseUnits("1000", 6);
    const approvals = simulateBodies.at(-1)!.approvalTransactions as Array<{ to: string; data: `0x${string}` }>;
    expect(approvals.map((a) => a.to)).toEqual([USDC.address]);
    expect(decodeFunctionData({ abi: ERC20_APPROVAL_ABI, data: approvals[0].data }).args).toEqual([ENSO_ROUTER_V2, exact]);

    // 3. Confirm in the preview: no second approval prompt, one atomic batch.
    await act(async () => {
      await result.current.executeZap({ skipSimulation: true });
    });
    expect(result.current.status).not.toBe("needsApproval");
    expect(mockSendTx).not.toHaveBeenCalled();
    const [calls] = mockSendBatch.mock.calls[0] as [Array<{ to: string; data: string }>];
    expect(calls.map((c) => c.to)).toEqual([USDC.address, QUOTE.tx.to]);
    expect(calls[1].data).toBe(QUOTE.tx.data);
    expect(result.current.zapHash).toBe(SAFE_TX_HASH);
  });

  it("keeps the two-step approval when batching isn't available", async () => {
    batchState.canBatch = false;
    const { result } = renderHook(() => useZapActions(QUOTE));

    await act(async () => {
      await result.current.executeZap({ previewOnly: true });
    });
    await act(async () => {
      await result.current.approve(true);
    });

    expect(mockWriteApprove).toHaveBeenCalledTimes(1);
    expect(mockSendBatch).not.toHaveBeenCalled();
  });
});
