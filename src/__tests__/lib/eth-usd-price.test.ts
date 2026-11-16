import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";

import { readEthUsdPrice } from "@/lib/eth-usd-price";

describe("readEthUsdPrice", () => {
  it("returns the latest Chainlink answer scaled to dollars", async () => {
    const readContract = vi.fn().mockResolvedValue([0n, 312345678900n, 0n, 0n, 0n]);
    const client = { readContract } as unknown as PublicClient;

    await expect(readEthUsdPrice(client)).resolves.toBe(3123.456789);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "latestRoundData" }),
    );
  });

  it("rejects when the Chainlink read fails", async () => {
    const client = {
      readContract: vi.fn().mockRejectedValue(new Error("rpc down")),
    } as unknown as PublicClient;

    await expect(readEthUsdPrice(client)).rejects.toThrow("rpc down");
  });
});
