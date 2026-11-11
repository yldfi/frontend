import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAccount, useSendTransaction } from "wagmi";

import { useDirectSendTransaction } from "@/hooks/useDirectSendTransaction";
import { useTestNetwork } from "@/contexts/TestNetworkContext";

vi.mock("@/contexts/TestNetworkContext", () => ({
  useTestNetwork: vi.fn(),
}));

const HASH = "0x" + "ab".repeat(32);
const WALLET = "0x1234567890123456789012345678901234567890" as `0x${string}`;
const IMPERSONATED = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const TO = "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf" as `0x${string}`;

const mockWagmiSend = vi.fn();
const mockWagmiSendAsync = vi.fn();
const mockWagmiReset = vi.fn();

const MAINNET = {
  vnetEnabled: false,
  vnetAddress: undefined,
  vnetRpcUrl: undefined,
  testNetworkType: null,
  anvilRpcUrl: undefined,
};

const VNET = {
  vnetEnabled: true,
  vnetAddress: IMPERSONATED,
  vnetRpcUrl: "http://vnet.test",
  testNetworkType: null,
  anvilRpcUrl: undefined,
};

const ANVIL = {
  vnetEnabled: false,
  vnetAddress: undefined,
  vnetRpcUrl: undefined,
  testNetworkType: "anvil",
  anvilRpcUrl: "http://anvil.test",
};

function body() {
  return JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string) as {
    method: string;
    params: [Record<string, unknown>];
  };
}

describe("useDirectSendTransaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetch).mockReset();

    vi.mocked(useSendTransaction).mockReturnValue({
      sendTransaction: mockWagmiSend,
      sendTransactionAsync: mockWagmiSendAsync,
      reset: mockWagmiReset,
      data: undefined,
      error: null,
      status: "idle",
    } as unknown as ReturnType<typeof useSendTransaction>);

    vi.mocked(useAccount).mockReturnValue({
      address: WALLET,
    } as unknown as ReturnType<typeof useAccount>);

    vi.mocked(useTestNetwork).mockReturnValue(
      MAINNET as unknown as ReturnType<typeof useTestNetwork>
    );
  });

  it("delegates to wagmi on mainnet without touching the network", async () => {
    mockWagmiSendAsync.mockResolvedValue(HASH);
    const params = { to: TO, data: "0xabcd" as `0x${string}`, value: 1n };

    const { result } = renderHook(() => useDirectSendTransaction());
    let sent: string | undefined;
    await act(async () => {
      sent = await result.current.sendTransactionAsync(params);
    });

    expect(mockWagmiSendAsync).toHaveBeenCalledWith(params);
    expect(sent).toBe(HASH);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("exposes wagmi's data, error and status on mainnet", () => {
    const wagmiError = new Error("wagmi failure");
    vi.mocked(useSendTransaction).mockReturnValue({
      sendTransaction: mockWagmiSend,
      sendTransactionAsync: mockWagmiSendAsync,
      reset: mockWagmiReset,
      data: HASH,
      error: wagmiError,
      status: "error",
    } as unknown as ReturnType<typeof useSendTransaction>);

    const { result } = renderHook(() => useDirectSendTransaction());

    expect(result.current.data).toBe(HASH);
    expect(result.current.error).toBe(wagmiError);
    expect(result.current.status).toBe("error");
  });

  it("posts eth_sendTransaction straight to the VNet RPC", async () => {
    vi.mocked(useTestNetwork).mockReturnValue(
      VNET as unknown as ReturnType<typeof useTestNetwork>
    );
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ result: HASH }),
    } as Response);

    const { result } = renderHook(() => useDirectSendTransaction());
    let sent: string | undefined;
    await act(async () => {
      sent = await result.current.sendTransactionAsync({
        to: TO,
        data: "0xabcd",
        value: 255n,
        gas: 21000n,
      });
    });

    expect(sent).toBe(HASH);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("http://vnet.test");
    const payload = body();
    expect(payload.method).toBe("eth_sendTransaction");
    expect(payload.params[0]).toEqual({
      from: IMPERSONATED,
      to: TO,
      data: "0xabcd",
      value: "0xff",
      gas: "0x5208",
    });
    expect(mockWagmiSendAsync).not.toHaveBeenCalled();
    expect(result.current.data).toBe(HASH);
    expect(result.current.status).toBe("success");
  });

  it("fills in empty data and value defaults for a bare VNet call", async () => {
    vi.mocked(useTestNetwork).mockReturnValue(
      VNET as unknown as ReturnType<typeof useTestNetwork>
    );
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ result: HASH }),
    } as Response);

    const { result } = renderHook(() => useDirectSendTransaction());
    await act(async () => {
      await result.current.sendTransactionAsync({ to: TO });
    });

    const param = body().params[0];
    expect(param.data).toBe("0x");
    expect(param.value).toBe("0x0");
    expect(param).not.toHaveProperty("gas");
  });

  it("surfaces an RPC error as a rejected send", async () => {
    vi.mocked(useTestNetwork).mockReturnValue(
      VNET as unknown as ReturnType<typeof useTestNetwork>
    );
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ error: { message: "boom" } }),
    } as Response);

    const { result } = renderHook(() => useDirectSendTransaction());
    await act(async () => {
      await expect(
        result.current.sendTransactionAsync({ to: TO, data: "0xabcd" })
      ).rejects.toThrow("boom");
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toBe("boom");
  });

  it("posts to the Anvil RPC from the connected wallet", async () => {
    vi.mocked(useTestNetwork).mockReturnValue(
      ANVIL as unknown as ReturnType<typeof useTestNetwork>
    );
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ result: HASH }),
    } as Response);

    const { result } = renderHook(() => useDirectSendTransaction());
    await act(async () => {
      await result.current.sendTransactionAsync({ to: TO, data: "0xabcd" });
    });

    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("http://anvil.test");
    expect(body().params[0].from).toBe(WALLET);
  });

  it("prefers the VNet RPC when both VNet and Anvil are configured", async () => {
    vi.mocked(useTestNetwork).mockReturnValue({
      ...VNET,
      testNetworkType: "anvil",
      anvilRpcUrl: "http://anvil.test",
    } as unknown as ReturnType<typeof useTestNetwork>);
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ result: HASH }),
    } as Response);

    const { result } = renderHook(() => useDirectSendTransaction());
    await act(async () => {
      await result.current.sendTransactionAsync({ to: TO, data: "0xabcd" });
    });

    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("http://vnet.test");
  });

  it("clears direct-send state and wagmi state on reset", async () => {
    vi.mocked(useTestNetwork).mockReturnValue(
      VNET as unknown as ReturnType<typeof useTestNetwork>
    );
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ result: HASH }),
    } as Response);

    const { result } = renderHook(() => useDirectSendTransaction());
    await act(async () => {
      await result.current.sendTransactionAsync({ to: TO, data: "0xabcd" });
    });
    expect(result.current.data).toBe(HASH);

    act(() => {
      result.current.reset();
    });

    expect(result.current.data).toBeUndefined();
    expect(result.current.status).toBe("idle");
    expect(mockWagmiReset).toHaveBeenCalled();
  });
});
