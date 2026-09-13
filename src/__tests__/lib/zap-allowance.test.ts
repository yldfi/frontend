import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters } from "viem";
import { mainnet } from "viem/chains";
import { ERC20_APPROVAL_ABI } from "@/lib/abis";
import { ALLOWANCE_READ_ERROR, readZapAllowance } from "@/lib/zap-allowance";

const owner = "0xa88e98bbd2af6ddd642407cb5455f956f0c553f0" as const;
const token = "0xdac17f958d2ee523a2206206994597c13d831ec7" as const;
const spender = "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf" as const;
const amount = 10804821n;
const block = 25967619n;

afterEach(() => vi.useRealTimers());

describe("fresh zap allowance over viem RPC transport", () => {
  it("waits for the approval block and pins the encoded allowance call", async () => {
    vi.useFakeTimers();
    const requests: Array<{ method: string; params?: unknown }> = [];
    let heads = 0;
    const client = createPublicClient({ chain: mainnet, transport: custom({
      async request(request) {
        requests.push(request);
        if (request.method === "eth_blockNumber") return `0x${(heads++ === 0 ? block - 1n : block).toString(16)}`;
        if (request.method === "eth_call") {
          const [call, at] = request.params as [{ data: `0x${string}`; to: string }, string];
          expect(at).toBe(`0x${block.toString(16)}`);
          expect(call.to.toLowerCase()).toBe(token);
          const decoded = decodeFunctionData({ abi: ERC20_APPROVAL_ABI, data: call.data });
          expect(decoded.functionName).toBe("allowance");
          expect(decoded.args?.map(value => String(value).toLowerCase())).toEqual([owner, spender]);
          return encodeAbiParameters([{ type: "uint256" }], [amount]);
        }
        throw new Error("Unexpected RPC request");
      },
    }, { retryCount: 0 }) });
    const promise = readZapAllowance({ client, owner, token, spender, minimumBlock: block, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(500);
    expect(await promise).toBe(amount);
    expect(requests.map(r => r.method)).toEqual(["eth_blockNumber", "eth_blockNumber", "eth_call"]);
  });

  it("retries a failed read but accepts a verified zero allowance", async () => {
    vi.useFakeTimers();
    const client = {
      getBlockNumber: vi.fn().mockResolvedValue(block),
      readContract: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(0n),
    };
    const promise = readZapAllowance({ client, owner, token, spender, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(500);
    expect(await promise).toBe(0n);
    expect(client.readContract).toHaveBeenCalledTimes(2);
  });

  it("bounds unresponsive RPC reads and reports unknown instead of zero", async () => {
    vi.useFakeTimers();
    const client = { getBlockNumber: vi.fn(() => new Promise<bigint>(() => {})), readContract: vi.fn() };
    const outcome = readZapAllowance({ client, owner, token, spender, signal: new AbortController().signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await outcome).message).toBe(ALLOWANCE_READ_ERROR);
    expect(client.getBlockNumber).toHaveBeenCalledTimes(3);
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it("cancels a read when its wallet context disappears", async () => {
    const controller = new AbortController();
    const client = { getBlockNumber: vi.fn(() => new Promise<bigint>(() => {})), readContract: vi.fn() };
    const outcome = readZapAllowance({ client, owner, token, spender, signal: controller.signal }).catch(error => error);
    controller.abort();
    expect((await outcome).name).toBe("AbortError");
    expect(client.readContract).not.toHaveBeenCalled();
  });
});
