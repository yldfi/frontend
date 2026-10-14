import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetBundleData, mockGetQuoteData, mockGetMultiplePriceData } = vi.hoisted(() => ({
  mockGetBundleData: vi.fn(),
  mockGetQuoteData: vi.fn(),
  mockGetMultiplePriceData: vi.fn(),
}));

vi.mock("@ensofinance/sdk", () => ({
  EnsoClient: class MockEnsoClient {
    getBundleData = mockGetBundleData;
    getQuoteData = mockGetQuoteData;
    getMultiplePriceData = mockGetMultiplePriceData;
  },
}));

import { POST } from "@/app/api/enso/[method]/route";
import { clearMemoryEnsoPrices } from "@/lib/enso-prices-cache";

function request(body: Record<string, unknown>): Request {
  return new Request("https://yldfi.co/api/enso/bundle", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://yldfi.co",
    },
    body: JSON.stringify(body),
  });
}

describe("Enso API route boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMemoryEnsoPrices();
    vi.stubEnv("ENSO_API_KEY", "test-key");
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
});
