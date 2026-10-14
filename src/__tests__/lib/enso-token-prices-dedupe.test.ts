import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetMultiplePriceData } = vi.hoisted(() => ({
  mockGetMultiplePriceData: vi.fn(),
}));

vi.mock("@ensofinance/sdk", () => ({
  EnsoClient: class MockEnsoClient {
    getMultiplePriceData = mockGetMultiplePriceData;
  },
}));

import { fetchTokenPrices } from "@/lib/enso";

describe("fetchTokenPrices in-flight dedupe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shares one request across concurrent identical calls regardless of order/case", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    const fetchMock = vi.fn(() => pending);
    vi.stubGlobal("fetch", fetchMock);

    const a = fetchTokenPrices(["0xAA", "0xBB"]);
    const b = fetchTokenPrices(["0xbb", "0xaa"]);
    resolve(new Response(JSON.stringify([{ chainId: 1, address: "0xAA", price: 2, decimals: 18 }])));

    const [first, second] = await Promise.all([a, b]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it("does not share requests across sequential calls", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([])));
    vi.stubGlobal("fetch", fetchMock);

    await fetchTokenPrices(["0xAA"]);
    await fetchTokenPrices(["0xAA"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
