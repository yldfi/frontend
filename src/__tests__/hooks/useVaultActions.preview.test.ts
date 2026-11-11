import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { maxUint256, parseUnits } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWaitForTransactionReceipt,
} from "wagmi";

import { useVaultActions } from "@/hooks/useVaultActions";
import { simulationNonceBinding } from "@/lib/simulation-nonce";

const {
  mockAnvilCall,
  mockSendTx,
  mockSendBatch,
  batchState,
  mockWriteApprove,
  mockResetApprove,
  approvalHashState,
  approvalErrorState,
} = vi.hoisted(() => ({
  mockAnvilCall: vi.fn(),
  mockSendTx: vi.fn(),
  mockSendBatch: vi.fn(),
  // The Safe batch path is the only send path that runs the shared preflight;
  // off by default so every other test keeps the two-step flow.
  batchState: { canBatch: false },
  mockWriteApprove: vi.fn(),
  mockResetApprove: vi.fn(),
  approvalHashState: { current: undefined as `0x${string}` | undefined },
  approvalErrorState: { current: null as Error | null },
}));

vi.mock("@/hooks/useSafeBatch", () => ({
  useSafeBatch: () => ({ canBatch: batchState.canBatch, sendBatch: mockSendBatch }),
}));

vi.mock("@/hooks/useDirectWriteContract", () => ({
  useDirectWriteContract: vi.fn(() => ({
    writeContract: mockWriteApprove,
    data: approvalHashState.current,
    reset: mockResetApprove,
    error: approvalErrorState.current,
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
    batchState.canBatch = false;
    approvalHashState.current = undefined;
    approvalErrorState.current = null;

    // Behave like the real write hook's reset: it clears both the error and
    // the transaction hash (and therefore the receipt derived from it).
    mockResetApprove.mockImplementation(() => {
      approvalErrorState.current = null;
      approvalHashState.current = undefined;
    });

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
    mockSendBatch.mockResolvedValue("0x25bc99a3a5b83fb8f7e012607ddbfcd4b7b86cf167c15914459c8fea276b9963");
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

  it("blocks the batch deposit when the simulation and the eth_call both fail", async () => {
    batchState.canBatch = true;
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

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: false,
          gasUsed: null,
          errorMessage: "execution reverted: vault paused",
          simulationId: null,
          tenderlyUrl: null,
          assetChanges: [],
        }),
      });
    }));
    mockAnvilCall.mockRejectedValue(new Error("execution reverted"));

    const { result } = renderHook(() => useVaultActions(vaultAddress, tokenAddress, 18));

    await act(async () => {
      await result.current.deposit("100", { batchApproval: parseUnits("100", 18) });
    });

    expect(mockSendTx).not.toHaveBeenCalled();
    expect(mockSendBatch).not.toHaveBeenCalled();
    expect(result.current.error).toBe("Transaction would fail: execution reverted: vault paused");
    // The failed preflight ends the action (not stuck simulating/depositing).
    expect(result.current.isLoading).toBe(false);
    expect(result.current.status).toBe("error");
  });

  it("uses a slug-only simulation error as the failure text", async () => {
    batchState.canBatch = true;
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

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: false,
          gasUsed: null,
          errorMessage: { slug: "simulation_reverted" },
          simulationId: null,
          tenderlyUrl: null,
          assetChanges: [],
        }),
      });
    }));
    mockAnvilCall.mockRejectedValue(new Error("execution reverted"));

    const { result } = renderHook(() => useVaultActions(vaultAddress, tokenAddress, 18));

    await act(async () => {
      await result.current.deposit("100", { batchApproval: parseUnits("100", 18) });
    });

    expect(mockSendTx).not.toHaveBeenCalled();
    expect(mockSendBatch).not.toHaveBeenCalled();
    expect(result.current.error).toBe("Transaction would fail: simulation_reverted");
    expect(result.current.status).toBe("error");
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

  it("keeps the deposit pending when an earlier approval receipt remains successful", async () => {
    approvalHashState.current = "0xapproval";
    mockUseWaitForTransactionReceipt.mockImplementation((options) => ({
      isLoading: Boolean(options?.hash) && options?.hash !== "0xapproval",
      isSuccess: options?.hash === "0xapproval",
      data: undefined,
    } as unknown as ReturnType<typeof useWaitForTransactionReceipt>));
    mockUsePublicClient.mockReturnValue({
      simulateContract: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof usePublicClient>);

    const { result } = renderHook(() => useVaultActions(vaultAddress, tokenAddress, 18));
    await act(async () => {
      await result.current.deposit("100");
    });

    expect(result.current.status).toBe("waitingTx");
    expect(mockSendTx).toHaveBeenCalledTimes(1);
  });

  it("previews after approval and sends only after confirmation", async () => {
    approvalHashState.current = "0xapproval";
    mockUseWaitForTransactionReceipt.mockImplementation((options) => ({
      isLoading: Boolean(options?.hash) && options?.hash !== "0xapproval",
      isSuccess: options?.hash === "0xapproval",
      data: undefined,
    } as unknown as ReturnType<typeof useWaitForTransactionReceipt>));

    const { result } = renderHook(() => useVaultActions(vaultAddress, tokenAddress, 18));
    await act(async () => {
      await result.current.deposit("100", { previewOnly: true });
    });
    expect(result.current.simulationResult).toMatchObject({ simulationUnavailable: true });
    expect(mockSendTx).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.executeAfterPreview();
    });
    expect(mockSendTx).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("waitingTx");
  });

  it("does not send a previewed deposit when the amount has changed", async () => {
    const { result } = renderHook(() => useVaultActions(vaultAddress, tokenAddress, 18));

    await act(async () => {
      await result.current.deposit("1000", { previewOnly: true });
    });

    let sent = true;
    await act(async () => {
      sent = await result.current.executeAfterPreview({ type: "deposit", amount: "100" });
    });

    expect(sent).toBe(false);
    expect(mockSendTx).not.toHaveBeenCalled();
  });

  it("sends the previewed deposit when the amount matches", async () => {
    const { result } = renderHook(() => useVaultActions(vaultAddress, tokenAddress, 18));

    await act(async () => {
      await result.current.deposit("1000", { previewOnly: true });
    });

    let sent = false;
    await act(async () => {
      sent = await result.current.executeAfterPreview({ type: "deposit", amount: "1000" });
    });

    expect(sent).toBe(true);
    expect(mockSendTx).toHaveBeenCalledTimes(1);
    expect(mockSendTx).toHaveBeenCalledWith(expect.objectContaining({ to: vaultAddress }));
  });

  it("treats equal amounts with different text as a match", async () => {
    const { result } = renderHook(() => useVaultActions(vaultAddress, tokenAddress, 18));

    await act(async () => {
      await result.current.deposit("1.5", { previewOnly: true });
    });

    let sent = false;
    await act(async () => {
      sent = await result.current.executeAfterPreview({ type: "deposit", amount: "1.50" });
    });

    expect(sent).toBe(true);
    expect(mockSendTx).toHaveBeenCalledTimes(1);
  });

  it("does not send a previewed deposit as a withdrawal", async () => {
    const { result } = renderHook(() => useVaultActions(vaultAddress, tokenAddress, 18));

    await act(async () => {
      await result.current.deposit("100", { previewOnly: true });
    });

    let sent = true;
    await act(async () => {
      sent = await result.current.executeAfterPreview({ type: "withdraw", amount: "100" });
    });

    expect(sent).toBe(false);
    expect(mockSendTx).not.toHaveBeenCalled();
  });

  it("isPreviewFor is false before any preview and after reset", async () => {
    const { result } = renderHook(() => useVaultActions(vaultAddress, tokenAddress, 18));

    expect(result.current.isPreviewFor("deposit", "100")).toBe(false);

    await act(async () => {
      await result.current.deposit("100", { previewOnly: true });
    });
    expect(result.current.isPreviewFor("deposit", "100")).toBe(true);

    await act(async () => {
      result.current.reset();
    });
    expect(result.current.isPreviewFor("deposit", "100")).toBe(false);
  });

  it("a sent deposit shows waitingTx even when an earlier approval errored", async () => {
    approvalErrorState.current = new Error("User rejected the request");
    mockUseWaitForTransactionReceipt.mockImplementation((options) => ({
      isLoading: Boolean(options?.hash),
      isSuccess: false,
      data: undefined,
    } as unknown as ReturnType<typeof useWaitForTransactionReceipt>));
    mockUsePublicClient.mockReturnValue({
      simulateContract: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof usePublicClient>);

    const { result } = renderHook(() => useVaultActions(vaultAddress, tokenAddress, 18));
    expect(result.current.status).toBe("error");

    await act(async () => {
      await result.current.deposit("100");
    });

    expect(mockSendTx).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("waitingTx");
    expect(result.current.isLoading).toBe(true);
  });

  it("starting a deposit resets an errored approval", async () => {
    approvalErrorState.current = new Error("User rejected the request");
    mockUseWaitForTransactionReceipt.mockImplementation((options) => ({
      isLoading: Boolean(options?.hash),
      isSuccess: false,
      data: undefined,
    } as unknown as ReturnType<typeof useWaitForTransactionReceipt>));
    mockUsePublicClient.mockReturnValue({
      simulateContract: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof usePublicClient>);

    const { result } = renderHook(() => useVaultActions(vaultAddress, tokenAddress, 18));
    await act(async () => {
      await result.current.deposit("100");
    });

    expect(mockResetApprove).toHaveBeenCalled();
  });

  it("shows a pending deposit while its send is unresolved after an approval error", async () => {
    approvalErrorState.current = new Error("User rejected the request");
    mockUseWaitForTransactionReceipt.mockImplementation((options) => ({
      isLoading: Boolean(options?.hash),
      isSuccess: false,
      data: undefined,
    } as unknown as ReturnType<typeof useWaitForTransactionReceipt>));
    mockUsePublicClient.mockReturnValue({
      simulateContract: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof usePublicClient>);

    let resolveSend!: (hash: `0x${string}`) => void;
    mockSendTx.mockReturnValue(new Promise<`0x${string}`>((resolve) => {
      resolveSend = resolve;
    }));

    const { result } = renderHook(() => useVaultActions(vaultAddress, tokenAddress, 18));
    expect(result.current.status).toBe("error");

    let depositPromise!: Promise<unknown>;
    await act(async () => {
      depositPromise = result.current.deposit("100");
      await vi.waitFor(() => expect(mockSendTx).toHaveBeenCalledTimes(1));
    });

    // The send has not resolved yet: the deposit is already live.
    expect(result.current.status).toBe("depositing");
    expect(result.current.isLoading).toBe(true);
    expect(mockSendTx).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSend("0xdeposit");
      await depositPromise;
    });
  });

  it("shows a pending deposit while its send is unresolved after a reverted approval", async () => {
    approvalHashState.current = "0xapproval";
    mockUseWaitForTransactionReceipt.mockImplementation((options) => ({
      isLoading: Boolean(options?.hash) && options?.hash !== "0xapproval",
      isSuccess: false,
      data: options?.hash === "0xapproval" ? { status: "reverted" } : undefined,
    } as unknown as ReturnType<typeof useWaitForTransactionReceipt>));
    mockUsePublicClient.mockReturnValue({
      simulateContract: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof usePublicClient>);

    let resolveSend!: (hash: `0x${string}`) => void;
    mockSendTx.mockReturnValue(new Promise<`0x${string}`>((resolve) => {
      resolveSend = resolve;
    }));

    const { result } = renderHook(() => useVaultActions(vaultAddress, tokenAddress, 18));
    expect(result.current.status).toBe("reverted");

    let depositPromise!: Promise<unknown>;
    await act(async () => {
      depositPromise = result.current.deposit("100");
      await vi.waitFor(() => expect(mockSendTx).toHaveBeenCalledTimes(1));
    });

    expect(mockResetApprove).toHaveBeenCalled();
    expect(result.current.status).not.toBe("reverted");
    expect(result.current.status).toBe("depositing");
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolveSend("0xdeposit");
      await depositPromise;
    });
  });

  it("confirming a preview after an approval error shows waitingTx", async () => {
    approvalErrorState.current = new Error("User rejected the request");
    mockUseWaitForTransactionReceipt.mockImplementation((options) => ({
      isLoading: Boolean(options?.hash),
      isSuccess: false,
      data: undefined,
    } as unknown as ReturnType<typeof useWaitForTransactionReceipt>));
    mockUsePublicClient.mockReturnValue({
      simulateContract: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof usePublicClient>);

    const { result } = renderHook(() => useVaultActions(vaultAddress, tokenAddress, 18));
    await act(async () => {
      await result.current.deposit("100", { previewOnly: true });
    });

    await act(async () => {
      await result.current.executeAfterPreview();
    });

    expect(mockSendTx).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("waitingTx");
  });

  it("does not reset a confirmed approval when a deposit starts", async () => {
    approvalHashState.current = "0xapproval";
    mockUseWaitForTransactionReceipt.mockImplementation((options) => ({
      isLoading: Boolean(options?.hash) && options?.hash !== "0xapproval",
      isSuccess: options?.hash === "0xapproval",
      data: undefined,
    } as unknown as ReturnType<typeof useWaitForTransactionReceipt>));
    mockUsePublicClient.mockReturnValue({
      simulateContract: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof usePublicClient>);

    const { result } = renderHook(() => useVaultActions(vaultAddress, tokenAddress, 18));
    await act(async () => {
      await result.current.deposit("100");
    });

    expect(mockResetApprove).not.toHaveBeenCalled();
  });

  it("does not reset a confirmed approval when a pending deposit starts", async () => {
    approvalHashState.current = "0xapproval";
    mockUseWaitForTransactionReceipt.mockImplementation((options) => ({
      isLoading: Boolean(options?.hash) && options?.hash !== "0xapproval",
      isSuccess: options?.hash === "0xapproval",
      data: undefined,
    } as unknown as ReturnType<typeof useWaitForTransactionReceipt>));
    mockUsePublicClient.mockReturnValue({
      simulateContract: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof usePublicClient>);

    let resolveSend!: (hash: `0x${string}`) => void;
    mockSendTx.mockReturnValue(new Promise<`0x${string}`>((resolve) => {
      resolveSend = resolve;
    }));

    const { result } = renderHook(() => useVaultActions(vaultAddress, tokenAddress, 18));

    let depositPromise!: Promise<unknown>;
    await act(async () => {
      depositPromise = result.current.deposit("100");
      await vi.waitFor(() => expect(mockSendTx).toHaveBeenCalledTimes(1));
    });

    expect(mockResetApprove).not.toHaveBeenCalled();
    expect(result.current.status).toBe("depositing");
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolveSend("0xdeposit");
      await depositPromise;
    });
  });

  it("a withdrawal that was sent shows waitingTx after an approval error", async () => {
    approvalErrorState.current = new Error("User rejected the request");
    mockUseWaitForTransactionReceipt.mockImplementation((options) => ({
      isLoading: Boolean(options?.hash),
      isSuccess: false,
      data: undefined,
    } as unknown as ReturnType<typeof useWaitForTransactionReceipt>));
    mockUsePublicClient.mockReturnValue({
      simulateContract: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof usePublicClient>);

    const { result } = renderHook(() => useVaultActions(vaultAddress, tokenAddress, 18));

    await act(async () => {
      await result.current.withdraw("100");
    });

    expect(mockSendTx).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("waitingTx");
  });

  it("binds the nonce to the request it sends", async () => {
    const { result } = renderHook(() => useVaultActions(vaultAddress, tokenAddress, 18));

    await act(async () => {
      await result.current.deposit("100", { previewOnly: true });
    });

    const calls = vi.mocked(fetch).mock.calls;
    const nonceUrl = calls
      .map(([url]) => String(url))
      .find((url) => url.includes("/api/simulate/nonce"));
    expect(nonceUrl).toBeDefined();
    const bind = new URL(nonceUrl as string, "http://localhost:3000").searchParams.get("bind");

    const simulateCall = calls.find(([url]) => String(url) === "/api/simulate");
    expect(simulateCall).toBeDefined();
    const body = JSON.parse(String(simulateCall![1]?.body)) as {
      from: string;
      to: string;
      data: string;
      value?: string;
    };

    expect(bind).toBe(simulationNonceBinding({
      from: body.from,
      to: body.to,
      data: body.data,
      value: body.value,
    }));
  });
});
