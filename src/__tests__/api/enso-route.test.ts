import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetBundleData, mockGetQuoteData, mockGetMultiplePriceData, mockGetRouteData, mockGetTokenData, mockGetBalances } = vi.hoisted(() => ({
  mockGetBundleData: vi.fn(),
  mockGetQuoteData: vi.fn(),
  mockGetMultiplePriceData: vi.fn(),
  mockGetRouteData: vi.fn(),
  mockGetTokenData: vi.fn(),
  mockGetBalances: vi.fn(),
}));

const { mockGetCloudflareContext } = vi.hoisted(() => ({
  mockGetCloudflareContext: vi.fn(),
}));

// No Cloudflare context by default: the routes fall back to in-memory limiting.
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: mockGetCloudflareContext,
}));

vi.mock("@ensofinance/sdk", () => ({
  EnsoClient: class MockEnsoClient {
    getBundleData = mockGetBundleData;
    getQuoteData = mockGetQuoteData;
    getMultiplePriceData = mockGetMultiplePriceData;
    getRouteData = mockGetRouteData;
    getTokenData = mockGetTokenData;
    getBalances = mockGetBalances;
  },
}));

import { POST } from "@/app/api/enso/[method]/route";
import { clearMemoryEnsoPrices } from "@/lib/enso-prices-cache";

function request(body: Record<string, unknown>, origin = "https://yldfi.co", method = "bundle"): Request {
  return new Request(`https://yldfi.co/api/enso/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify(body),
  });
}

const call = (method: string, body: Record<string, unknown>) =>
  POST(request(body) as never, { params: Promise.resolve({ method }) });

describe("Enso API route boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMemoryEnsoPrices();
    vi.stubEnv("ENSO_API_KEY", "test-key");
    mockGetCloudflareContext.mockImplementation(() => {
      throw new Error("no cf context");
    });
  });

  it("rejects public raw bundle actions before calling Enso", async () => {
    const response = await POST(
      request({
        fromAddress: "0x1234567890123456789012345678901234567890",
        actions: [],
      }) as never,
      { params: Promise.resolve({ method: "bundle" }) }
    );

    await expect(response.json()).resolves.toEqual({
      error: "Raw Enso bundle actions are disabled; use /api/enso/intent",
    });
    expect(response.status).toBe(410);
    expect(mockGetBundleData).not.toHaveBeenCalled();
  });

  it("rejects unknown methods without calling Enso", async () => {
    for (const method of ["unknown", "swap", "", "ROUTE"]) {
      const response = await POST(
        request({}, "https://yldfi.co", method) as never,
        { params: Promise.resolve({ method }) },
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: `Unknown method: ${method}` });
    }
    expect(mockGetBundleData).not.toHaveBeenCalled();
    expect(mockGetRouteData).not.toHaveBeenCalled();
  });

  it("reflects an allowed origin and falls back to the canonical origin otherwise", async () => {
    const allowed = await POST(
      request({}, "https://www.yldfi.co") as never,
      { params: Promise.resolve({ method: "bundle" }) },
    );
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://www.yldfi.co");

    const unknown = await POST(
      request({}, "https://attacker.example") as never,
      { params: Promise.resolve({ method: "bundle" }) },
    );
    expect(unknown.headers.get("Access-Control-Allow-Origin")).toBe("https://yldfi.co");
  });

  it("refuses cross-site browser requests before the rate limit and any Enso call", async () => {
    const limit = vi.fn();
    mockGetCloudflareContext.mockReturnValue({ env: { RL_ENSO: { limit } } });

    const response = await POST(
      new Request("https://yldfi.co/api/enso/quote", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({}),
      }) as never,
      { params: Promise.resolve({ method: "quote" }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://yldfi.co");
    expect(limit).not.toHaveBeenCalled();
    expect(mockGetQuoteData).not.toHaveBeenCalled();
    expect(mockGetBundleData).not.toHaveBeenCalled();
  });

  it("keeps serving header-less requests", async () => {
    const response = await POST(
      new Request("https://yldfi.co/api/enso/bundle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fromAddress: "0x1234567890123456789012345678901234567890", actions: [] }),
      }) as never,
      { params: Promise.resolve({ method: "bundle" }) },
    );

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      error: "Raw Enso bundle actions are disabled; use /api/enso/intent",
    });
    expect(mockGetBundleData).not.toHaveBeenCalled();
  });

  describe("quote", () => {
    const USER = "0x1234567890123456789012345678901234567890";
    const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const CVX = "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B";
    const quote = (body: Record<string, unknown>) =>
      POST(request(body) as never, { params: Promise.resolve({ method: "quote" }) });

    it("returns the quoter's estimate and no transaction", async () => {
      mockGetQuoteData.mockResolvedValue({
        amountOut: 49277653475340641617n,
        priceImpact: 12,
        route: [{ action: "swap", protocol: "uniswap-v3", tokenIn: [USDC], tokenOut: [CVX] }],
      });

      const response = await quote({ fromAddress: USER, tokenIn: [USDC], tokenOut: [CVX], amountIn: ["100000000"], ignoreAggregators: ["0x"] });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({
        amountOut: "49277653475340641617",
        priceImpact: 12,
        route: [{ action: "swap", protocol: "uniswap-v3", tokenIn: [USDC], tokenOut: [CVX] }],
      });
      expect(json).not.toHaveProperty("tx");
      expect(mockGetQuoteData).toHaveBeenCalledWith(expect.objectContaining({ chainId: 1, tokenIn: [USDC], tokenOut: [CVX], amountIn: ["100000000"], ignoreAggregators: ["0x"] }));
    });

    it("omits priceImpact when the quoter returns null", async () => {
      mockGetQuoteData.mockResolvedValue({
        amountOut: 49277653475340641617n,
        priceImpact: null,
        route: [{ action: "swap", protocol: "uniswap-v3", tokenIn: [USDC], tokenOut: [CVX] }],
      });

      const response = await quote({ fromAddress: USER, tokenIn: [USDC], tokenOut: [CVX], amountIn: ["100000000"] });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        amountOut: "49277653475340641617",
        route: [{ action: "swap", protocol: "uniswap-v3", tokenIn: [USDC], tokenOut: [CVX] }],
      });
      expect(body).not.toHaveProperty("priceImpact");
    });

    it.each([
      ["multi-token arrays", { fromAddress: USER, tokenIn: [USDC, CVX], tokenOut: [CVX], amountIn: ["1", "2"] }],
      ["a bad address", { fromAddress: USER, tokenIn: ["0xnotanaddress"], tokenOut: [CVX], amountIn: ["1"] }],
      ["a zero amount", { fromAddress: USER, tokenIn: [USDC], tokenOut: [CVX], amountIn: ["0"] }],
      ["a missing sender", { tokenIn: [USDC], tokenOut: [CVX], amountIn: ["1"] }],
      ["non-string aggregator names", { fromAddress: USER, tokenIn: [USDC], tokenOut: [CVX], amountIn: ["1"], ignoreAggregators: [1] }],
    ])("rejects %s before calling Enso", async (_label, body) => {
      const response = await quote(body);
      expect(response.status).toBe(400);
      expect(mockGetQuoteData).not.toHaveBeenCalled();
    });

    it("strips a URL from a failed quote so the key in its path never reaches the browser", async () => {
      mockGetQuoteData.mockRejectedValue(
        new Error("fetch failed for https://rpc.example.invalid/v2/abcdef123 (timeout)")
      );

      const response = await quote({ fromAddress: USER, tokenIn: [USDC], tokenOut: [CVX], amountIn: ["100000000"] });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "fetch failed for rpc.example.invalid (timeout)",
      });
    });

    it("returns an upstream quote error's wording unchanged when it carries no URL", async () => {
      mockGetQuoteData.mockRejectedValue(
        Object.assign(new Error("Swap not found for A -> B"), { statusCode: 404 })
      );

      const response = await quote({ fromAddress: USER, tokenIn: [USDC], tokenOut: [CVX], amountIn: ["100000000"] });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Swap not found for A -> B" });
    });

    it("returns 429 without calling Enso when the shared limiter rejects the request", async () => {
      mockGetCloudflareContext.mockReturnValue({
        env: { RL_ENSO: { limit: vi.fn().mockResolvedValue({ success: false }) } },
      });

      const response = await quote({ fromAddress: USER, tokenIn: [USDC], tokenOut: [CVX], amountIn: ["100000000"] });

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toEqual({ error: "Rate limit exceeded" });
      expect(mockGetQuoteData).not.toHaveBeenCalled();
    });
  });

  describe("prices", () => {
    const addr = (i: number) => "0x" + i.toString(16).padStart(40, "0");
    const prices = (addresses: unknown) =>
      POST(request({ addresses }) as never, { params: Promise.resolve({ method: "prices" }) });

    it("batches large address lists so the Enso GET stays under the URL limit (was HTTP 431)", async () => {
      mockGetMultiplePriceData.mockImplementation(async ({ addresses }: { addresses: string[] }) =>
        addresses.map((address) => ({ chainId: 1, address, price: 1, decimals: 18 })));
      const input = Array.from({ length: 120 }, (_, i) => addr(i + 1));

      const response = await prices(input);

      expect(response.status).toBe(200);
      expect(mockGetMultiplePriceData.mock.calls.map(([p]) => p.addresses.length)).toEqual([50, 50, 20]);
      expect(((await response.json()) as Array<{ address: string }>).map((p) => p.address)).toEqual(input);
    });

    it.each([
      ["a non-array", "0xabc"],
      ["a bad address", ["0xnotanaddress"]],
      ["more than 500 addresses", Array.from({ length: 501 }, (_, i) => addr(i + 1))],
    ])("rejects %s before calling Enso", async (_label, addresses) => {
      const response = await prices(addresses);
      expect(response.status).toBe(400);
      expect(mockGetMultiplePriceData).not.toHaveBeenCalled();
    });

    it("serves a burst of identical requests from cache after one upstream fan-out", async () => {
      mockGetMultiplePriceData.mockImplementation(async ({ addresses }: { addresses: string[] }) =>
        addresses.map((address) => ({ chainId: 1, address, price: 1, decimals: 18 })));
      const input = Array.from({ length: 120 }, (_, i) => addr(i + 1));

      const first = await prices(input);
      expect(first.headers.get("X-Enso-Price-Cache")).toBe("miss");
      expect(mockGetMultiplePriceData).toHaveBeenCalledTimes(3);

      const second = await prices(input);
      expect(second.headers.get("X-Enso-Price-Cache")).toBe("hit");
      expect(mockGetMultiplePriceData).toHaveBeenCalledTimes(3);
      await expect(second.json()).resolves.toEqual(await first.json());
    });

    it("treats reordered and re-cased addresses as the same cache entry", async () => {
      mockGetMultiplePriceData.mockImplementation(async ({ addresses }: { addresses: string[] }) =>
        addresses.map((address) => ({ chainId: 1, address, price: 1, decimals: 18 })));
      const input = [addr(10), addr(11), addr(12)];

      await prices(input);
      await prices([input[2].toUpperCase(), input[0], input[1]]);

      expect(mockGetMultiplePriceData).toHaveBeenCalledTimes(1);
    });

    it("collapses concurrent identical requests onto a single upstream fan-out", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      mockGetMultiplePriceData.mockImplementation(async ({ addresses }: { addresses: string[] }) => {
        await gate;
        return addresses.map((address) => ({ chainId: 1, address, price: 1, decimals: 18 }));
      });

      const input = [addr(10), addr(11)];
      const first = prices(input);
      const second = prices(input);
      release();
      const [a, b] = await Promise.all([first, second]);

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(mockGetMultiplePriceData).toHaveBeenCalledTimes(1);
    });
  });

  describe("route", () => {
    it("retires the raw route method without calling Enso", async () => {
      const response = await call("route", {
        fromAddress: "0x1234567890123456789012345678901234567890",
        tokenIn: ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
        tokenOut: ["0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B"],
        amountIn: ["100000000"],
        slippage: "100",
      });

      await expect(response.json()).resolves.toEqual({
        error: "Raw Enso routes are disabled; use /api/enso/intent",
      });
      expect(response.status).toBe(410);
      expect(mockGetRouteData).not.toHaveBeenCalled();
    });
  });

  describe("tokens", () => {
    it("forwards the app's mainnet base token list request", async () => {
      mockGetTokenData.mockResolvedValue({ data: [], meta: {} });

      const response = await call("tokens", { type: "base", includeMetadata: true });

      expect(response.status).toBe(200);
      expect(mockGetTokenData).toHaveBeenCalledWith(
        expect.objectContaining({ chainId: 1, type: "base", includeMetadata: true }),
      );
    });

    it.each([
      ["a non-mainnet chain", { chainId: 137 }],
      ["an unknown type", { type: "other" }],
      ["a zero page", { page: 0 }],
      ["a fractional page", { page: 1.5 }],
      ["a string page", { page: "2" }],
      ["a page past the bound", { page: 101 }],
      ["a non-boolean includeMetadata", { includeMetadata: "yes" }],
    ])("rejects %s before calling Enso", async (_label, body) => {
      const response = await call("tokens", body);
      expect(response.status).toBe(400);
      expect(mockGetTokenData).not.toHaveBeenCalled();
    });
  });

  describe("balances", () => {
    it("forwards a valid address for the mainnet EOA balance lookup", async () => {
      mockGetBalances.mockResolvedValue([]);

      const response = await call("balances", {
        eoaAddress: "0x1234567890123456789012345678901234567890",
      });

      expect(response.status).toBe(200);
      expect(mockGetBalances).toHaveBeenCalledWith(
        expect.objectContaining({ chainId: 1, useEoa: true }),
      );
    });

    it.each([
      ["a missing address", {}],
      ["a short address", { eoaAddress: "0x123" }],
      ["a non-string address", { eoaAddress: 5 }],
    ])("rejects %s before calling Enso", async (_label, body) => {
      const response = await call("balances", body);
      expect(response.status).toBe(400);
      expect(mockGetBalances).not.toHaveBeenCalled();
    });
  });
});
