import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAccount, usePublicClient } from "wagmi";

import { useSendTx } from "@/hooks/useSendTx";
import { useFlashbotsProtect } from "@/hooks/useFlashbotsProtect";
import { useTestNetwork } from "@/contexts/TestNetworkContext";

const { mockWalletSend, mockFlashbots, mockEstimateGas } = vi.hoisted(() => ({
  mockWalletSend: vi.fn(),
  mockFlashbots: vi.fn(),
  mockEstimateGas: vi.fn(),
}));

vi.mock("@/hooks/useDirectSendTransaction", () => ({
  useDirectSendTransaction: vi.fn(() => ({ sendTransactionAsync: mockWalletSend })),
}));
vi.mock("@/hooks/useFlashbotsProtect", () => ({ useFlashbotsProtect: vi.fn() }));
vi.mock("@/contexts/TestNetworkContext", () => ({ useTestNetwork: vi.fn() }));

const HASH = "0x" + "cd".repeat(32);
const USER = "0x1234567890123456789012345678901234567890" as `0x${string}`;
const TO = "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf" as `0x${string}`;
const DATA = "0x21025a06" as `0x${string}`;

describe("useSendTx", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useAccount).mockReturnValue({
      address: USER,
      chainId: 1,
    } as unknown as ReturnType<typeof useAccount>);
    vi.mocked(usePublicClient).mockReturnValue({
      estimateGas: mockEstimateGas,
    } as unknown as ReturnType<typeof usePublicClient>);
    vi.mocked(useTestNetwork).mockReturnValue({
      testNetworkType: null,
    } as unknown as ReturnType<typeof useTestNetwork>);
    vi.mocked(useFlashbotsProtect).mockReturnValue({
      isFlashbotsEnabled: false,
      isFlashbotsSupported: false,
      sendViaFlashbots: mockFlashbots,
    } as unknown as ReturnType<typeof useFlashbotsProtect>);

    mockEstimateGas.mockResolvedValue(100_000n);
    mockWalletSend.mockResolvedValue(HASH);
  });

  it("estimates gas with a 30% buffer before sending", async () => {
    const { result } = renderHook(() => useSendTx());
    let sent: string | undefined;
    await act(async () => {
      sent = await result.current.sendTx({ to: TO, data: DATA });
    });

    expect(mockEstimateGas).toHaveBeenCalledWith({
      account: USER,
      to: TO,
      data: DATA,
      value: undefined,
    });
    expect(mockWalletSend).toHaveBeenCalledWith({
      to: TO,
      data: DATA,
      value: undefined,
      gas: 130_000n,
    });
    expect(sent).toBe(HASH);
  });

  it("uses a caller-provided gas limit without estimating", async () => {
    const { result } = renderHook(() => useSendTx());
    await act(async () => {
      await result.current.sendTx({ to: TO, data: DATA, gas: 55_000n });
    });

    expect(mockEstimateGas).not.toHaveBeenCalled();
    expect(mockWalletSend).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 55_000n })
    );
  });

  it("forwards value to the gas estimate and the wallet send", async () => {
    const { result } = renderHook(() => useSendTx());
    await act(async () => {
      await result.current.sendTx({ to: TO, data: DATA, value: 10n });
    });

    const estimate = mockEstimateGas.mock.calls[0][0] as Record<string, unknown>;
    expect(estimate.value).toBe(10n);
    expect(mockEstimateGas).toHaveBeenCalledWith({
      account: USER,
      to: TO,
      data: DATA,
      value: 10n,
    });

    const send = mockWalletSend.mock.calls[0][0] as Record<string, unknown>;
    expect(send.value).toBe(10n);
    expect(mockWalletSend).toHaveBeenCalledWith({
      to: TO,
      data: DATA,
      value: 10n,
      gas: 130_000n,
    });
  });

  it("forwards value to the gas estimate and the Flashbots send", async () => {
    vi.mocked(useFlashbotsProtect).mockReturnValue({
      isFlashbotsEnabled: true,
      isFlashbotsSupported: true,
      sendViaFlashbots: mockFlashbots,
    } as unknown as ReturnType<typeof useFlashbotsProtect>);
    mockFlashbots.mockResolvedValue(HASH);

    const { result } = renderHook(() => useSendTx());
    await act(async () => {
      await result.current.sendTx({ to: TO, data: DATA, value: 10n });
    });

    const estimate = mockEstimateGas.mock.calls[0][0] as Record<string, unknown>;
    expect(estimate.value).toBe(10n);
    expect(mockEstimateGas).toHaveBeenCalledWith({
      account: USER,
      to: TO,
      data: DATA,
      value: 10n,
    });

    const send = mockFlashbots.mock.calls[0][0] as Record<string, unknown>;
    expect(send.value).toBe(10n);
    expect(mockFlashbots).toHaveBeenCalledWith({
      to: TO,
      data: DATA,
      value: 10n,
      gas: 130_000n,
    });
    expect(mockWalletSend).not.toHaveBeenCalled();
  });

  // Pins current behaviour, which is probably unintended: `gas: 0n` is falsy, so the hook estimates instead of honouring the caller's limit. Expected to change when gas handling is reworked.
  it("estimates gas instead of using a caller-supplied gas of 0n", async () => {
    const { result } = renderHook(() => useSendTx());
    await act(async () => {
      await result.current.sendTx({ to: TO, data: DATA, gas: 0n });
    });

    expect(mockEstimateGas).toHaveBeenCalledTimes(1);
    const send = mockWalletSend.mock.calls[0][0] as Record<string, unknown>;
    expect(send.gas).toBe(130_000n);
  });

  it("surfaces the wallet send error on the normal path", async () => {
    mockWalletSend.mockRejectedValue(new Error("user rejected submission"));
    const { result } = renderHook(() => useSendTx());

    await act(async () => {
      await expect(result.current.sendTx({ to: TO, data: DATA })).rejects.toThrow(
        "user rejected submission"
      );
    });

    expect(mockEstimateGas).toHaveBeenCalledTimes(1);
    expect(mockWalletSend).toHaveBeenCalledTimes(1);
    expect(mockFlashbots).not.toHaveBeenCalled();
  });

  it("rejects with the estimation error and never sends", async () => {
    mockEstimateGas.mockRejectedValue(new Error("execution reverted"));
    const { result } = renderHook(() => useSendTx());

    await act(async () => {
      await expect(result.current.sendTx({ to: TO, data: DATA })).rejects.toThrow(
        "execution reverted"
      );
    });

    expect(mockWalletSend).not.toHaveBeenCalled();
    expect(mockFlashbots).not.toHaveBeenCalled();
  });

  it("wraps a non-Error estimation failure in an Error", async () => {
    mockEstimateGas.mockRejectedValue("nope");
    const { result } = renderHook(() => useSendTx());

    await act(async () => {
      await expect(result.current.sendTx({ to: TO, data: DATA })).rejects.toThrow(
        new Error("nope")
      );
    });
  });

  it("sends without a gas limit when no wallet is connected", async () => {
    vi.mocked(useAccount).mockReturnValue({
      address: undefined,
      chainId: 1,
    } as unknown as ReturnType<typeof useAccount>);
    const { result } = renderHook(() => useSendTx());
    await act(async () => {
      await result.current.sendTx({ to: TO, data: DATA });
    });

    expect(mockEstimateGas).not.toHaveBeenCalled();
    const params = mockWalletSend.mock.calls[0][0] as Record<string, unknown>;
    expect(params).not.toHaveProperty("gas");
  });

  it("sends through Flashbots on mainnet when enabled", async () => {
    vi.mocked(useFlashbotsProtect).mockReturnValue({
      isFlashbotsEnabled: true,
      isFlashbotsSupported: true,
      sendViaFlashbots: mockFlashbots,
    } as unknown as ReturnType<typeof useFlashbotsProtect>);
    mockFlashbots.mockResolvedValue(HASH);

    const { result } = renderHook(() => useSendTx());
    let sent: string | undefined;
    await act(async () => {
      sent = await result.current.sendTx({ to: TO, data: DATA });
    });

    expect(mockFlashbots).toHaveBeenCalledWith({
      to: TO,
      data: DATA,
      value: undefined,
      gas: 130_000n,
    });
    expect(sent).toBe(HASH);
    expect(mockWalletSend).not.toHaveBeenCalled();
  });

  it("falls back to the wallet when Flashbots cannot sign", async () => {
    vi.mocked(useFlashbotsProtect).mockReturnValue({
      isFlashbotsEnabled: true,
      isFlashbotsSupported: true,
      sendViaFlashbots: mockFlashbots,
    } as unknown as ReturnType<typeof useFlashbotsProtect>);
    mockFlashbots.mockRejectedValue(
      new Error("Method eth_signTransaction is not supported")
    );

    const { result } = renderHook(() => useSendTx());
    let sent: string | undefined;
    await act(async () => {
      sent = await result.current.sendTx({ to: TO, data: DATA });
    });

    expect(mockFlashbots).toHaveBeenCalledTimes(1);
    expect(mockWalletSend).toHaveBeenCalledTimes(1);
    // The fallback reuses the params built for Flashbots, including the estimate.
    const fallback = mockWalletSend.mock.calls[0][0] as Record<string, unknown>;
    expect(fallback).toEqual({
      to: TO,
      data: DATA,
      value: undefined,
      gas: 130_000n,
    });
    expect(mockWalletSend).toHaveBeenCalledWith({
      to: TO,
      data: DATA,
      value: undefined,
      gas: 130_000n,
    });
    expect(sent).toBe(HASH);
  });

  it("propagates an unrecoverable Flashbots error without a wallet fallback", async () => {
    vi.mocked(useFlashbotsProtect).mockReturnValue({
      isFlashbotsEnabled: true,
      isFlashbotsSupported: true,
      sendViaFlashbots: mockFlashbots,
    } as unknown as ReturnType<typeof useFlashbotsProtect>);
    mockFlashbots.mockRejectedValue(new Error("user rejected"));

    const { result } = renderHook(() => useSendTx());
    await act(async () => {
      await expect(result.current.sendTx({ to: TO, data: DATA })).rejects.toThrow(
        "user rejected"
      );
    });

    expect(mockWalletSend).not.toHaveBeenCalled();
  });

  it("skips Flashbots on a test network", async () => {
    vi.mocked(useFlashbotsProtect).mockReturnValue({
      isFlashbotsEnabled: true,
      isFlashbotsSupported: true,
      sendViaFlashbots: mockFlashbots,
    } as unknown as ReturnType<typeof useFlashbotsProtect>);
    vi.mocked(useTestNetwork).mockReturnValue({
      testNetworkType: "anvil",
    } as unknown as ReturnType<typeof useTestNetwork>);

    const { result } = renderHook(() => useSendTx());
    await act(async () => {
      await result.current.sendTx({ to: TO, data: DATA });
    });

    expect(mockFlashbots).not.toHaveBeenCalled();
    expect(mockWalletSend).toHaveBeenCalledTimes(1);
  });

  it("skips Flashbots off mainnet", async () => {
    vi.mocked(useFlashbotsProtect).mockReturnValue({
      isFlashbotsEnabled: true,
      isFlashbotsSupported: true,
      sendViaFlashbots: mockFlashbots,
    } as unknown as ReturnType<typeof useFlashbotsProtect>);
    vi.mocked(useAccount).mockReturnValue({
      address: USER,
      chainId: 10,
    } as unknown as ReturnType<typeof useAccount>);

    const { result } = renderHook(() => useSendTx());
    await act(async () => {
      await result.current.sendTx({ to: TO, data: DATA });
    });

    expect(mockFlashbots).not.toHaveBeenCalled();
    expect(mockWalletSend).toHaveBeenCalledTimes(1);
  });

  it("skips Flashbots when the wallet does not support it", async () => {
    vi.mocked(useFlashbotsProtect).mockReturnValue({
      isFlashbotsEnabled: true,
      isFlashbotsSupported: false,
      sendViaFlashbots: mockFlashbots,
    } as unknown as ReturnType<typeof useFlashbotsProtect>);

    const { result } = renderHook(() => useSendTx());
    await act(async () => {
      await result.current.sendTx({ to: TO, data: DATA });
    });

    expect(mockFlashbots).not.toHaveBeenCalled();
    expect(mockWalletSend).toHaveBeenCalledTimes(1);
  });
});
