import type { Address, PublicClient } from "viem";
import { ERC20_APPROVAL_ABI } from "@/lib/abis";

export const ALLOWANCE_READ_ERROR = "Unable to verify token approval. Please try again.";

// Pin the call to a freshly observed block. Receipt and eth_call requests can
// reach different nodes in a fallback/load-balanced RPC service.
export async function readZapAllowance({ client, owner, token, spender, minimumBlock, signal }: {
  client: Pick<PublicClient, "getBlockNumber" | "readContract">;
  owner: Address;
  token: Address;
  spender: Address;
  minimumBlock?: bigint;
  signal: AbortSignal;
}): Promise<bigint> {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        (async () => {
          const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
          signal.throwIfAborted();
          if (minimumBlock !== undefined && blockNumber < minimumBlock) throw new Error("RPC behind approval block");
          const allowance = await client.readContract({
            address: token, abi: ERC20_APPROVAL_ABI, functionName: "allowance",
            args: [owner, spender], blockNumber,
          });
          if (typeof allowance !== "bigint") throw new Error("Invalid allowance response");
          return allowance;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Allowance read timed out")), 3_000);
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } catch {
      signal.throwIfAborted();
      if (attempt === 2) throw new Error(ALLOWANCE_READ_ERROR);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(ALLOWANCE_READ_ERROR);
}
