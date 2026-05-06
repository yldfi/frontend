import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { maxUint256 } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWaitForTransactionReceipt,
} from "wagmi";

import { useZapActions } from "@/hooks/useZapActions";
import { ENSO_ROUTER_EXECUTOR } from "@/lib/enso";
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

    mockUsePublicClient.mockReturnValue({} as ReturnType<typeof usePublicClient>);

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

  it("checks ERC20 allowance against Enso router executor instead of quote tx target", () => {
    renderHook(() => useZapActions(mockUsdcQuote));

    expect(mockUseReadContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "allowance",
        args: [userAddress, ENSO_ROUTER_EXECUTOR],
      })
    );
    expect(mockUsdcQuote.tx.to).not.toBe(ENSO_ROUTER_EXECUTOR);
  });

  it("approves the Enso router executor spender instead of quote tx target", () => {
    mockUseReadContract.mockReturnValue({
      data: BigInt(0),
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useReadContract>);

    const { result } = renderHook(() => useZapActions(mockUsdcQuote));

    act(() => {
      result.current.approve(false);
    });

    expect(mockWriteApprove).toHaveBeenCalledWith(
      expect.objectContaining({
        address: mockUsdcToken.address,
        functionName: "approve",
        args: [ENSO_ROUTER_EXECUTOR, maxUint256],
      })
    );
  });

  it("shows pending approval for the Enso router executor spender", async () => {
    mockUseReadContract.mockReturnValue({
      data: BigInt(0),
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useReadContract>);

    const { result } = renderHook(() => useZapActions(mockUsdcQuote));

    await act(async () => {
      await result.current.executeZap();
    });

    expect(result.current.pendingApproval).toMatchObject({
      spender: ENSO_ROUTER_EXECUTOR,
      spenderName: "Enso Router",
    });
    expect(result.current.approvalProgress?.steps[0]).toMatchObject({
      spender: ENSO_ROUTER_EXECUTOR,
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
});
