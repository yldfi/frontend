import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAccount, useCapabilities, useWalletClient } from "wagmi";

import { useIsSafeWallet } from "@/hooks/useIsSafeWallet";
import { useSafeBatch } from "@/hooks/useSafeBatch";

vi.mock("wagmi", () => ({
  useAccount: vi.fn(),
  useCapabilities: vi.fn(),
  useWalletClient: vi.fn(),
}));
vi.mock("@/hooks/useIsSafeWallet", () => ({ useIsSafeWallet: vi.fn() }));

const SAFE = "0x8baecb301FD723Ff35FB1D9a6d595cAD35618A6f" as const;
const SAFE_TX_HASH = "0x25bc99a3a5b83fb8f7e012607ddbfcd4b7b86cf167c15914459c8fea276b9963";
const CVX = "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B" as const;
const VAULT = "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e" as const;

function setup({ isSafe, atomic, sendCallsId = SAFE_TX_HASH }: { isSafe: boolean; atomic?: string; sendCallsId?: string }) {
  const sendCalls = vi.fn().mockResolvedValue({ id: sendCallsId });
  vi.mocked(useAccount).mockReturnValue({ address: SAFE, chainId: 1 } as unknown as ReturnType<typeof useAccount>);
  vi.mocked(useIsSafeWallet).mockReturnValue(isSafe);
  vi.mocked(useCapabilities).mockReturnValue({
    // Shape reported by the live Safe{Wallet} WalletConnect session on 31 Oct.
    data: atomic ? { 1: { atomic: { status: atomic } } } : undefined,
  } as unknown as ReturnType<typeof useCapabilities>);
  vi.mocked(useWalletClient).mockReturnValue({ data: { sendCalls } } as unknown as ReturnType<typeof useWalletClient>);
  return { sendCalls };
}

describe("useSafeBatch", () => {
  afterEach(() => vi.clearAllMocks());

  it("batches only for a Safe whose wallet reports atomic support", () => {
    setup({ isSafe: true, atomic: "supported" });
    expect(renderHook(() => useSafeBatch()).result.current.canBatch).toBe(true);

    setup({ isSafe: false, atomic: "supported" });
    expect(renderHook(() => useSafeBatch()).result.current.canBatch).toBe(false);

    // An EOA reporting "ready" would trigger an EIP-7702 upgrade prompt.
    setup({ isSafe: true, atomic: "ready" });
    expect(renderHook(() => useSafeBatch()).result.current.canBatch).toBe(false);

    setup({ isSafe: true });
    expect(renderHook(() => useSafeBatch()).result.current.canBatch).toBe(false);
  });

  it("sends the calls atomically and returns the safeTxHash as the trackable id", async () => {
    const { sendCalls } = setup({ isSafe: true, atomic: "supported" });
    const { result } = renderHook(() => useSafeBatch());

    const id = await result.current.sendBatch([
      { to: CVX, data: "0x095ea7b3" },
      { to: VAULT, data: "0x6e553f65" },
    ]);

    expect(id).toBe(SAFE_TX_HASH);
    expect(sendCalls).toHaveBeenCalledWith({
      account: SAFE,
      calls: [
        { to: CVX, data: "0x095ea7b3", value: 0n },
        { to: VAULT, data: "0x6e553f65", value: 0n },
      ],
      forceAtomic: true,
    });
  });

  it("refuses a batch id it can't track as a transaction", async () => {
    setup({ isSafe: true, atomic: "supported", sendCallsId: "bundle-123" });
    const { result } = renderHook(() => useSafeBatch());
    await expect(result.current.sendBatch([{ to: VAULT, data: "0x" }])).rejects.toThrow("unexpected batch id");
  });
});
