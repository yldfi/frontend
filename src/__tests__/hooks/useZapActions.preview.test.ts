import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { maxUint256 } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWalletClient,
  useWaitForTransactionReceipt,
} from "wagmi";

import { useZapActions } from "@/hooks/useZapActions";
import {
  ENSO_ROUTER_V2,
  LEGACY_MORPHO_ADDRESS,
  MORPHO_BUNDLER3_ADDRESS,
  MORPHO_GENERAL_ADAPTER1_ADDRESS,
} from "@/lib/enso";
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

    mockUsePublicClient.mockReturnValue({} as ReturnType<typeof usePublicClient>);

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

  it("resets CRV approval to zero before increasing an existing allowance", async () => {
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
    mockUseReadContract.mockReturnValue({
      data: 92_838_401_930_596_493_924n,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useReadContract>);

    const { result } = renderHook(() => useZapActions(mockCrvQuote));

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

  it("signs a legacy MORPHO permit and simulates the prepared bundler transaction", async () => {
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
    expect(mockSendTx).not.toHaveBeenCalled();
  });
});
