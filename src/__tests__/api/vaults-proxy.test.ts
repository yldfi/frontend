// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/vaults/route";
import { clearUpstreamJsonCache } from "@/lib/upstream-json-cache";

const CACHE_URL = "https://cache.example.com/vaults";

beforeEach(() => {
  clearUpstreamJsonCache();
  vi.stubEnv("CACHE_WORKER_URL", CACHE_URL);
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("GET /api/vaults", () => {
  it("reports a configuration error when the cache worker url is unset", async () => {
    vi.stubEnv("CACHE_WORKER_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Configuration error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes the cache worker payload through with a CDN cache header", async () => {
    const payload = { ycvxcrv: { tvlUsd: 930 }, lastUpdated: "2026-11-10T12:00:00Z" };
    const fetchMock = vi.fn(async () => Response.json(payload));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();

    expect(fetchMock).toHaveBeenCalledWith(CACHE_URL, expect.objectContaining({
      headers: { "Content-Type": "application/json" },
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(payload);
    expect(response.headers.get("cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=120");
  });

  it.each([404, 502, 503])("passes an upstream %i through", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status })));

    const response = await GET();

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: "Failed to fetch vault data" });
  });

  it("reports a server error when the cache worker is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("network down"))));

    const response = await GET();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Internal server error" });
  });
});
