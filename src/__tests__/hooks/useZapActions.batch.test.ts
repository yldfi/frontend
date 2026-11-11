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
// USDT requires approve(0) first, so its batch has two approval calls.
const USDT: EnsoToken = {
  address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  chainId: 1,
  name: "Tether USD",
  symbol: "USDT",
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
const USDT_QUOTE: ZapQuote = { ...QUOTE, inputToken: USDT };

describe("useZapActions Safe batch", () => {
  let simulateBodies: Array<Record<string, unknown>>;
  /** Allowance the hook reads from wagmi (`useReadContract`). */
  let allowance: bigint;
  /** Allowance the fresh on-chain read in `executeZap` returns. */
  let onchainAllowance: bigint;
  /** Runs on every `/api/simulate` request, so a test can see the hook mid-flight. */
  let onSimulate: (() => void) | undefined;
  /** When set, the `/api/simulate` reply waits for it, so a test can hold a send mid-flight. */
  let simulateGate: Promise<void> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    batchState.canBatch = true;
    simulateBodies = [];
    allowance = 0n;
    onchainAllowance = 0n;
    onSimulate = undefined;
    simulateGate = undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/api/simulate/nonce")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, nonce: "n", expires: Date.now() + 60_000, sig: "s" }) });
      }
      if (url.includes("/api/simulate")) {
        simulateBodies.push(JSON.parse(String(init?.body)));
        onSimulate?.();
        const reply = {
          ok: true,
          json: () => Promise.resolve({ success: true, gasUsed: 1, simulationId: "sim", tenderlyUrl: null, assetChanges: [], errorMessage: null }),
        };
        return simulateGate ? simulateGate.then(() => reply) : Promise.resolve(reply);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }));
    vi.mocked(useAccount).mockReturnValue({ address: SAFE, chainId: 1, isConnected: true } as unknown as ReturnType<typeof useAccount>);
    vi.mocked(usePublicClient).mockReturnValue({
      getBlockNumber: vi.fn().mockResolvedValue(26313129n),
      readContract: vi.fn().mockImplementation(() => Promise.resolve(onchainAllowance)),
    } as unknown as ReturnType<typeof usePublicClient>);
    vi.mocked(useWalletClient).mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useWalletClient>);
    vi.mocked(useReadContract).mockImplementation(
      () => ({ data: allowance, refetch: vi.fn() }) as unknown as ReturnType<typeof useReadContract>,
    );
    vi.mocked(useWaitForTransactionReceipt).mockReturnValue({ isLoading: false, isSuccess: false, data: undefined } as unknown as ReturnType<typeof useWaitForTransactionReceipt>);
    mockAnvilCall.mockRejectedValue(new Error("insufficient allowance"));
    mockSendBatch.mockResolvedValue(SAFE_TX_HASH);
  });

  it("zap goes straight to the preview with an exact approval, then confirm sends one batch", async () => {
    const { result } = renderHook(() => useZapActions(QUOTE));

    // 1. Zap click: allowance is short, but there's no approval card or
    //    exact/unlimited choice. The preview simulates approval + zap.
    await act(async () => {
      const preview = await result.current.executeZap({ previewOnly: true });
      expect(preview?.success).toBe(true);
    });
    expect(result.current.status).not.toBe("needsApproval");
    expect(result.current.pendingApproval).toBeNull();
    expect(mockWriteApprove).not.toHaveBeenCalled();
    const exact = parseUnits("1000", 6);
    const approvals = simulateBodies.at(-1)!.approvalTransactions as Array<{ to: string; data: `0x${string}` }>;
    expect(approvals.map((a) => a.to)).toEqual([USDC.address]);
    expect(decodeFunctionData({ abi: ERC20_APPROVAL_ABI, data: approvals[0].data }).args).toEqual([ENSO_ROUTER_V2, exact]);

    // 2. Confirm in the preview: one atomic batch, no approval prompt.
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

  it("sends the exact approval calls the preview simulated, in order", async () => {
    allowance = parseUnits("1", 6); // a nonzero USDT allowance needs approve(0) first

    const { result } = renderHook(() => useZapActions(USDT_QUOTE));

    await act(async () => {
      await result.current.executeZap({ previewOnly: true });
    });
    const exact = parseUnits("1000", 6);
    const previewed = simulateBodies.at(-1)!.approvalTransactions as Array<{ to: string; data: `0x${string}` }>;
    expect(previewed).toHaveLength(2);
    expect(previewed.map((call) => decodeFunctionData({ abi: ERC20_APPROVAL_ABI, data: call.data }).args)).toEqual([
      [ENSO_ROUTER_V2, 0n],
      [ENSO_ROUTER_V2, exact],
    ]);

    await act(async () => {
      await result.current.executeZap({ skipSimulation: true });
    });

    expect(mockSendBatch).toHaveBeenCalledTimes(1);
    const [calls] = mockSendBatch.mock.calls[0] as [Array<{ to: string; data: string }>];
    expect(calls).toHaveLength(3);
    // Everything before the zap is exactly what the user previewed.
    expect(calls.slice(0, -1)).toEqual(previewed.map(({ to, data }) => ({ to, data })));
    expect(calls.at(-1)).toMatchObject({ to: USDT_QUOTE.tx.to, data: USDT_QUOTE.tx.data });
    expect(result.current.zapHash).toBe(SAFE_TX_HASH);
  });

  it("does not send when the batch gains a reset call after the preview", async () => {
    const { result, rerender } = renderHook(({ q }: { q: ZapQuote }) => useZapActions(q), {
      initialProps: { q: USDT_QUOTE },
    });

    // Preview with a single approve: the allowance is zero, so no reset.
    await act(async () => {
      await result.current.executeZap({ previewOnly: true });
    });
    const previewed = simulateBodies.at(-1)!.approvalTransactions as Array<{ data: `0x${string}` }>;
    expect(previewed).toHaveLength(1);
    expect(result.current.isSimulationForCurrentQuote()).toBe(true);

    // The allowance moves before the confirm, so the same token now needs
    // approve(0) first: the armed batch would carry two calls, not one.
    allowance = parseUnits("1", 6);
    rerender({ q: { ...USDT_QUOTE, inputAmount: "1001" } });
    expect(result.current.isSimulationForCurrentQuote()).toBe(false);

    const previewedCurrent: boolean[] = [];
    onSimulate = () => previewedCurrent.push(result.current.isSimulationForCurrentQuote());

    await act(async () => {
      await result.current.executeZap({ skipSimulation: true });
    });

    expect(mockSendBatch).not.toHaveBeenCalled();
    const rebuilt = simulateBodies.at(-1)!.approvalTransactions as Array<{ to: string; data: `0x${string}` }>;
    expect(rebuilt.map((call) => decodeFunctionData({ abi: ERC20_APPROVAL_ABI, data: call.data }).args)).toEqual([
      [ENSO_ROUTER_V2, 0n],
      [ENSO_ROUTER_V2, parseUnits("1001", 6)],
    ]);
    // While the confirm re-simulated, the stored preview no longer matched.
    expect(previewedCurrent).toEqual([false]);
  });

  it("does not send when the allowance drops after a preview with no approvals", async () => {
    onchainAllowance = parseUnits("1000", 6);
    allowance = parseUnits("1000", 6);
    const { result, rerender } = renderHook(() => useZapActions(QUOTE));

    await act(async () => {
      await result.current.executeZap({ previewOnly: true });
    });
    expect(simulateBodies).toHaveLength(1);
    expect(simulateBodies[0]).not.toHaveProperty("approvalTransactions");
    expect(result.current.isSimulationForCurrentQuote()).toBe(true);

    // The allowance is spent elsewhere before the user confirms.
    onchainAllowance = 0n;
    allowance = 0n;
    rerender();

    const previewedCurrent: boolean[] = [];
    onSimulate = () => previewedCurrent.push(result.current.isSimulationForCurrentQuote());

    await act(async () => {
      await result.current.executeZap({ skipSimulation: true });
    });

    expect(mockSendBatch).not.toHaveBeenCalled();
    const approvals = simulateBodies.at(-1)!.approvalTransactions as Array<{ to: string; data: `0x${string}` }>;
    expect(approvals.map((call) => call.to)).toEqual([USDC.address]);
    expect(decodeFunctionData({ abi: ERC20_APPROVAL_ABI, data: approvals[0].data }).args).toEqual([
      ENSO_ROUTER_V2,
      parseUnits("1000", 6),
    ]);
    // The confirm re-simulated because the preview had no approvals.
    expect(previewedCurrent).toEqual([false]);
  });

  it("does not send when the amount changes while the simulation runs", async () => {
    const { result, rerender } = renderHook(({ q }: { q: ZapQuote }) => useZapActions(q), {
      initialProps: { q: QUOTE },
    });

    let releaseSimulation!: () => void;
    simulateGate = new Promise<void>((resolve) => {
      releaseSimulation = resolve;
    });

    let execution: Promise<unknown> = Promise.resolve();
    await act(async () => {
      execution = result.current.executeZap();
    });
    // The zap is now waiting on the simulation, with its approval batch armed.
    await waitFor(() => expect(simulateBodies).toHaveLength(1));
    const armed = simulateBodies.at(-1)!.approvalTransactions as Array<{ to: string }>;
    expect(armed.map((call) => call.to)).toEqual([USDC.address]);

    // The user edits the amount while the simulation is still running.
    rerender({ q: { ...QUOTE, inputAmount: "2000" } });

    await act(async () => {
      releaseSimulation();
      await execution;
    });

    expect(mockSendBatch).not.toHaveBeenCalled();
    expect(mockSendTx).not.toHaveBeenCalled();
  });

  it("drops the armed batch and the preview when the approval spender changes", async () => {
    const VAULT_A = "0x1111111111111111111111111111111111111111" as const;
    const VAULT_B = "0x2222222222222222222222222222222222222222" as const;
    const directQuote = (vaultAddress: string): ZapQuote => ({
      ...QUOTE,
      directVault: { vaultAddress, action: "deposit", symbol: "yUSDC" },
    });

    const { result, rerender } = renderHook(({ q }: { q: ZapQuote }) => useZapActions(q), {
      initialProps: { q: directQuote(VAULT_A) },
    });

    // Preview at the first vault: the batch of one approval is armed for it.
    await act(async () => {
      await result.current.executeZap({ previewOnly: true });
    });
    const previewed = simulateBodies.at(-1)!.approvalTransactions as Array<{ to: string; data: `0x${string}` }>;
    expect(decodeFunctionData({ abi: ERC20_APPROVAL_ABI, data: previewed[0].data }).args).toEqual([
      VAULT_A,
      parseUnits("1000", 6),
    ]);
    expect(result.current.isSimulationForCurrentQuote()).toBe(true);

    // Same token and amount, a different spender: nothing armed for VAULT_A may
    // survive into the quote that approves VAULT_B.
    rerender({ q: directQuote(VAULT_B) });
    expect(result.current.isSimulationForCurrentQuote()).toBe(false);

    await act(async () => {
      await result.current.executeZap({ skipSimulation: true });
    });

    expect(mockSendBatch).not.toHaveBeenCalled();
    const rebuilt = simulateBodies.at(-1)!.approvalTransactions as Array<{ to: string; data: `0x${string}` }>;
    expect(rebuilt.map((call) => decodeFunctionData({ abi: ERC20_APPROVAL_ABI, data: call.data }).args)).toEqual([
      [VAULT_B, parseUnits("1000", 6)],
    ]);
  });
});
