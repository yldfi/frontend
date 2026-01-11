import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useAccount,
  useWriteContract,
  useReadContract,
  useSendTransaction,
  useWaitForTransactionReceipt,
  usePublicClient,
} from "wagmi";
import { useZapActions } from "@/hooks/useZapActions";
import type { ZapQuote, EnsoToken } from "@/types/enso";

// Get mocked functions
const mockUseAccount = vi.mocked(useAccount);
const mockUseWriteContract = vi.mocked(useWriteContract);
const mockUseReadContract = vi.mocked(useReadContract);
const mockUseSendTransaction = vi.mocked(useSendTransaction);
const mockUseWaitForTransactionReceipt = vi.mocked(useWaitForTransactionReceipt);
const mockUsePublicClient = vi.mocked(usePublicClient);

describe("useZapActions integration", () => {
  const USER_ADDRESS = "0x1234567890123456789012345678901234567890" as `0x${string}`;
  const VAULT_ADDRESS = "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86";

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
      data: "0x...",
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
      data: "0xabcdef...",
      value: "0",
    },
    route: [],
  };

  const mockWriteContract = vi.fn();
  const mockResetApprove = vi.fn();
  const mockSendTransaction = vi.fn();
  const mockResetZap = vi.fn();
  const mockRefetchAllowance = vi.fn();
  const mockPublicClientCall = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock fetch for simulation API calls
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/simulate/nonce")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            nonce: "test-nonce",
            expires: Date.now() + 60000,
            sig: "test-sig",
          }),
        });
      }
      if (url.includes("/api/simulate")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    }));

    mockUseAccount.mockReturnValue({
      address: USER_ADDRESS,
      isConnected: true,
    } as ReturnType<typeof useAccount>);

    mockUseWriteContract.mockReturnValue({
      writeContract: mockWriteContract,
      data: undefined,
      reset: mockResetApprove,
      error: null,
    } as unknown as ReturnType<typeof useWriteContract>);

    mockUseSendTransaction.mockReturnValue({
      sendTransaction: mockSendTransaction,
      data: undefined,
      reset: mockResetZap,
      error: null,
    } as unknown as ReturnType<typeof useSendTransaction>);

    mockUseReadContract.mockReturnValue({
      data: undefined,
      refetch: mockRefetchAllowance,
    } as unknown as ReturnType<typeof useReadContract>);

    mockUseWaitForTransactionReceipt.mockReturnValue({
      isLoading: false,
      isSuccess: false,
    } as unknown as ReturnType<typeof useWaitForTransactionReceipt>);

    // Mock usePublicClient with call method for eth_call simulation
    mockUsePublicClient.mockReturnValue({
      call: mockPublicClientCall.mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof usePublicClient>);
  });

  describe("ETH zaps (no approval needed)", () => {
    it("returns needsApproval false for ETH input", () => {
      const { result } = renderHook(() => useZapActions(mockEthQuote));

      expect(result.current.needsApproval()).toBe(false);
    });

    it("executes zap immediately for ETH", async () => {
      const { result } = renderHook(() => useZapActions(mockEthQuote));

      await act(async () => {
        await result.current.executeZap();
      });

      expect(mockSendTransaction).toHaveBeenCalledWith({
        to: mockEthQuote.tx.to,
        data: mockEthQuote.tx.data,
        value: BigInt(mockEthQuote.tx.value || "0"),
      });
    });

    it("shows zapping status after executeZap", async () => {
      const { result } = renderHook(() => useZapActions(mockEthQuote));

      await act(async () => {
        await result.current.executeZap();
      });

      // After successful simulation, status transitions to zapping
      expect(result.current.status).toBe("zapping");
      expect(result.current.isLoading).toBe(true);
    });
  });

  describe("ERC20 zaps (approval may be needed)", () => {
    it("returns needsApproval true when allowance is zero", () => {
      mockUseReadContract.mockReturnValue({
        data: BigInt(0),
        refetch: mockRefetchAllowance,
      } as unknown as ReturnType<typeof useReadContract>);

      const { result } = renderHook(() => useZapActions(mockUsdcQuote));

      expect(result.current.needsApproval()).toBe(true);
    });

    it("returns needsApproval false when allowance is sufficient", () => {
      // 1000 USDC = 1000 * 10^6 = 1000000000
      mockUseReadContract.mockReturnValue({
        data: BigInt("1000000000000"), // More than enough
        refetch: mockRefetchAllowance,
      } as unknown as ReturnType<typeof useReadContract>);

      const { result } = renderHook(() => useZapActions(mockUsdcQuote));

      expect(result.current.needsApproval()).toBe(false);
    });

    it("returns needsApproval true when allowance is insufficient", () => {
      // 1000 USDC = 1000000000 (10^6 decimals)
      mockUseReadContract.mockReturnValue({
        data: BigInt("500000000"), // 500 USDC - not enough
        refetch: mockRefetchAllowance,
      } as unknown as ReturnType<typeof useReadContract>);

      const { result } = renderHook(() => useZapActions(mockUsdcQuote));

      expect(result.current.needsApproval()).toBe(true);
    });

    it("calls writeContract when approve is called", () => {
      mockUseReadContract.mockReturnValue({
        data: BigInt(0),
        refetch: mockRefetchAllowance,
      } as unknown as ReturnType<typeof useReadContract>);

      const { result } = renderHook(() => useZapActions(mockUsdcQuote));

      act(() => {
        result.current.approve();
      });

      expect(mockWriteContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: mockUsdcToken.address,
          functionName: "approve",
        })
      );
    });

    it("shows approving status after approve", () => {
      mockUseReadContract.mockReturnValue({
        data: BigInt(0),
        refetch: mockRefetchAllowance,
      } as unknown as ReturnType<typeof useReadContract>);

      const { result } = renderHook(() => useZapActions(mockUsdcQuote));

      act(() => {
        result.current.approve();
      });

      expect(result.current.status).toBe("approving");
    });
  });

  describe("transaction states", () => {
    it("shows waitingApproval when approval is pending", () => {
      mockUseWaitForTransactionReceipt.mockReturnValue({
        isLoading: true,
        isSuccess: false,
      } as unknown as ReturnType<typeof useWaitForTransactionReceipt>);

      mockUseWriteContract.mockReturnValue({
        writeContract: mockWriteContract,
        data: "0xapprovehash" as `0x${string}`,
        reset: mockResetApprove,
        error: null,
      } as unknown as ReturnType<typeof useWriteContract>);

      const { result } = renderHook(() => useZapActions(mockUsdcQuote));

      expect(result.current.status).toBe("waitingApproval");
      expect(result.current.isLoading).toBe(true);
    });

    it("shows waitingTx when zap tx is pending", () => {
      const zapHash = "0xzaphash" as `0x${string}`;

      // Mock to return loading for zap hash, not for approval (undefined hash)
      mockUseWaitForTransactionReceipt.mockImplementation((params) => {
        if (params?.hash === zapHash) {
          return {
            isLoading: true,
            isSuccess: false,
          } as unknown as ReturnType<typeof useWaitForTransactionReceipt>;
        }
        return {
          isLoading: false,
          isSuccess: false,
        } as unknown as ReturnType<typeof useWaitForTransactionReceipt>;
      });

      mockUseSendTransaction.mockReturnValue({
        sendTransaction: mockSendTransaction,
        data: zapHash,
        reset: mockResetZap,
        error: null,
      } as unknown as ReturnType<typeof useSendTransaction>);

      const { result } = renderHook(() => useZapActions(mockEthQuote));

      expect(result.current.status).toBe("waitingTx");
    });

    it("shows success when zap tx succeeds", () => {
      mockUseWaitForTransactionReceipt.mockReturnValue({
        isLoading: false,
        isSuccess: true,
      } as unknown as ReturnType<typeof useWaitForTransactionReceipt>);

      mockUseSendTransaction.mockReturnValue({
        sendTransaction: mockSendTransaction,
        data: "0xzaphash" as `0x${string}`,
        reset: mockResetZap,
        error: null,
      } as unknown as ReturnType<typeof useSendTransaction>);

      const { result } = renderHook(() => useZapActions(mockEthQuote));

      expect(result.current.status).toBe("success");
      expect(result.current.isSuccess).toBe(true);
    });

    it("returns zapHash when transaction is sent", () => {
      const zapHash = "0xabcdef1234567890" as `0x${string}`;

      mockUseSendTransaction.mockReturnValue({
        sendTransaction: mockSendTransaction,
        data: zapHash,
        reset: mockResetZap,
        error: null,
      } as unknown as ReturnType<typeof useSendTransaction>);

      const { result } = renderHook(() => useZapActions(mockEthQuote));

      expect(result.current.zapHash).toBe(zapHash);
    });
  });

  describe("error handling", () => {
    it("shows error status when approval fails", () => {
      const approvalError = new Error("User rejected the request");

      mockUseWriteContract.mockReturnValue({
        writeContract: mockWriteContract,
        data: undefined,
        reset: mockResetApprove,
        error: approvalError,
      } as unknown as ReturnType<typeof useWriteContract>);

      const { result } = renderHook(() => useZapActions(mockUsdcQuote));

      expect(result.current.status).toBe("error");
      expect(result.current.error).toBe("Transaction cancelled");
    });

    it("shows error status when zap fails", () => {
      const zapError = new Error("Insufficient funds");

      mockUseSendTransaction.mockReturnValue({
        sendTransaction: mockSendTransaction,
        data: undefined,
        reset: mockResetZap,
        error: zapError,
      } as unknown as ReturnType<typeof useSendTransaction>);

      const { result } = renderHook(() => useZapActions(mockEthQuote));

      expect(result.current.status).toBe("error");
      expect(result.current.error).toBe("Insufficient funds");
    });

    it("parses user rejected error message", () => {
      const zapError = new Error("User rejected transaction");

      mockUseSendTransaction.mockReturnValue({
        sendTransaction: mockSendTransaction,
        data: undefined,
        reset: mockResetZap,
        error: zapError,
      } as unknown as ReturnType<typeof useSendTransaction>);

      const { result } = renderHook(() => useZapActions(mockEthQuote));

      expect(result.current.error).toBe("Transaction cancelled");
    });
  });

  describe("reset functionality", () => {
    it("resets all state when reset is called", () => {
      const { result } = renderHook(() => useZapActions(mockEthQuote));

      act(() => {
        result.current.reset();
      });

      expect(mockResetApprove).toHaveBeenCalled();
      expect(mockResetZap).toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    it("returns idle status when quote is null", () => {
      const { result } = renderHook(() => useZapActions(null));

      expect(result.current.status).toBe("idle");
      expect(result.current.needsApproval()).toBe(false);
    });

    it("returns idle status when quote is undefined", () => {
      const { result } = renderHook(() => useZapActions(undefined));

      expect(result.current.status).toBe("idle");
    });

    it("does not execute zap when user is not connected", async () => {
      mockUseAccount.mockReturnValue({
        address: undefined,
        isConnected: false,
      } as ReturnType<typeof useAccount>);

      const { result } = renderHook(() => useZapActions(mockEthQuote));

      await act(async () => {
        await result.current.executeZap();
      });

      expect(mockSendTransaction).not.toHaveBeenCalled();
    });

    it("does not approve when token is ETH", () => {
      const { result } = renderHook(() => useZapActions(mockEthQuote));

      act(() => {
        result.current.approve();
      });

      expect(mockWriteContract).not.toHaveBeenCalled();
    });

    it("handles vault shares as input (zap out)", () => {
      const vaultSharesQuote: ZapQuote = {
        inputToken: {
          address: VAULT_ADDRESS,
          symbol: "Vault Shares",
          name: "Vault Shares",
          decimals: 18,
          chainId: 1,
          type: "defi",
        } as EnsoToken,
        inputAmount: "1000",
        outputAmount: "900000000000000000",
        outputAmountFormatted: "0.9",
        exchangeRate: 0.0009,
        inputUsdValue: 930,
        outputUsdValue: 920,
        priceImpact: 1.08,
        gasEstimate: "250000",
        tx: {
          to: "0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E",
          data: "0x...",
          value: "0",
        },
        route: [],
      };

      mockUseReadContract.mockReturnValue({
        data: BigInt(0),
        refetch: mockRefetchAllowance,
      } as unknown as ReturnType<typeof useReadContract>);

      const { result } = renderHook(() => useZapActions(vaultSharesQuote));

      // Vault shares are ERC20, so approval may be needed
      expect(result.current.needsApproval()).toBe(true);
    });

    it("handles zero value tx", async () => {
      const zeroValueQuote = {
        ...mockUsdcQuote,
        tx: { ...mockUsdcQuote.tx, value: "0" },
      };

      mockUseReadContract.mockReturnValue({
        data: BigInt("1000000000000"),
        refetch: mockRefetchAllowance,
      } as unknown as ReturnType<typeof useReadContract>);

      const { result } = renderHook(() => useZapActions(zeroValueQuote));

      await act(async () => {
        await result.current.executeZap();
      });

      expect(mockSendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          value: BigInt(0),
        })
      );
    });

    it("handles undefined tx value", async () => {
      const undefinedValueQuote = {
        ...mockUsdcQuote,
        tx: { to: mockUsdcQuote.tx.to, data: mockUsdcQuote.tx.data, value: "" },
      };

      mockUseReadContract.mockReturnValue({
        data: BigInt("1000000000000"),
        refetch: mockRefetchAllowance,
      } as unknown as ReturnType<typeof useReadContract>);

      const { result } = renderHook(() => useZapActions(undefinedValueQuote));

      await act(async () => {
        await result.current.executeZap();
      });

      expect(mockSendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          value: BigInt(0),
        })
      );
    });
  });

  describe("allowance refetch", () => {
    it("exposes refetchAllowance function", () => {
      const { result } = renderHook(() => useZapActions(mockUsdcQuote));

      expect(result.current.refetchAllowance).toBe(mockRefetchAllowance);
    });
  });
});
