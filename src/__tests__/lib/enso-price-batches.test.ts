import { describe, expect, it, vi } from "vitest";
import { ENSO_PRICE_BATCH_SIZE, fetchPricesInBatches } from "@/lib/enso-price-batches";

const addr = (i: number) => "0x" + i.toString(16).padStart(40, "0");

describe("fetchPricesInBatches", () => {
  it("splits into batches of at most ENSO_PRICE_BATCH_SIZE and concatenates in order", async () => {
    const fetchBatch = vi.fn(async (batch: string[]) => batch.map((a) => ({ address: a })));
    const input = Array.from({ length: 120 }, (_, i) => addr(i + 1));

    const out = await fetchPricesInBatches(input, fetchBatch);

    expect(fetchBatch.mock.calls.map(([b]) => b.length)).toEqual([50, 50, 20]);
    expect(Math.max(...fetchBatch.mock.calls.map(([b]) => b.length))).toBeLessThanOrEqual(ENSO_PRICE_BATCH_SIZE);
    expect(out.map((p) => p.address)).toEqual(input);
  });

  it("dedupes addresses case-insensitively", async () => {
    const fetchBatch = vi.fn(async (batch: string[]) => batch);
    const a = addr(7);
    await fetchPricesInBatches([a, a.toUpperCase().replace("0X", "0x"), a], fetchBatch);
    expect(fetchBatch).toHaveBeenCalledTimes(1);
    expect(fetchBatch.mock.calls[0][0]).toHaveLength(1);
  });

  it("makes no call for an empty list", async () => {
    const fetchBatch = vi.fn(async () => []);
    expect(await fetchPricesInBatches([], fetchBatch)).toEqual([]);
    expect(fetchBatch).not.toHaveBeenCalled();
  });
});
