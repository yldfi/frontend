import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { maxUint256, parseUnits } from "viem";
import { useAccount, usePublicClient, useReadContract, useWaitForTransactionReceipt } from "wagmi";

import { useVaultActions } from "@/hooks/useVaultActions";

const { mockSendTx, approvalHashState, approvalErrorState } = vi.hoisted(() => ({
  mockSendTx: vi.fn(),
  approvalHashState: { current: undefined as `0x${string}` | undefined },
  approvalErrorState: { current: null as Error | null },
}));

vi.mock("@/hooks/useDirectWriteContract", () => ({
  useDirectWriteContract: vi.fn(() => ({
    writeContract: vi.fn(),
    data: approvalHashState.current,
    reset: vi.fn(),
    error: approvalErrorState.current,
  })),
}));

vi.mock("@/contexts/TestNetworkContext", () => ({
  useTestNetwork: vi.fn(() => ({ testNetworkType: null })),
}));

vi.mock("@/hooks/useSendTx", () => ({
  useSendTx: vi.fn(() => ({ sendTx: mockSendTx })),
}));

const VAULT = "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e" as const;
const TOKEN = "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B" as const;
const DEPOSIT_HASH = `0x${"1".repeat(64)}` as const;
const WITHDRAW_HASH = `0x${"2".repeat(64)}` as const;

type ReceiptResult = ReturnType<typeof useWaitForTransactionReceipt>;

function receiptOptions(data?: { status: "success" | "reverted" }) {
  return {
    isLoading: false,
    isSuccess: Boolean(data),
    data,
  } as unknown as ReceiptResult;
}

function renderActions(decimals = 18) {
  return renderHook(() => useVaultActions(VAULT, TOKEN, decimals));
}

function withAllowance(allowance: bigint | undefined) {
  vi.mocked(useReadContract).mockReturnValue({
    data: allowance,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useReadContract>);
}

describe("useVaultActions needsApproval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    approvalHashState.current = undefined;
    approvalErrorState.current = null;

    vi.mocked(useAccount).mockReturnValue({
      address: "0x1234567890123456789012345678901234567890",
      chainId: 1,
      isConnected: true,
    } as unknown as ReturnType<typeof useAccount>);
    vi.mocked(usePublicClient).mockReturnValue({} as ReturnType<typeof usePublicClient>);
    vi.mocked(useWaitForTransactionReceipt).mockReturnValue({
      isLoading: false,
      isSuccess: false,
      data: undefined,
    } as unknown as ReturnType<typeof useWaitForTransactionReceipt>);
    withAllowance(undefined);
  });

  it("asks for approval while the allowance is unknown", () => {
    const { result } = renderActions();

    expect(result.current.needsApproval("100")).toBe(true);
  });

  it("asks for approval for a zero allowance", () => {
    withAllowance(0n);

    const { result } = renderActions();

    expect(result.current.needsApproval("1")).toBe(true);
  });

  it("asks for approval when the allowance is below the amount", () => {
    withAllowance(parseUnits("50", 18));

    const { result } = renderActions();

    expect(result.current.needsApproval("100")).toBe(true);
  });

  it("does not ask for approval when the allowance equals the amount", () => {
    withAllowance(parseUnits("100", 18));

    const { result } = renderActions();

    expect(result.current.needsApproval("100")).toBe(false);
  });

  it("does not ask for approval when the allowance exceeds the amount", () => {
    withAllowance(parseUnits("100", 18));

    const { result } = renderActions();

    expect(result.current.needsApproval("50")).toBe(false);
  });

  it("does not ask for approval against an unlimited allowance", () => {
    withAllowance(maxUint256);

    const { result } = renderActions();

    expect(result.current.needsApproval("1000000000")).toBe(false);
  });

  it("asks for approval for an empty amount", () => {
    withAllowance(parseUnits("100", 18));

    const { result } = renderActions();

    expect(result.current.needsApproval("")).toBe(true);
  });

  it("asks for approval for an amount that cannot be parsed", () => {
    withAllowance(parseUnits("100", 18));

    const { result } = renderActions();

    expect(result.current.needsApproval("invalid")).toBe(true);
  });

  it("compares 6-decimal token amounts against the allowance", () => {
    withAllowance(parseUnits("100", 6));

    const { result } = renderActions(6);

    expect(result.current.needsApproval("50")).toBe(false);
    expect(result.current.needsApproval("150")).toBe(true);
  });

  it("compares 8-decimal token amounts against the allowance", () => {
    withAllowance(parseUnits("1", 8));

    const { result } = renderActions(8);

    expect(result.current.needsApproval("0.5")).toBe(false);
    expect(result.current.needsApproval("2")).toBe(true);
  });
});

describe("useVaultActions status and error derivation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    approvalHashState.current = undefined;
    approvalErrorState.current = null;

    vi.mocked(useAccount).mockReturnValue({
      address: "0x1234567890123456789012345678901234567890",
      chainId: 1,
      isConnected: true,
    } as unknown as ReturnType<typeof useAccount>);
    vi.mocked(usePublicClient).mockReturnValue({} as ReturnType<typeof usePublicClient>);
    withAllowance(maxUint256);
    vi.mocked(useWaitForTransactionReceipt).mockReturnValue({
      isLoading: false,
      isSuccess: false,
      data: undefined,
    } as unknown as ReturnType<typeof useWaitForTransactionReceipt>);
  });

  it("starts idle and not loading", () => {
    const { result } = renderActions();

    expect(result.current.status).toBe("idle");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("reports a rejected approval as a cancelled transaction without loading", () => {
    approvalErrorState.current = new Error("User rejected the request");

    const { result } = renderActions();

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("Transaction cancelled");
    expect(result.current.isLoading).toBe(false);
  });

  it("waits for an approval that is still pending", () => {
    approvalHashState.current = "0xapproval";
    vi.mocked(useWaitForTransactionReceipt).mockImplementation((options) => ({
      isLoading: options?.hash === "0xapproval",
      isSuccess: false,
      data: undefined,
    } as unknown as ReturnType<typeof useWaitForTransactionReceipt>));

    const { result } = renderActions();

    expect(result.current.status).toBe("waitingApproval");
    expect(result.current.isLoading).toBe(true);
  });

  it("returns to idle after a successful approval receipt", () => {
    approvalHashState.current = "0xapproval";
    vi.mocked(useWaitForTransactionReceipt).mockImplementation((options) => (
      options?.hash === "0xapproval"
        ? receiptOptions({ status: "success" })
        : receiptOptions()
    ));

    const { result } = renderActions();

    expect(result.current.status).toBe("idle");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("reports a reverted deposit receipt", async () => {
    vi.mocked(usePublicClient).mockReturnValue({
      simulateContract: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof usePublicClient>);
    mockSendTx.mockResolvedValue(DEPOSIT_HASH);
    vi.mocked(useWaitForTransactionReceipt).mockImplementation((options) => (
      options?.hash === DEPOSIT_HASH
        ? receiptOptions({ status: "reverted" })
        : receiptOptions()
    ));

    const { result } = renderActions();
    await act(async () => {
      await result.current.deposit("10");
    });

    expect(result.current.status).toBe("reverted");
    expect(result.current.error).toBe("Deposit transaction reverted");
  });

  it("reports a reverted withdraw receipt", async () => {
    vi.mocked(usePublicClient).mockReturnValue({
      simulateContract: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof usePublicClient>);
    mockSendTx.mockResolvedValue(WITHDRAW_HASH);
    vi.mocked(useWaitForTransactionReceipt).mockImplementation((options) => (
      options?.hash === WITHDRAW_HASH
        ? receiptOptions({ status: "reverted" })
        : receiptOptions()
    ));

    const { result } = renderActions();
    await act(async () => {
      await result.current.withdraw("10");
    });

    expect(result.current.status).toBe("reverted");
    expect(result.current.error).toBe("Withdraw transaction reverted");
  });

  it("is withdrawing while the withdraw send is pending", async () => {
    vi.mocked(usePublicClient).mockReturnValue({
      simulateContract: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof usePublicClient>);
    let resolveSend!: (hash: `0x${string}`) => void;
    const sendPromise = new Promise<`0x${string}`>((resolve) => {
      resolveSend = resolve;
    });
    mockSendTx.mockReturnValue(sendPromise);

    const { result } = renderActions();
    await act(async () => {
      void result.current.withdraw("10");
      await Promise.resolve();
    });

    expect(result.current.status).toBe("withdrawing");

    await act(async () => {
      resolveSend(WITHDRAW_HASH);
      await sendPromise;
    });
  });
});
