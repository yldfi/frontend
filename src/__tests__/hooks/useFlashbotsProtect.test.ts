import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";

import { FLASHBOTS_RPC_URL } from "@/config/rpc";
import {
  isUnsupportedFlashbotsWallet,
  useFlashbotsProtect,
} from "@/hooks/useFlashbotsProtect";

const HASH = "0x" + "ab".repeat(32);
const SIGNED = "0x02f86b0180843b9aca00";
const TX = {
  to: "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf" as `0x${string}`,
  value: 1n,
};

type WalletWindow = Window & { ethereum?: unknown; rabby?: unknown };

function body() {
  return JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string) as {
    jsonrpc: string;
    id: number;
    method: string;
    params: string[];
  };
}

function mockWalletClients() {
  const account = { address: "0x1234567890123456789012345678901234567890" };
  const chain = { id: 1, name: "Ethereum" };
  const prepared = { ...TX, nonce: 7, gas: 21_000n };
  const prepareTransactionRequest = vi.fn().mockResolvedValue(prepared);
  const signTransaction = vi.fn().mockResolvedValue(SIGNED);

  vi.mocked(usePublicClient).mockReturnValue({
    prepareTransactionRequest,
  } as unknown as ReturnType<typeof usePublicClient>);
  vi.mocked(useWalletClient).mockReturnValue({
    data: {
      account,
      chain,
      signTransaction,
    },
  } as unknown as ReturnType<typeof useWalletClient>);

  return { account, chain, prepared, prepareTransactionRequest, signTransaction };
}

function setConnector(connector: { name?: string; id?: string } | undefined) {
  vi.mocked(useAccount).mockReturnValue({
    connector,
  } as unknown as ReturnType<typeof useAccount>);
}

describe("isUnsupportedFlashbotsWallet", () => {
  const patterns = ["frame", "rabby", "ledger", "trezor", "safe", "walletconnect"];

  it.each(patterns)("matches %s in the connector name", (pattern) => {
    expect(
      isUnsupportedFlashbotsWallet({
        connectorName: `My ${pattern.toUpperCase()} Wallet`,
        connectorId: "io.metamask",
      })
    ).toBe(true);
  });

  it.each(patterns)("matches %s in the connector id", (pattern) => {
    expect(
      isUnsupportedFlashbotsWallet({
        connectorName: "MetaMask",
        connectorId: `io.${pattern}`,
      })
    ).toBe(true);
  });

  it("matches known wallet provider flags", () => {
    expect(
      isUnsupportedFlashbotsWallet({ ethereumProvider: { isFrame: true } })
    ).toBe(true);
    expect(
      isUnsupportedFlashbotsWallet({ ethereumProvider: { isRabby: true } })
    ).toBe(true);
    expect(isUnsupportedFlashbotsWallet({ rabbyProvider: { isRabby: true } })).toBe(
      true
    );
  });

  it("accepts an ordinary MetaMask connector with no provider flags", () => {
    expect(
      isUnsupportedFlashbotsWallet({
        connectorName: "MetaMask",
        connectorId: "io.metamask",
      })
    ).toBe(false);
  });

  it("accepts missing wallet information", () => {
    expect(isUnsupportedFlashbotsWallet({})).toBe(false);
  });
});

describe("useFlashbotsProtect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetch).mockReset();
    vi.mocked(localStorage.getItem).mockReturnValue(null);
    setConnector(undefined);
    vi.mocked(usePublicClient).mockReturnValue({
      prepareTransactionRequest: vi.fn(),
    } as unknown as ReturnType<typeof usePublicClient>);
    vi.mocked(useWalletClient).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useWalletClient>);
  });

  afterEach(() => {
    delete (window as WalletWindow).ethereum;
    delete (window as WalletWindow).rabby;
  });

  it("is enabled by default when storage is empty", () => {
    const { result } = renderHook(() => useFlashbotsProtect());

    expect(result.current.isFlashbotsEnabled).toBe(true);
  });

  it("stays disabled when storage holds false", () => {
    vi.mocked(localStorage.getItem).mockReturnValue("false");

    const { result } = renderHook(() => useFlashbotsProtect());

    expect(result.current.isFlashbotsEnabled).toBe(false);
  });

  it("toggles the preference and persists it", () => {
    const { result } = renderHook(() => useFlashbotsProtect());
    expect(result.current.isFlashbotsEnabled).toBe(true);

    act(() => {
      result.current.toggleFlashbots(false);
    });

    expect(result.current.isFlashbotsEnabled).toBe(false);
    expect(localStorage.setItem).toHaveBeenCalledWith(
      "yldfi_flashbots_enabled",
      "false"
    );
  });

  it("supports any wallet until a connector is known", () => {
    setConnector(undefined);

    const { result } = renderHook(() => useFlashbotsProtect());

    expect(result.current.isFlashbotsSupported).toBe(true);
  });

  it("does not support a Frame connector", () => {
    setConnector({ name: "Frame", id: "frame" });

    const { result } = renderHook(() => useFlashbotsProtect());

    expect(result.current.isFlashbotsSupported).toBe(false);
  });

  it("supports a MetaMask connector without provider flags", () => {
    setConnector({ name: "MetaMask", id: "io.metamask" });

    const { result } = renderHook(() => useFlashbotsProtect());

    expect(result.current.isFlashbotsSupported).toBe(true);
  });

  it("rejects with a wallet error when no wallet is connected", async () => {
    vi.mocked(useWalletClient).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useWalletClient>);

    const { result } = renderHook(() => useFlashbotsProtect());
    await act(async () => {
      await expect(result.current.sendViaFlashbots(TX)).rejects.toThrow(
        "Wallet not connected"
      );
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects when no public client is available", async () => {
    vi.mocked(usePublicClient).mockReturnValue(undefined as never);
    vi.mocked(useWalletClient).mockReturnValue({
      data: { signTransaction: vi.fn() },
    } as unknown as ReturnType<typeof useWalletClient>);

    const { result } = renderHook(() => useFlashbotsProtect());
    await act(async () => {
      await expect(result.current.sendViaFlashbots(TX)).rejects.toThrow(
        "Public client not available"
      );
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("prepares, signs and submits a raw transaction", async () => {
    const { account, chain, prepared, prepareTransactionRequest, signTransaction } =
      mockWalletClients();
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ result: HASH }),
    } as Response);

    const { result } = renderHook(() => useFlashbotsProtect());
    let hash: string | undefined;
    await act(async () => {
      hash = await result.current.sendViaFlashbots(TX);
    });

    expect(prepareTransactionRequest).toHaveBeenCalledWith({
      ...TX,
      account,
      chain,
    });
    expect(signTransaction).toHaveBeenCalledWith({
      ...prepared,
      account,
      chain,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(FLASHBOTS_RPC_URL);

    const payload = body();
    expect(payload.method).toBe("eth_sendRawTransaction");
    expect(payload.params).toEqual([SIGNED]);

    expect(hash).toBe(HASH);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("surfaces a JSON-RPC error message", async () => {
    mockWalletClients();
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ error: { message: "nonce too low" } }),
    } as Response);

    const { result } = renderHook(() => useFlashbotsProtect());
    await act(async () => {
      await expect(result.current.sendViaFlashbots(TX)).rejects.toThrow(
        "nonce too low"
      );
    });

    expect(result.current.error?.message).toBe("nonce too low");
    expect(result.current.isLoading).toBe(false);
  });

  it("falls back to a generic message for an empty JSON-RPC error", async () => {
    mockWalletClients();
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ error: {} }),
    } as Response);

    const { result } = renderHook(() => useFlashbotsProtect());
    await act(async () => {
      await expect(result.current.sendViaFlashbots(TX)).rejects.toThrow(
        "Flashbots submission failed"
      );
    });

    expect(result.current.error?.message).toBe("Flashbots submission failed");
  });

  it("rejects when the RPC returns no transaction hash", async () => {
    mockWalletClients();
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({}),
    } as Response);

    const { result } = renderHook(() => useFlashbotsProtect());
    await act(async () => {
      await expect(result.current.sendViaFlashbots(TX)).rejects.toThrow(
        "No transaction hash returned from Flashbots"
      );
    });

    expect(result.current.error?.message).toBe(
      "No transaction hash returned from Flashbots"
    );
  });

  it("propagates a wallet rejection without submitting anything", async () => {
    const { signTransaction } = mockWalletClients();
    signTransaction.mockRejectedValue(new Error("User rejected"));

    const { result } = renderHook(() => useFlashbotsProtect());
    await act(async () => {
      await expect(result.current.sendViaFlashbots(TX)).rejects.toThrow(
        "User rejected"
      );
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error?.message).toBe("User rejected");
  });
});
