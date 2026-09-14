import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useVaultTvlHistory } from "@/hooks/useYearnHistory";
import type { ReactNode } from "react";
vi.unmock("@tanstack/react-query");

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("tracked vault history", () => {
  it.each([
    ["yscvgcvx", "0x8ED5AB1BA2b2E434361858cBD3CA9f374e8b0359"],
    ["yscvxcrv", "0xCa960E6DF1150100586c51382f619efCCcF72706"],
    ["yscvx", "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e"],
  ])("reads %s from yldfi without filling zero or missing values", async (key, address) => {
    const points = [100, 0, null, 200].map((value, i) => ({ time: 1788912000 + i * 86400, value }));
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: { timeseries: points } }) }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useVaultTvlHistory(address), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(`/api/history?key=${key}&metric=tvl&version=2`);
    expect(result.current.data).toEqual(points);
    client.clear();
  });
});
