import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { maxUint256 } from "viem";
import type { ReplacementReturnType } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWalletClient,
  useWaitForTransactionReceipt,
} from "wagmi";

import { useZapActions } from "@/hooks/useZapActions";
import { useDirectWriteContract } from "@/hooks/useDirectWriteContract";
import {
  ENSO_ROUTER_V2,
  LEGACY_MORPHO_ADDRESS,
  MORPHO_BUNDLER3_ADDRESS,
  MORPHO_GENERAL_ADAPTER1_ADDRESS,
} from "@/lib/enso";
import { TOKENS, VAULTS } from "@/config/vaults";
import { buildApprovalSimulationTransaction } from "@/lib/tenderly-simulation-bundle";
import type { EnsoToken, ZapQuote } from "@/types/enso";

const {
  mockAnvilCall,
  mockSendTx,
  mockToggleFlashbots,
  mockWriteApprove,
  mockResetApprove,
} = vi.hoisted(() => ({
  mockAnvilCall: vi.fn(),
  mockSendTx: vi.fn(),
  mockToggleFlashbots: vi.fn(),
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

vi.mock("@/hooks/useFlashbotsProtect", () => ({
  useFlashbotsProtect: vi.fn(() => ({
    isFlashbotsEnabled: false,
    isFlashbotsSupported: false,
    toggleFlashbots: mockToggleFlashbots,
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
const mockUseWalletClient = vi.mocked(useWalletClient);
const mockUseWaitForTransactionReceipt = vi.mocked(useWaitForTransactionReceipt);

describe("useZapActions preview fallback", () => {
  const userAddress = "0x1234567890123456789012345678901234567890" as `0x${string}`;

  const mockEthToken: EnsoToken = {
    address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    chainId: 1,
    name: "Ethereum",
    symbol: "ETH",
    decimals: 18,
    type: "base",
  };

  const mockUsdcToken: EnsoToken = {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    chainId: 1,
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
    type: "base",
  };

  const mockLegacyMorphoToken: EnsoToken = {
    address: LEGACY_MORPHO_ADDRESS,
    chainId: 1,
    name: "Morpho Legacy",
    symbol: "MORPHO Legacy",
    decimals: 18,
    type: "base",
  };

  const mockEthQuote: ZapQuote = {
    inputToken: mockEthToken,
    inputAmount: "1",
    outputAmount: "1050000000000000000000",
    outputAmountFormatted: "1050",
    exchangeRate: 1050,
    inputUsdValue: 2000,
    outputUsdValue: 1995,
    priceImpact: 0.25,
    gasEstimate: "200000",
    tx: {
      to: "0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E",
      data: "0xabcdef",
      value: "1000000000000000000",
    },
    route: [],
  };

  const mockUsdcQuote: ZapQuote = {
    inputToken: mockUsdcToken,
    inputAmount: "1000",
    outputAmount: "1100000000000000000000",
    outputAmountFormatted: "1100",
    exchangeRate: 1.1,
    inputUsdValue: 1000,
    outputUsdValue: 990,
    priceImpact: 1.0,
    gasEstimate: "300000",
    tx: {
      to: "0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E",
      data: "0xabcdef",
      value: "0",
    },
    route: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();

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
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: false,
            gasUsed: null,
            errorMessage: "Simulation unavailable for this transaction type",
            simulationId: null,
            tenderlyUrl: null,
            assetChanges: [],
          }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    }));

    mockUseAccount.mockReturnValue({
      address: userAddress,
      chainId: 1,
      isConnected: true,
    } as unknown as ReturnType<typeof useAccount>);

    mockUsePublicClient.mockReturnValue({
      getBlockNumber: vi.fn().mockResolvedValue(25967620n),
      readContract: vi.fn(async () => mockUseReadContract().data ?? 0n),
    } as unknown as ReturnType<typeof usePublicClient>);

    mockUseWalletClient.mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useWalletClient>);

    mockUseReadContract.mockReturnValue({
      data: undefined,
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

  it("checks ERC20 allowance against Enso Router V2 instead of quote tx target", () => {
    renderHook(() => useZapActions(mockUsdcQuote));

    expect(mockUseReadContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "allowance",
        args: [userAddress, ENSO_ROUTER_V2],
      })
    );
    expect(mockUsdcQuote.tx.to).not.toBe(ENSO_ROUTER_V2);
  });

  it("approves the Enso Router V2 spender instead of quote tx target", async () => {
    mockUseReadContract.mockReturnValue({
      data: BigInt(0),
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useReadContract>);

    const { result } = renderHook(() => useZapActions(mockUsdcQuote));

    await act(async () => {
      await result.current.approve(false);
    });

    expect(mockWriteApprove).toHaveBeenCalledWith(
      expect.objectContaining({
        address: mockUsdcToken.address,
        functionName: "approve",
        args: [ENSO_ROUTER_V2, maxUint256],
      })
    );
  });

  it("replays the CRV zero-reset sequence before the zap simulation", async () => {
    const mockCrvToken: EnsoToken = {
      address: "0xD533a949740bb3306d119CC777fa900bA034cd52",
      chainId: 1,
      name: "Curve DAO Token",
      symbol: "CRV",
      decimals: 18,
      type: "base",
    };
    const mockCrvQuote: ZapQuote = {
      ...mockUsdcQuote,
      inputToken: mockCrvToken,
      inputAmount: "140.266541374971961815",
    };
    let currentAllowance = 92_838_401_930_596_493_924n;
    mockUseReadContract.mockImplementation(() => ({
      data: currentAllowance,
      refetch: vi.fn(),
    }) as unknown as ReturnType<typeof useReadContract>);
    const simulateBodyRef: { current?: Record<string, unknown> } = {};
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
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
      simulateBodyRef.current = JSON.parse(String(init?.body));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          gasUsed: "12345",
          simulationId: "sim-id",
          tenderlyUrl: null,
          assetChanges: [],
          errorMessage: null,
        }),
      });
    }));

    const { result, rerender } = renderHook(() => useZapActions(mockCrvQuote));

    await act(async () => {
      await result.current.approve(true);
    });

    expect(mockWriteApprove).toHaveBeenCalledWith(
      expect.objectContaining({
        address: mockCrvToken.address,
        functionName: "approve",
        args: [ENSO_ROUTER_V2, 0n],
      })
    );

    currentAllowance = maxUint256;
    rerender();
    await act(async () => {
      await result.current.executeZap({ previewOnly: true });
    });

    const approvalAmount = 140_266_541_374_971_961_815n;
    expect(simulateBodyRef.current?.approvalTransactions).toEqual([
      buildApprovalSimulationTransaction(mockCrvToken.address as `0x${string}`, ENSO_ROUTER_V2, 0n),
      buildApprovalSimulationTransaction(mockCrvToken.address as `0x${string}`, ENSO_ROUTER_V2, approvalAmount),
    ]);
  });

  it("shows pending approval for the Enso Router V2 spender", async () => {
    mockUseReadContract.mockReturnValue({
      data: BigInt(0),
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useReadContract>);

    const { result } = renderHook(() => useZapActions(mockUsdcQuote));

    await act(async () => {
      await result.current.executeZap();
    });

    expect(result.current.pendingApproval).toMatchObject({
      spender: ENSO_ROUTER_V2,
      spenderName: "Enso Router",
    });
    expect(result.current.approvalProgress?.steps[0]).toMatchObject({
      spender: ENSO_ROUTER_V2,
    });
  });

  it("returns a simulation-unavailable preview result instead of sending immediately", async () => {
    const { result } = renderHook(() => useZapActions(mockEthQuote));

    let previewResult: unknown = null;
    await act(async () => {
      previewResult = await result.current.executeZap({ previewOnly: true });
    });

    expect(previewResult).toMatchObject({
      success: true,
      simulationUnavailable: true,
      simulationUnavailableReason: "Simulation unavailable for this transaction type",
    });
    expect(result.current.simulationResult).toMatchObject({
      success: true,
      simulationUnavailable: true,
    });
    expect(result.current.status).toBe("idle");
    expect(mockSendTx).not.toHaveBeenCalled();
  });

  it("still sends on confirm after an unavailable preview result", async () => {
    const { result } = renderHook(() => useZapActions(mockEthQuote));

    await act(async () => {
      await result.current.executeZap({ previewOnly: true });
    });

    await act(async () => {
      await result.current.executeZap({ skipSimulation: true });
    });

    expect(mockSendTx).toHaveBeenCalledWith({
      to: mockEthQuote.tx.to,
      data: mockEthQuote.tx.data,
      value: BigInt(mockEthQuote.tx.value),
    });
  });

  it("follows a sped-up zap to its replacement hash and success receipt", async () => {
    const originalHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const replacementHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let onReplaced: ((replacement: ReplacementReturnType) => void) | undefined;

    mockSendTx.mockResolvedValue(originalHash);
    mockUseWaitForTransactionReceipt.mockImplementation((parameters) => {
      if (parameters?.hash === originalHash) {
        onReplaced = parameters.onReplaced;
        return {
          isLoading: true,
          isSuccess: false,
          data: undefined,
        } as unknown as ReturnType<typeof useWaitForTransactionReceipt>;
      }
      if (parameters?.hash === replacementHash) {
        return {
          isLoading: false,
          isSuccess: true,
          data: {
            status: "success",
            transactionHash: replacementHash,
          },
        } as unknown as ReturnType<typeof useWaitForTransactionReceipt>;
      }
      return {
        isLoading: false,
        isSuccess: false,
        data: undefined,
      } as unknown as ReturnType<typeof useWaitForTransactionReceipt>;
    });

    const { result } = renderHook(() => useZapActions(mockEthQuote));
    await act(async () => {
      await result.current.executeZap();
    });

    expect(result.current.zapHash).toBe(originalHash);
    expect(onReplaced).toBeTypeOf("function");
    expect(mockUseWaitForTransactionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        hash: originalHash,
        checkReplacement: true,
        onReplaced: expect.any(Function),
      })
    );

    act(() => {
      onReplaced?.({
        reason: "repriced",
        replacedTransaction: { hash: originalHash },
        transaction: { hash: replacementHash },
        transactionReceipt: { status: "success", transactionHash: replacementHash },
      } as unknown as ReplacementReturnType);
    });

    expect(result.current.zapHash).toBe(replacementHash);
    expect(result.current.status).toBe("success");
    expect(result.current.isSuccess).toBe(true);
  });

  it("uses the mined receipt hash when it differs from the submitted hash", async () => {
    const originalHash = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const minedHash = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    mockSendTx.mockResolvedValue(originalHash);
    mockUseWaitForTransactionReceipt.mockImplementation((parameters) => {
      if (parameters?.hash === originalHash) {
        return {
          isLoading: false,
          isSuccess: true,
          data: {
            status: "success",
            transactionHash: minedHash,
          },
        } as unknown as ReturnType<typeof useWaitForTransactionReceipt>;
      }
      return {
        isLoading: false,
        isSuccess: false,
        data: undefined,
      } as unknown as ReturnType<typeof useWaitForTransactionReceipt>;
    });

    const { result } = renderHook(() => useZapActions(mockEthQuote));
    await act(async () => {
      await result.current.executeZap();
    });

    expect(result.current.zapHash).toBe(minedHash);
    expect(result.current.status).toBe("success");
  });

  it("does not report a cancelled replacement as a successful zap", async () => {
    const originalHash = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const cancellationHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    let onReplaced: ((replacement: ReplacementReturnType) => void) | undefined;

    mockSendTx.mockResolvedValue(originalHash);
    mockUseWaitForTransactionReceipt.mockImplementation((parameters) => {
      if (parameters?.hash === originalHash) {
        onReplaced = parameters.onReplaced;
        return {
          isLoading: true,
          isSuccess: false,
          data: undefined,
        } as unknown as ReturnType<typeof useWaitForTransactionReceipt>;
      }
      if (parameters?.hash === cancellationHash) {
        return {
          isLoading: false,
          isSuccess: true,
          data: {
            status: "success",
            transactionHash: cancellationHash,
          },
        } as unknown as ReturnType<typeof useWaitForTransactionReceipt>;
      }
      return {
        isLoading: false,
        isSuccess: false,
        data: undefined,
      } as unknown as ReturnType<typeof useWaitForTransactionReceipt>;
    });

    const { result } = renderHook(() => useZapActions(mockEthQuote));
    await act(async () => {
      await result.current.executeZap();
    });

    act(() => {
      onReplaced?.({
        reason: "cancelled",
        replacedTransaction: { hash: originalHash },
        transaction: { hash: cancellationHash },
        transactionReceipt: { status: "success", transactionHash: cancellationHash },
      } as unknown as ReplacementReturnType);
    });

    expect(result.current.zapHash).toBe(cancellationHash);
    expect(result.current.status).toBe("error");
    expect(result.current.isSuccess).toBe(false);
    expect(result.current.error).toBe("Zap transaction was cancelled");
  });

  it("does not add setup calls when the allowance already existed", async () => {
    const simulateBodyRef: { current?: Record<string, unknown> } = {};
    // Grant a sufficient allowance so the zap reaches simulation (no approval
    // card short-circuit) for the ERC20 USDC quote.
    mockUseReadContract.mockReturnValue({
      data: maxUint256,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useReadContract>);
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
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
        simulateBodyRef.current = JSON.parse(String(init?.body));
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            gasUsed: "12345",
            simulationId: "sim-id",
            tenderlyUrl: null,
            assetChanges: [],
            errorMessage: null,
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }));

    const { result } = renderHook(() => useZapActions(mockUsdcQuote));

    await act(async () => {
      await result.current.executeZap({ previewOnly: true });
    });

    expect(simulateBodyRef.current?.inputToken).toBe(mockUsdcToken.address);
    expect(simulateBodyRef.current).not.toHaveProperty("approvalTransactions");
  });

  it.each(["USDT", "USDC"])("continues %s approval through preview and send despite stale query data", async (symbol) => {
    vi.useFakeTimers();
    const approvalHash = `0x${"ab".repeat(32)}` as `0x${string}`;
    let receiptState = "idle";
    const currentAllowance = 0n;
    const readContract = vi.fn(async () => receiptState === "mined" ? 10804821n : 0n);
    mockUsePublicClient.mockReturnValue({ getBlockNumber: vi.fn().mockResolvedValue(25967620n), readContract } as unknown as ReturnType<typeof usePublicClient>);
    const refetch = vi.fn().mockResolvedValue({ data: 0n });
    const defaultFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input) === "/api/simulate") {
        return Promise.resolve({ ok: true, json: async () => ({
          success: true, gasUsed: "843900", simulationId: "fixture-success",
          tenderlyUrl: null, assetChanges: [], errorMessage: null,
        }) } as Response);
      }
      return defaultFetch(input, init);
    });
    const writer = vi.mocked(useDirectWriteContract);
    const originalWriter = writer.getMockImplementation()!;
    writer.mockImplementation(() => ({
      ...originalWriter(),
      data: receiptState === "idle" ? undefined : approvalHash,
    }));
    mockUseReadContract.mockImplementation(() => ({ data: currentAllowance, refetch }) as unknown as ReturnType<typeof useReadContract>);
    mockUseWaitForTransactionReceipt.mockImplementation((options) => ({
      isLoading: options?.hash === approvalHash && receiptState === "pending",
      isSuccess: options?.hash === approvalHash && receiptState === "mined",
      data: options?.hash === approvalHash && receiptState === "mined"
        ? { status: "success", transactionHash: approvalHash, blockNumber: 25967619n, gasUsed: 48549n }
        : undefined,
    }) as unknown as ReturnType<typeof useWaitForTransactionReceipt>);
    const quote = { ...mockUsdcQuote, inputAmount: "10.804821", inputToken: {
      ...mockUsdcToken, address: symbol === "USDT" ? "0xdAC17F958D2ee523a2206206994597C13D831ec7" : mockUsdcToken.address, symbol,
    } };
    const hook = renderHook(() => useZapActions(quote));
    try {
      await act(async () => { await hook.result.current.executeZap({ previewOnly: true }); });
      await act(async () => { await hook.result.current.approve(true); });
      receiptState = "pending";
      hook.rerender();
      expect(hook.result.current.status).toBe("waitingApproval");
      receiptState = "mined";
      hook.rerender();
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(readContract).toHaveBeenLastCalledWith(expect.objectContaining({ blockNumber: 25967620n }));
      expect(hook.result.current.simulationResult?.success).toBe(true);
      expect(mockSendTx).not.toHaveBeenCalled();

      await act(async () => { await hook.result.current.executeZap({ skipSimulation: true }); });
      expect(hook.result.current.pendingApproval).toBeNull();
      expect(mockSendTx).toHaveBeenCalledTimes(1);
      expect(readContract).toHaveBeenCalledTimes(3);
      expect(refetch).not.toHaveBeenCalled();
    } finally {
      hook.unmount();
      writer.mockImplementation(originalWriter);
      vi.useRealTimers();
    }
  });

  it.each(["success", "reverted"])("waits for both USDT zero-reset approvals (%s receipt)", async (receiptStatus) => {
    let hash: `0x${string}` | undefined;
    let mined = false;
    const writer = vi.mocked(useDirectWriteContract);
    const originalWriter = writer.getMockImplementation()!;
    writer.mockImplementation(() => ({ ...originalWriter(), data: hash }));
    mockWriteApprove.mockImplementation(() => {
      hash = `0x${String(mockWriteApprove.mock.calls.length).padStart(64, "0")}`;
      mined = false;
    });
    mockResetApprove.mockImplementation(() => { hash = undefined; });
    mockUseReadContract.mockReturnValue({ data: 1n, refetch: vi.fn() } as unknown as ReturnType<typeof useReadContract>);
    const readContract = vi.fn(async () => mockWriteApprove.mock.calls.length === 2 && mined ? 10804821n : 1n);
    mockUsePublicClient.mockReturnValue({ getBlockNumber: vi.fn().mockResolvedValue(25967621n), readContract } as unknown as ReturnType<typeof usePublicClient>);
    mockUseWaitForTransactionReceipt.mockImplementation(options => ({
      isLoading: !!options?.hash && !mined,
      isSuccess: !!options?.hash && mined,
      data: options?.hash && mined ? { status: receiptStatus, transactionHash: options.hash, blockNumber: 25967620n, gasUsed: 50000n } : undefined,
    }) as unknown as ReturnType<typeof useWaitForTransactionReceipt>);
    const quote = { ...mockUsdcQuote, inputAmount: "10.804821", inputToken: { ...mockUsdcToken, address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT" } };
    const hook = renderHook(() => useZapActions(quote));
    try {
      await act(async () => { await hook.result.current.executeZap({ previewOnly: true }); });
      await act(async () => { await hook.result.current.approve(true); });
      expect(mockWriteApprove.mock.calls[0][0].args).toEqual([ENSO_ROUTER_V2, 0n]);
      mined = true;
      await act(async () => { hook.rerender(); });
      expect(fetch).not.toHaveBeenCalled();
      expect(mockSendTx).not.toHaveBeenCalled();
      if (receiptStatus === "reverted") {
        expect(mockWriteApprove).toHaveBeenCalledTimes(1);
        expect(hook.result.current.status).toBe("reverted");
      } else {
        expect(mockWriteApprove.mock.calls[1][0].args).toEqual([ENSO_ROUTER_V2, 10804821n]);
        mined = true;
        await act(async () => { hook.rerender(); });
        expect(hook.result.current.simulationResult?.success).toBe(true);
        expect(readContract).toHaveBeenLastCalledWith(expect.objectContaining({ blockNumber: 25967621n }));
      }
    } finally {
      hook.unmount();
      writer.mockImplementation(originalWriter);
      mockWriteApprove.mockReset();
      mockResetApprove.mockReset();
    }
  });

  it("shows a retryable read error without requesting approval or sending", async () => {
    vi.useFakeTimers();
    const getBlockNumber = vi.fn().mockRejectedValue(new Error("RPC unavailable"));
    mockUsePublicClient.mockReturnValue({ getBlockNumber, readContract: vi.fn() } as unknown as ReturnType<typeof usePublicClient>);
    const hook = renderHook(() => useZapActions(mockUsdcQuote));
    try {
      await act(async () => {
        const execution = hook.result.current.executeZap({ previewOnly: true });
        await vi.advanceTimersByTimeAsync(1_000);
        await execution;
      });
      expect(hook.result.current.status).toBe("error");
      expect(hook.result.current.error).toContain("Unable to verify token approval");
      expect(hook.result.current.pendingApproval).toBeNull();
      expect(mockWriteApprove).not.toHaveBeenCalled();
      expect(mockSendTx).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      getBlockNumber.mockResolvedValue(25967620n);
      mockUsePublicClient.mockReturnValue({ getBlockNumber, readContract: vi.fn().mockResolvedValue(maxUint256) } as unknown as ReturnType<typeof usePublicClient>);
      hook.rerender();
      await act(async () => { await hook.result.current.executeZap({ previewOnly: true }); });
      expect(hook.result.current.simulationResult?.success).toBe(true);
      expect(hook.result.current.error).toBeNull();
    } finally {
      hook.unmount();
      vi.useRealTimers();
    }
  });

  it("clears the approval card when a later allowance query recovers", async () => {
    let allowance = 0n;
    mockUseReadContract.mockImplementation(() => ({ data: allowance, refetch: vi.fn() }) as unknown as ReturnType<typeof useReadContract>);
    const hook = renderHook(() => useZapActions(mockUsdcQuote));
    await act(async () => { await hook.result.current.executeZap(); });
    expect(hook.result.current.status).toBe("needsApproval");
    expect(hook.result.current.pendingApproval).not.toBeNull();
    allowance = maxUint256;
    await act(async () => { hook.rerender(); });
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.pendingApproval).toBeNull();
    expect(hook.result.current.isLoading).toBe(false);
    expect(mockSendTx).not.toHaveBeenCalled();
    hook.unmount();
  });

  it.each(["reset", "input", "wallet", "unmount"])("cancels a delayed allowance continuation on %s", async (change) => {
    let resolveRead!: (value: bigint) => void;
    const readContract = vi.fn(() => new Promise<bigint>(resolve => { resolveRead = resolve; }));
    mockUsePublicClient.mockReturnValue({ getBlockNumber: vi.fn().mockResolvedValue(25967620n), readContract } as unknown as ReturnType<typeof usePublicClient>);
    let quote = mockUsdcQuote;
    const hook = renderHook(() => useZapActions(quote));
    let execution!: ReturnType<typeof hook.result.current.executeZap>;
    await act(async () => { execution = hook.result.current.executeZap(); });
    expect(hook.result.current.status).toBe("checkingApproval");
    await act(async () => {
      if (change === "reset") hook.result.current.reset();
      if (change === "input") { quote = { ...mockUsdcQuote, inputAmount: "2000" }; hook.rerender(); }
      if (change === "wallet") {
        mockUseAccount.mockReturnValue({ address: "0x2222222222222222222222222222222222222222", chainId: 1, isConnected: true } as unknown as ReturnType<typeof useAccount>);
        hook.rerender();
      }
      if (change === "unmount") hook.unmount();
    });
    await act(async () => { resolveRead(maxUint256); await execution; });
    expect(mockSendTx).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    if (change !== "unmount") {
      expect(hook.result.current.isLoading).toBe(false);
      hook.unmount();
    }
  });

  it("replays a just-confirmed approval before the zap simulation", async () => {
    let currentAllowance = 0n;
    const simulateBodyRef: { current?: Record<string, unknown> } = {};
    mockUseReadContract.mockImplementation(() => ({
      data: currentAllowance,
      refetch: vi.fn(),
    }) as unknown as ReturnType<typeof useReadContract>);
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
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
      simulateBodyRef.current = JSON.parse(String(init?.body));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          gasUsed: "12345",
          simulationId: "sim-id",
          tenderlyUrl: null,
          assetChanges: [],
          errorMessage: null,
        }),
      });
    }));

    let activeQuote = mockUsdcQuote;
    const { result, rerender } = renderHook(() => useZapActions(activeQuote));
    await act(async () => {
      await result.current.approve(false);
    });

    currentAllowance = maxUint256;
    // Query libraries may replace the quote object while preserving the same
    // executable token/amount. The prepared approval bundle must survive that.
    activeQuote = { ...mockUsdcQuote };
    rerender();
    await act(async () => {
      await result.current.executeZap({ previewOnly: true });
    });

    expect(simulateBodyRef.current?.approvalTransactions).toEqual([
      buildApprovalSimulationTransaction(mockUsdcToken.address as `0x${string}`, ENSO_ROUTER_V2, maxUint256),
    ]);
  });

  it("does not request an approval override for legacy MORPHO permit zaps", async () => {
    const readContract = vi.fn().mockResolvedValue(7n);
    const signTypedData = vi.fn().mockResolvedValue(
      `0x${"11".repeat(32)}${"22".repeat(32)}1b`
    );
    const simulateBodyRef: { current?: Record<string, unknown> } = {};

    mockUsePublicClient.mockReturnValue({
      readContract,
    } as unknown as ReturnType<typeof usePublicClient>);
    mockUseWalletClient.mockReturnValue({
      data: { signTypedData },
    } as unknown as ReturnType<typeof useWalletClient>);
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
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
        simulateBodyRef.current = JSON.parse(String(init?.body));
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            gasUsed: "12345",
            simulationId: "sim-id",
            tenderlyUrl: null,
            assetChanges: [],
            errorMessage: null,
          }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    }));

    const legacyQuote: ZapQuote = {
      inputToken: mockLegacyMorphoToken,
      inputAmount: "1000",
      outputAmount: "950",
      outputAmountFormatted: "950",
      exchangeRate: 0.95,
      inputUsdValue: 1000,
      outputUsdValue: 950,
      priceImpact: 0,
      gasEstimate: "200000",
      tx: {
        to: MORPHO_BUNDLER3_ADDRESS,
        data: "0x",
        value: "0",
      },
      route: [],
      legacyMorphoPermit: {
        token: LEGACY_MORPHO_ADDRESS,
        spender: MORPHO_GENERAL_ADAPTER1_ADDRESS,
        amount: "1000",
        postPermitCalls: [
          {
            to: MORPHO_GENERAL_ADAPTER1_ADDRESS,
            data: "0x1234",
            value: "0",
            skipRevert: false,
            callbackHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
          },
        ],
      },
    };

    const { result } = renderHook(() => useZapActions(legacyQuote));

    await act(async () => {
      await result.current.executeZap({ previewOnly: true });
    });

    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: LEGACY_MORPHO_ADDRESS,
      functionName: "nonces",
      args: [userAddress],
    }));
    expect(signTypedData).toHaveBeenCalledWith(expect.objectContaining({
      domain: expect.objectContaining({
        name: "Morpho Token",
        version: "1",
        chainId: 1,
        verifyingContract: LEGACY_MORPHO_ADDRESS,
      }),
      message: expect.objectContaining({
        owner: userAddress,
        spender: MORPHO_GENERAL_ADAPTER1_ADDRESS,
        value: 1000n,
        nonce: 7n,
      }),
    }));
    expect(simulateBodyRef.current).toMatchObject({
      from: userAddress,
      to: MORPHO_BUNDLER3_ADDRESS,
      value: "0",
      inputToken: LEGACY_MORPHO_ADDRESS,
    });
    expect(simulateBodyRef.current?.data).not.toBe("0x");
    // Permit flows set allowance inside the transaction, so no setup approval.
    expect(simulateBodyRef.current).not.toHaveProperty("approvalTransactions");
    expect(mockSendTx).not.toHaveBeenCalled();
  });

  const directVaultAddress = VAULTS.yscvx.address as `0x${string}`;
  const mockCvxToken: EnsoToken = {
    address: TOKENS.CVX,
    chainId: 1,
    name: "Convex Token",
    symbol: "CVX",
    decimals: 18,
    type: "base",
  };
  const mockDirectDepositQuote: ZapQuote = {
    inputToken: mockCvxToken,
    inputAmount: "1000",
    outputAmount: "1000000000000000000000",
    outputAmountFormatted: "1000",
    exchangeRate: 1,
    inputUsdValue: 2300,
    outputUsdValue: 2300,
    priceImpact: null,
    gasEstimate: "",
    tx: {
      to: directVaultAddress,
      data: "0xdeposit",
      value: "0",
    },
    route: [],
    routeInfo: {
      steps: [
        { tokenSymbol: "CVX", action: "Deposit", description: "into ysCVX", protocol: "yld" },
        { tokenSymbol: "ysCVX", action: "Receive", description: "ysCVX shares", protocol: "yld" },
      ],
    },
    directVault: {
      vaultAddress: directVaultAddress,
      action: "deposit",
      symbol: "ysCVX",
    },
  };

  it("checks allowance against the vault for a direct vault deposit", () => {
    renderHook(() => useZapActions(mockDirectDepositQuote));

    expect(mockUseReadContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "allowance",
        args: [userAddress, directVaultAddress],
      })
    );
    expect(mockDirectDepositQuote.tx.to).toBe(directVaultAddress);
  });

  it("approves the vault spender for a direct vault deposit", async () => {
    mockUseReadContract.mockReturnValue({
      data: BigInt(0),
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useReadContract>);

    const { result } = renderHook(() => useZapActions(mockDirectDepositQuote));

    await act(async () => {
      await result.current.approve(false);
    });

    expect(mockWriteApprove).toHaveBeenCalledWith(
      expect.objectContaining({
        address: mockCvxToken.address,
        functionName: "approve",
        args: [directVaultAddress, maxUint256],
      })
    );
  });

  it("requires no approval for a direct vault withdrawal", async () => {
    const directWithdrawQuote: ZapQuote = {
      ...mockDirectDepositQuote,
      inputToken: {
        address: directVaultAddress,
        chainId: 1,
        name: "ysCVX",
        symbol: "ysCVX",
        decimals: 18,
        type: "defi",
      },
      tx: { to: directVaultAddress, data: "0xredeem", value: "0" },
      directVault: {
        vaultAddress: directVaultAddress,
        action: "withdraw",
        symbol: "ysCVX",
      },
    };

    const { result } = renderHook(() => useZapActions(directWithdrawQuote));

    expect(result.current.needsApproval()).toBe(false);
  });

  it("passes the direct vault spender in the simulation bundle", async () => {
    let currentAllowance = 0n;
    mockUseReadContract.mockImplementation(() => ({
      data: currentAllowance,
      refetch: vi.fn(),
    }) as unknown as ReturnType<typeof useReadContract>);
    const simulateBodyRef: { current?: Record<string, unknown> } = {};
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
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
      simulateBodyRef.current = JSON.parse(String(init?.body));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          gasUsed: "12345",
          simulationId: "sim-id",
          tenderlyUrl: null,
          assetChanges: [],
          errorMessage: null,
        }),
      });
    }));

    const { result, rerender } = renderHook(() => useZapActions(mockDirectDepositQuote));

    await act(async () => {
      await result.current.approve(true);
    });

    currentAllowance = maxUint256;
    rerender();
    await act(async () => {
      await result.current.executeZap({ previewOnly: true });
    });

    expect(simulateBodyRef.current).toMatchObject({
      inputToken: TOKENS.CVX,
      spender: directVaultAddress,
    });
    expect(simulateBodyRef.current?.approvalTransactions).toEqual([
      buildApprovalSimulationTransaction(mockCvxToken.address as `0x${string}`, directVaultAddress, 1000n * 10n ** 18n),
    ]);
  });
});
