import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichSimulationPrices, validSimulationUsd } from "@/lib/simulation-pricing";

const row = (address = "0xtoken", dollarValue?: string, rawAmount = "2000000000000000000") =>
  ({ address, rawAmount, decimals: 18, dollarValue });
const deps = () => ({
  fetchPrice: vi.fn(async (_address: string): Promise<number | undefined> => undefined),
  lookupVault: vi.fn(async (_address: string): Promise<{ underlying: string; underlyingDecimals: number } | null> => null),
  convertToAssets: vi.fn(async (_address: string, raw: string) => BigInt(raw)),
  timeoutMs: 4000,
});
afterEach(() => vi.useRealTimers());

describe("simulation pricing", () => {
  it.each([undefined, null, "", "0", "-2", "NaN", "Infinity", NaN, Infinity])("rejects unusable USD %s", value => {
    expect(validSimulationUsd(value)).toBeUndefined();
  });

  it("replaces a stale nonzero Tenderly value with Enso", async () => {
    const d = deps(); d.fetchPrice.mockResolvedValue(3);
    expect((await enrichSimulationPrices([row("0xtoken", "100")], d))[0].dollarValue).toBe("6");
  });

  it("preserves valid Tenderly pricing when Enso fails, and removes unpriced zero values", async () => {
    const d = deps(); d.fetchPrice.mockRejectedValue(new Error("upstream failed"));
    const result = await enrichSimulationPrices([row("0xa", "42"), row("0xb", "0")], d);
    expect(result.map(r => r.dollarValue)).toEqual(["42", undefined]);
  });

  it("does not substitute CVX prices for unpriced pxCVX", async () => {
    const d = deps(); d.fetchPrice.mockImplementation(async address => address === "0xcvx" ? 2 : undefined);
    const result = await enrichSimulationPrices([row("0xcvx"), row("0xpxcvx")], d);
    expect(result.map(r => r.dollarValue)).toEqual(["4", undefined]);
  });

  it("prices different vault amounts at NAV with underlying decimals and a deduplicated price lookup", async () => {
    const d = deps();
    d.lookupVault.mockResolvedValue({ underlying: "0xusdc", underlyingDecimals: 6 });
    d.fetchPrice.mockImplementation(async address => address === "0xusdc" ? 1 : 99);
    d.convertToAssets.mockImplementation(async (_address, raw) => BigInt(raw) / 10n ** 12n * 2n);
    const result = await enrichSimulationPrices([row("0xvault"), row("0xvault", undefined, "3000000000000000000")], d);
    expect(result.map(r => r.dollarValue)).toEqual(["4", "6"]);
    expect(d.fetchPrice).toHaveBeenCalledTimes(2);
    expect(d.convertToAssets).toHaveBeenCalledTimes(2);
  });

  it("keeps direct Enso pricing if vault conversion fails", async () => {
    const d = deps(); d.lookupVault.mockResolvedValue({ underlying: "0xcvx", underlyingDecimals: 18 });
    d.fetchPrice.mockResolvedValue(3); d.convertToAssets.mockRejectedValue(new Error("rpc failed"));
    expect((await enrichSimulationPrices([row()], d))[0].dollarValue).toBe("6");
  });

  it("keeps successful pricing when another lookup hangs, without restarting the deadline", async () => {
    vi.useFakeTimers();
    const d = deps();
    d.fetchPrice.mockImplementation(address => address === "0xslow" ? new Promise(() => {}) : Promise.resolve(3));
    const result = enrichSimulationPrices([row("0xfast"), row("0xslow", "0")], d);
    await vi.advanceTimersByTimeAsync(4001);
    expect((await result).map(r => r.dollarValue)).toEqual(["6", undefined]);
  });

  it("accepts a price slower than the old 1.5-second timeout", async () => {
    vi.useFakeTimers();
    const d = deps(); d.fetchPrice.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(3), 1800)));
    const result = enrichSimulationPrices([row()], d);
    await vi.advanceTimersByTimeAsync(1801);
    expect((await result)[0].dollarValue).toBe("6");
  });
});
