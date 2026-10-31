import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, parseUnits } from "viem";
import { useAccount, usePublicClient, useReadContract, useWaitForTransactionReceipt } from "wagmi";

import { useVaultActions } from "@/hooks/useVaultActions";
import { ERC20_APPROVAL_ABI, VAULT_ABI } from "@/lib/abis";

const { mockSendTx, mockSendBatch, mockAnvilCall, batchState } = vi.hoisted(() => ({
  mockSendTx: vi.fn(),
  mockSendBatch: vi.fn(),
  mockAnvilCall: vi.fn(),
  batchState: { canBatch: true },
}));

vi.mock("@/hooks/useSafeBatch", () => ({
  useSafeBatch: () => ({ canBatch: batchState.canBatch, sendBatch: mockSendBatch }),
}));
vi.mock("@/hooks/useDirectWriteContract", () => ({
  useDirectWriteContract: vi.fn(() => ({ writeContract: vi.fn(), data: undefined, reset: vi.fn(), error: null })),
}));
vi.mock("@/contexts/TestNetworkContext", () => ({ useTestNetwork: vi.fn(() => ({ testNetworkType: null })) }));
vi.mock("@/hooks/useSendTx", () => ({ useSendTx: vi.fn(() => ({ sendTx: mockSendTx })) }));
vi.mock("@/lib/approval-reset", () => ({ shouldResetApprovalToZeroFirst: vi.fn().mockResolvedValue(false) }));
vi.mock("@/lib/tx-utils", () => ({
  anvilCall: mockAnvilCall,
  parseErrorMessage: (error: Error, prefix?: string) => (prefix ? `${prefix}: ${error.message}` : error.message),
}));

const SAFE = "0x8baecb301FD723Ff35FB1D9a6d595cAD35618A6f" as const;
const VAULT = "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e" as const;
const CVX = "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B" as const;
const SAFE_TX_HASH = "0x25bc99a3a5b83fb8f7e012607ddbfcd4b7b86cf167c15914459c8fea276b9963";

describe("useVaultActions Safe batch deposit", () => {
  let simulateBody: Record<string, unknown> | null;

  beforeEach(() => {
    vi.clearAllMocks();
    batchState.canBatch = true;
    simulateBody = null;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/api/simulate/nonce")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, nonce: "n", expires: Date.now() + 60_000, sig: "s" }) });
      }
      if (url.includes("/api/simulate")) {
        simulateBody = JSON.parse(String(init?.body));
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, gasUsed: 1, simulationId: "sim", tenderlyUrl: null, assetChanges: [], errorMessage: null }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }));
    vi.mocked(useAccount).mockReturnValue({ address: SAFE, chainId: 1, isConnected: true } as unknown as ReturnType<typeof useAccount>);
    vi.mocked(usePublicClient).mockReturnValue({} as ReturnType<typeof usePublicClient>);
    // No allowance yet: the approval rides in the batch.
    vi.mocked(useReadContract).mockReturnValue({ data: 0n, refetch: vi.fn() } as unknown as ReturnType<typeof useReadContract>);
    vi.mocked(useWaitForTransactionReceipt).mockReturnValue({ isLoading: false, isSuccess: false, data: undefined } as unknown as ReturnType<typeof useWaitForTransactionReceipt>);
    // A plain eth_call of the deposit alone reverts without the allowance.
    mockAnvilCall.mockRejectedValue(new Error("insufficient allowance"));
    mockSendBatch.mockResolvedValue(SAFE_TX_HASH);
  });

  it("previews approve + deposit together, then sends them as one atomic batch", async () => {
    const amount = parseUnits("100", 18);
    const { result } = renderHook(() => useVaultActions(VAULT, CVX, 18));

    await act(async () => {
      const preview = await result.current.deposit("100", { previewOnly: true, batchApproval: amount });
      expect(preview?.success).toBe(true);
    });

    // The simulation replays the approval right before the deposit.
    expect(simulateBody).toMatchObject({ to: VAULT, inputToken: CVX, spender: VAULT });
    const simApprovals = simulateBody!.approvalTransactions as Array<{ to: string; data: `0x${string}` }>;
    expect(simApprovals).toHaveLength(1);
    expect(decodeFunctionData({ abi: ERC20_APPROVAL_ABI, data: simApprovals[0].data }).args).toEqual([VAULT, amount]);

    await act(async () => {
      await result.current.executeAfterPreview();
    });

    expect(mockSendTx).not.toHaveBeenCalled();
    const [calls] = mockSendBatch.mock.calls[0] as [Array<{ to: string; data: `0x${string}` }>];
    expect(calls.map((c) => c.to)).toEqual([CVX, VAULT]);
    expect(decodeFunctionData({ abi: ERC20_APPROVAL_ABI, data: calls[0].data }).functionName).toBe("approve");
    expect(decodeFunctionData({ abi: VAULT_ABI, data: calls[1].data }).args).toEqual([amount, SAFE]);
    expect(result.current.depositHash).toBe(SAFE_TX_HASH);
  });

  it("keeps the normal single-transaction path when batching isn't available", async () => {
    batchState.canBatch = false;
    mockAnvilCall.mockResolvedValue(undefined);
    mockSendTx.mockResolvedValue("0xabc");
    const { result } = renderHook(() => useVaultActions(VAULT, CVX, 18));

    await act(async () => {
      await result.current.deposit("100", { previewOnly: true, batchApproval: parseUnits("100", 18) });
    });
    expect(simulateBody).not.toHaveProperty("approvalTransactions");

    await act(async () => {
      await result.current.executeAfterPreview();
    });
    expect(mockSendBatch).not.toHaveBeenCalled();
    expect(mockSendTx).toHaveBeenCalledTimes(1);
  });
});
