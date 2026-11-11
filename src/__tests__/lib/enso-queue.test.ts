// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetQuoteData, mockGetRouteData } = vi.hoisted(() => ({
  mockGetQuoteData: vi.fn(),
  mockGetRouteData: vi.fn(),
}));

vi.mock("@ensofinance/sdk", () => ({
  EnsoClient: class MockEnsoClient {
    getQuoteData = mockGetQuoteData;
    getRouteData = mockGetRouteData;
  },
}));

const USER = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const CVX = "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B";

const QUOTE = {
  amountOut: 49277653475340641617n,
  priceImpact: 12,
  route: [{ action: "swap", protocol: "uniswap-v3", tokenIn: [USDC], tokenOut: [CVX] }],
};

const ROUTE = {
  tx: { to: "0xrouter", data: "0x", value: 0n },
  gas: 1n,
  amountOut: 42n,
  priceImpact: 5,
  route: [{ action: "swap", protocol: "curve", tokenIn: [USDC], tokenOut: [CVX] }],
};

type EnsoModule = typeof import("@/lib/enso");

/** A 429 as the Enso SDK surfaces it. */
const rateLimited = () => Object.assign(new Error("Too Many Requests"), { statusCode: 429 });

const quote = (enso: EnsoModule, amountIn = "100000000") =>
  enso.fetchQuote({ fromAddress: USER, tokenIn: USDC, tokenOut: CVX, amountIn });

const route = (enso: EnsoModule, amountIn = "100000000") =>
  enso.fetchRoute({ fromAddress: USER, tokenIn: USDC, tokenOut: CVX, amountIn });

/** A fresh module with `env` applied: enso reads its settings once, at import. */
const importEnsoWithEnv = async (env: Record<string, string>): Promise<EnsoModule> => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  return import("@/lib/enso");
};

describe("Enso call queue", () => {
  let enso: EnsoModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockGetQuoteData.mockResolvedValue(QUOTE);
    mockGetRouteData.mockResolvedValue(ROUTE);
    enso = await import("@/lib/enso");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("retries a 429 with the 250 / 500 / 1000 ms backoff ladder", async () => {
    mockGetQuoteData
      .mockRejectedValueOnce(rateLimited())
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce(QUOTE);

    const result = quote(enso);

    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetQuoteData).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(mockGetQuoteData).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(mockGetQuoteData).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(499);
    expect(mockGetQuoteData).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(mockGetQuoteData).toHaveBeenCalledTimes(3);

    await expect(result).resolves.toEqual({
      amountOut: "49277653475340641617",
      priceImpact: 12,
      route: [{ action: "swap", protocol: "uniswap-v3", tokenIn: [USDC], tokenOut: [CVX] }],
    });
    expect(mockGetRouteData).not.toHaveBeenCalled();
  });

  it("does not retry a non-429 error in the queue: fetchQuote falls back to /route once", async () => {
    mockGetQuoteData.mockRejectedValue(new Error("API Error: boom"));

    const result = await quote(enso);

    expect(mockGetQuoteData).toHaveBeenCalledTimes(1);
    expect(mockGetRouteData).toHaveBeenCalledTimes(1);
    expect(result.amountOut).toBe("42");
  });

  it("a failed call does not poison later calls", async () => {
    mockGetQuoteData.mockRejectedValueOnce(new Error("API Error: boom"));
    mockGetRouteData.mockRejectedValueOnce(new Error("API Error: route boom"));

    await expect(quote(enso)).rejects.toThrow("route boom");

    const result = await quote(enso);
    expect(result.amountOut).toBe("49277653475340641617");
    expect(mockGetQuoteData).toHaveBeenCalledTimes(2);
  });

  it("rejects after the per-attempt timeout when a call never settles", async () => {
    mockGetQuoteData.mockReturnValue(new Promise(() => {}));
    mockGetRouteData.mockReturnValue(new Promise(() => {}));

    const result = quote(enso);
    const outcome = expect(result).rejects.toThrow(/timeout/);

    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(20_000);
    await outcome;
  });

  it("frees the queue when a call times out", async () => {
    mockGetQuoteData.mockImplementationOnce(() => new Promise(() => {}));

    const stalled = quote(enso);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetQuoteData).toHaveBeenCalledTimes(1);

    const second = quote(enso);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(mockGetQuoteData).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(mockGetQuoteData).toHaveBeenCalledTimes(2);
    await expect(second).resolves.toMatchObject({ amountOut: "49277653475340641617" });

    // The stalled call now falls back to /route, which the mock resolves.
    await expect(stalled).resolves.toMatchObject({ amountOut: "42" });
  });

  it.each(["", "abc", "0"])(
    "does not time out a 50 ms call when ENSO_CALL_TIMEOUT_MS is %j",
    async (value) => {
      enso = await importEnsoWithEnv({ ENSO_CALL_TIMEOUT_MS: value });
      mockGetQuoteData.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(QUOTE), 50)),
      );

      const result = quote(enso);
      await vi.advanceTimersByTimeAsync(50);

      await expect(result).resolves.toMatchObject({ amountOut: "49277653475340641617" });
      expect(mockGetRouteData).not.toHaveBeenCalled();
    },
  );

  it("still makes the first attempt when ENSO_MAX_RETRIES is not a number", async () => {
    enso = await importEnsoWithEnv({ ENSO_MAX_RETRIES: "abc" });

    await expect(quote(enso)).resolves.toMatchObject({ amountOut: "49277653475340641617" });
    expect(mockGetQuoteData).toHaveBeenCalledTimes(1);
    expect(mockGetRouteData).not.toHaveBeenCalled();
  });

  it("still retries a 429 when ENSO_MAX_RETRIES is empty", async () => {
    enso = await importEnsoWithEnv({ ENSO_MAX_RETRIES: "" });
    mockGetQuoteData.mockRejectedValueOnce(rateLimited()).mockResolvedValueOnce(QUOTE);

    const result = quote(enso);

    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetQuoteData).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(250);
    expect(mockGetQuoteData).toHaveBeenCalledTimes(2);

    await expect(result).resolves.toMatchObject({ amountOut: "49277653475340641617" });
    expect(mockGetRouteData).not.toHaveBeenCalled();
  });

  it("throws after four 429s, with 250 / 500 / 1000 ms between attempts", async () => {
    mockGetRouteData.mockRejectedValue(rateLimited());

    const result = route(enso);
    const outcome = expect(result).rejects.toThrow("Too Many Requests");

    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetRouteData).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(mockGetRouteData).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockGetRouteData).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(499);
    expect(mockGetRouteData).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockGetRouteData).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(999);
    expect(mockGetRouteData).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockGetRouteData).toHaveBeenCalledTimes(4);

    await outcome;
    expect(mockGetRouteData).toHaveBeenCalledTimes(4);
  });

  it("runs three queued callers in FIFO order", async () => {
    const started: string[] = [];
    mockGetQuoteData.mockImplementation((request: { amountIn: string[] }) => {
      started.push(request.amountIn[0]);
      return new Promise((resolve) => setTimeout(() => resolve(QUOTE), 10));
    });

    const callers = [quote(enso, "1"), quote(enso, "2"), quote(enso, "3")];

    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["1"]);

    await vi.advanceTimersByTimeAsync(10);
    expect(started).toEqual(["1", "2"]);

    await vi.advanceTimersByTimeAsync(10);
    expect(started).toEqual(["1", "2", "3"]);

    await vi.runAllTimersAsync();
    await expect(Promise.all(callers)).resolves.toHaveLength(3);
  });
});
