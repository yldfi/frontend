import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAccount, useWriteContract } from "wagmi";
import { encodeFunctionData } from "viem";

import { useDirectWriteContract } from "@/hooks/useDirectWriteContract";
import { useTestNetwork } from "@/contexts/TestNetworkContext";

vi.mock("@/contexts/TestNetworkContext", () => ({
  useTestNetwork: vi.fn(),
}));

const HASH = "0x" + "ab".repeat(32);
const WALLET = "0x1234567890123456789012345678901234567890" as `0x${string}`;
const IMPERSONATED = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const TO = "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf" as `0x${string}`;
const SPENDER = "0x1111111111111111111111111111111111111111" as `0x${string}`;

const ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const PARAMS = {
  address: TO,
  abi: ABI,
  functionName: "approve",
  args: [SPENDER, 1n],
} as const;

// The hook returns a union of its direct-send API and wagmi's, so a direct call
// with `value` is checked against both signatures; wagmi rejects `value` for a
// nonpayable function. Call through the direct branch's own parameter type.
type DirectWriteParams = {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
};

const mockWagmiWrite = vi.fn();
const mockWagmiWriteAsync = vi.fn();
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

function body(index = 0) {
  return JSON.parse(
    vi.mocked(fetch).mock.calls[index][1]!.body as string
  ) as {
    method: string;
    params: [Record<string, unknown>];
  };
}

function expectedCalldata() {
  return encodeFunctionData({
    abi: ABI,
    functionName: "approve",
    args: PARAMS.args,
  });
}

describe("useDirectWriteContract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetch).mockReset();

    vi.mocked(useWriteContract).mockReturnValue({
      writeContract: mockWagmiWrite,
      writeContractAsync: mockWagmiWriteAsync,
      reset: mockWagmiReset,
      data: undefined,
      error: null,
      status: "idle",
      isError: false,
    } as unknown as ReturnType<typeof useWriteContract>);

    vi.mocked(useAccount).mockReturnValue({
      address: WALLET,
    } as unknown as ReturnType<typeof useAccount>);

    vi.mocked(useTestNetwork).mockReturnValue(
      MAINNET as unknown as ReturnType<typeof useTestNetwork>
    );
  });

  it("delegates to wagmi on mainnet without touching the network", async () => {
    mockWagmiWriteAsync.mockResolvedValue(HASH);

    const { result } = renderHook(() => useDirectWriteContract());
    let hash: string | undefined;
    await act(async () => {
      hash = await result.current.writeContractAsync(PARAMS);
    });

    expect(mockWagmiWriteAsync).toHaveBeenCalledWith(PARAMS);
    expect(hash).toBe(HASH);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("exposes wagmi's data, error, status and isError on mainnet", () => {
    const wagmiError = new Error("wagmi failure");
    vi.mocked(useWriteContract).mockReturnValue({
      writeContract: mockWagmiWrite,
      writeContractAsync: mockWagmiWriteAsync,
      reset: mockWagmiReset,
      data: HASH,
      error: wagmiError,
      status: "error",
      isError: true,
    } as unknown as ReturnType<typeof useWriteContract>);

    const { result } = renderHook(() => useDirectWriteContract());

    expect(result.current.data).toBe(HASH);
    expect(result.current.error).toBe(wagmiError);
    expect(result.current.status).toBe("error");
    expect(result.current.isError).toBe(true);
    expect(result.current.reset).toBe(mockWagmiReset);
  });

  it("posts an encoded eth_sendTransaction to the VNet RPC", async () => {
    vi.mocked(useTestNetwork).mockReturnValue(
      VNET as unknown as ReturnType<typeof useTestNetwork>
    );
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ result: HASH }),
    } as Response);

    const { result } = renderHook(() => useDirectWriteContract());
    let hash: string | undefined;
    await act(async () => {
      hash = await result.current.writeContractAsync(PARAMS);
    });

    expect(hash).toBe(HASH);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("http://vnet.test");
    const payload = body();
    expect(payload.method).toBe("eth_sendTransaction");
    expect(payload.params[0]).toEqual({
      from: IMPERSONATED,
      to: TO,
      data: expectedCalldata(),
      value: "0x0",
    });
    expect(mockWagmiWriteAsync).not.toHaveBeenCalled();
    expect(result.current.data).toBe(HASH);
    expect(result.current.status).toBe("success");
  });

  it("encodes a non-zero value for a VNet write", async () => {
    vi.mocked(useTestNetwork).mockReturnValue(
      VNET as unknown as ReturnType<typeof useTestNetwork>
    );
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ result: HASH }),
    } as Response);

    const { result } = renderHook(() => useDirectWriteContract());
    const writeAsync = result.current
      .writeContractAsync as unknown as (
      params: DirectWriteParams
    ) => Promise<`0x${string}`>;
    await act(async () => {
      await writeAsync({ ...PARAMS, value: 255n });
    });

    expect(body().params[0].value).toBe("0xff");
  });

  it("posts to the Anvil RPC from the connected wallet", async () => {
    vi.mocked(useTestNetwork).mockReturnValue(
      ANVIL as unknown as ReturnType<typeof useTestNetwork>
    );
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ result: HASH }),
    } as Response);

    const { result } = renderHook(() => useDirectWriteContract());
    await act(async () => {
      await result.current.writeContractAsync(PARAMS);
    });

    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("http://anvil.test");
    expect(body().params[0].from).toBe(WALLET);
  });

  it("falls back to wagmi when VNet is enabled without an RPC URL", async () => {
    vi.mocked(useTestNetwork).mockReturnValue({
      ...VNET,
      vnetRpcUrl: undefined,
    } as unknown as ReturnType<typeof useTestNetwork>);
    mockWagmiWriteAsync.mockResolvedValue(HASH);

    const { result } = renderHook(() => useDirectWriteContract());
    let hash: string | undefined;
    await act(async () => {
      hash = await result.current.writeContractAsync(PARAMS);
    });

    expect(mockWagmiWriteAsync).toHaveBeenCalledWith(PARAMS);
    expect(hash).toBe(HASH);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces an RPC error as a rejected write", async () => {
    vi.mocked(useTestNetwork).mockReturnValue(
      VNET as unknown as ReturnType<typeof useTestNetwork>
    );
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ error: { message: "execution reverted" } }),
    } as Response);

    const { result } = renderHook(() => useDirectWriteContract());
    await act(async () => {
      await expect(result.current.writeContractAsync(PARAMS)).rejects.toThrow(
        "execution reverted"
      );
    });

    expect(result.current.status).toBe("error");
    expect(result.current.isError).toBe(true);
    expect(result.current.error?.message).toBe("execution reverted");
    expect(result.current.data).toBeUndefined();
  });

  it("swallows a failing non-async write but records the error", async () => {
    vi.mocked(useTestNetwork).mockReturnValue(
      VNET as unknown as ReturnType<typeof useTestNetwork>
    );
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ error: { message: "execution reverted" } }),
    } as Response);

    const { result } = renderHook(() => useDirectWriteContract());
    await act(async () => {
      result.current.writeContract(PARAMS);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.error?.message).toBe("execution reverted");
  });

  it("clears direct state and resets wagmi after a successful write", async () => {
    vi.mocked(useTestNetwork).mockReturnValue(
      VNET as unknown as ReturnType<typeof useTestNetwork>
    );
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ result: HASH }),
    } as Response);

    const { result } = renderHook(() => useDirectWriteContract());
    await act(async () => {
      await result.current.writeContractAsync(PARAMS);
    });
    expect(result.current.data).toBe(HASH);

    act(() => {
      result.current.reset();
    });

    expect(mockWagmiReset).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
    expect(result.current.status).toBe("idle");
  });
});
