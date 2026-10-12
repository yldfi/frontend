import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichSimulationPrices, fillMissingSimulationUsd, validSimulationUsd } from "@/lib/simulation-pricing";

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

describe("fillMissingSimulationUsd", () => {
  const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
  const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
  const YSCVX = "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e";
  const YSCVXCRV = "0xCa960E6DF1150100586c51382f619efCCcF72706";
  const ACRV = "0x2b95A1Dcc3D405535f9ed33c219ab38E8d7e0884";
  const change = (type: "send" | "receive" | "deposit", address: string, amount: number, decimals: number, dollarValue?: string) => ({
    type, address, decimals, dollarValue, rawAmount: BigInt(Math.round(amount * 10 ** decimals)).toString(),
  });
  const usd = (rows: { dollarValue?: string }[]) => rows.map(r => (r.dollarValue === undefined ? undefined : Number(Number(r.dollarValue).toFixed(2))));

  it("fills the unpriced receive row for a 6-decimal stablecoin → vault zap (22 Sep USDT → ysCVX)", () => {
    const out = fillMissingSimulationUsd([
      change("send", USDT, 48.080092, 6, "48.07"),
      change("receive", YSCVX.toLowerCase(), 23.502499, 18),
    ], {
      input: { address: USDT, amount: 48.080092, usd: 48.05 },
      output: { address: YSCVX, amount: 23.502499, usd: 47.69 },
    });
    expect(usd(out)).toEqual([48.07, 47.69]);
  });

  it("scales by the simulated amount when it differs from the quote", () => {
    const out = fillMissingSimulationUsd([change("receive", YSCVXCRV, 10.5, 18)], {
      input: { address: ETH, amount: 0.01, usd: 25.3 },
      output: { address: YSCVXCRV, amount: 150, usd: 24.75 },
    });
    expect(usd(out)).toEqual([1.73]);
  });

  it("fills a 6-decimal output for a vault → stablecoin zap out", () => {
    const out = fillMissingSimulationUsd([
      change("send", YSCVX, 10, 18),
      change("receive", USDC, 20.85, 6),
    ], {
      input: { address: YSCVX, amount: 10, usd: 20.91 },
      output: { address: USDC, amount: 20.86, usd: 20.855 },
    });
    expect(usd(out)).toEqual([20.91, 20.85]);
  });

  it("fills native ETH sends", () => {
    const out = fillMissingSimulationUsd([change("send", ETH.toLowerCase(), 0.5, 18)], {
      input: { address: ETH, amount: 0.5, usd: 1264.32 },
      output: { address: YSCVX, amount: 600, usd: 1255 },
    });
    expect(usd(out)).toEqual([1264.32]);
  });

  it("never overwrites a row the simulation already priced (16 Sep aCRV mispricing stays visible)", () => {
    const out = fillMissingSimulationUsd([
      change("send", ACRV, 5.164612, 18, "8.21"),
      change("receive", YSCVXCRV, 10.485475, 18, "1.50"),
    ], {
      input: { address: ACRV, amount: 5.164612, usd: 1.73 },
      output: { address: YSCVXCRV, amount: 10.485475, usd: 1.73 },
    });
    expect(usd(out)).toEqual([8.21, 1.5]);
  });

  it("replaces unusable zero or invalid values", () => {
    const out = fillMissingSimulationUsd([change("receive", YSCVX, 1, 18, "0")], {
      input: { address: USDT, amount: 2, usd: 2 },
      output: { address: YSCVX, amount: 1, usd: 2.09 },
    });
    expect(usd(out)).toEqual([2.09]);
  });

  it("leaves rows alone that are not the quote's input/output or are not send/receive", () => {
    const rows = [
      change("receive", "0x000000000000000000000000000000000000dEaD", 1, 18),
      change("deposit", YSCVX, 1, 18),
      change("send", YSCVX, 1, 18),
    ];
    const out = fillMissingSimulationUsd(rows, {
      input: { address: USDT, amount: 1, usd: 1 },
      output: { address: YSCVX, amount: 1, usd: 2.09 },
    });
    expect(usd(out)).toEqual([undefined, undefined, undefined]);
  });

  it.each([
    ["no quote USD", { usd: null, amount: 1 }],
    ["zero quote amount", { usd: 2.09, amount: 0 }],
  ])("stays blank with %s", (_label, leg) => {
    const out = fillMissingSimulationUsd([change("receive", YSCVX, 1, 18)], {
      input: { address: USDT, amount: 1, usd: 1 },
      output: { address: YSCVX, ...leg },
    });
    expect(usd(out)).toEqual([undefined]);
  });
});
