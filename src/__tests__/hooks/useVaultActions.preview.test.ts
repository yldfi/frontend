import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { maxUint256 } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWaitForTransactionReceipt,
} from "wagmi";

import { useVaultActions } from "@/hooks/useVaultActions";

const {
  mockAnvilCall,
  mockSendTx,
  mockWriteApprove,
  mockResetApprove,
} = vi.hoisted(() => ({
  mockAnvilCall: vi.fn(),
  mockSendTx: vi.fn(),
  mockWriteApprove: vi.fn(),
  mockResetApprove: vi.fn(),
}));

vi.mock("@/hooks/useDirectWriteContract", () => ({
  useDirectWriteContract: vi.fn(() => ({
    writeContract: mockWriteApprove,
    data: undefined,
    reset: mockResetApprove,
    error: null,
  })),
}));

vi.mock("@/contexts/TestNetworkContext", () => ({
  useTestNetwork: vi.fn(() => ({
    testNetworkType: null,
  })),
}));

vi.mock("@/hooks/useSendTx", () => ({
  useSendTx: vi.fn(() => ({
    sendTx: mockSendTx,
  })),
}));

vi.mock("@/lib/tx-utils", () => ({
  anvilCall: mockAnvilCall,
  parseErrorMessage: (error: Error, prefix?: string) =>
    prefix ? `${prefix}: ${error.message}` : error.message,
}));

const mockUseAccount = vi.mocked(useAccount);
const mockUsePublicClient = vi.mocked(usePublicClient);
const mockUseReadContract = vi.mocked(useReadContract);
const mockUseWaitForTransactionReceipt = vi.mocked(useWaitForTransactionReceipt);

describe("useVaultActions preview fallback", () => {
  const userAddress = "0x1234567890123456789012345678901234567890" as `0x${string}`;
  const vaultAddress = "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e" as `0x${string}`;
  const tokenAddress = "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B" as `0x${string}`;

  beforeEach(() => {
    vi.clearAllMocks();

    // Simulate a client-side timeout/network error against /api/simulate
    // (e.g. Tenderly's first-ever look at a freshly deployed vault runs slow)
    // — mirrors the exact failure mode reported for the ysCVX strategy.
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/simulate/nonce")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            nonce: "test-nonce",
            expires: Date.now() + 60_000,
            sig: "test-sig",
          }),
        });
      }

      if (url.includes("/api/simulate")) {
        return Promise.reject(new Error("The operation was aborted"));
      }

      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }));

    mockUseAccount.mockReturnValue({
      address: userAddress,
      chainId: 1,
      isConnected: true,
    } as unknown as ReturnType<typeof useAccount>);

    mockUsePublicClient.mockReturnValue({} as ReturnType<typeof usePublicClient>);

    mockUseReadContract.mockReturnValue({
      data: maxUint256,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useReadContract>);

    mockUseWaitForTransactionReceipt.mockReturnValue({
      isLoading: false,
      isSuccess: false,
      data: undefined,
    } as unknown as ReturnType<typeof useWaitForTransactionReceipt>);

    mockAnvilCall.mockResolvedValue(undefined);
    mockSendTx.mockResolvedValue("0xabcdef1234567890");
  });

  it("returns a simulation-unavailable preview result instead of sending immediately", async () => {
    const { result } = renderHook(() => useVaultActions(vaultAddress, tokenAddress, 18));

    let previewResult: unknown = null;
    await act(async () => {
      previewResult = await result.current.deposit("100", { previewOnly: true });
    });

    expect(previewResult).toMatchObject({
      success: true,
      simulationUnavailable: true,
    });
    expect(result.current.simulationResult).toMatchObject({
      success: true,
      simulationUnavailable: true,
    });
    expect(mockSendTx).not.toHaveBeenCalled();
  });

  it("still sends on confirm after an unavailable preview result", async () => {
    const { result } = renderHook(() => useVaultActions(vaultAddress, tokenAddress, 18));

    await act(async () => {
      await result.current.deposit("100", { previewOnly: true });
    });

    await act(async () => {
      await result.current.executeAfterPreview();
    });

    expect(mockSendTx).toHaveBeenCalledWith(
      expect.objectContaining({ to: vaultAddress })
    );
  });
});
