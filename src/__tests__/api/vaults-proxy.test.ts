// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetCloudflareContext } = vi.hoisted(() => ({ mockGetCloudflareContext: vi.fn() }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: mockGetCloudflareContext,
}));

import { GET } from "@/app/api/vaults/route";
import { clearUpstreamJsonCache } from "@/lib/upstream-json-cache";

const CACHE_URL = "https://cache.example.com/vaults";

beforeEach(() => {
  clearUpstreamJsonCache();
  vi.stubEnv("CACHE_WORKER_URL", CACHE_URL);
  // Outside Cloudflare (local dev) there is no context, so no service binding.
  mockGetCloudflareContext.mockReset();
  mockGetCloudflareContext.mockImplementation(() => {
    throw new Error("not running on Cloudflare");
  });
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

  it("reaches the cache worker through the service binding when it is bound", async () => {
    const payload = { ycvxcrv: { tvlUsd: 930 }, lastUpdated: "2026-11-10T12:00:00Z" };
    const bindingFetch = vi.fn(async (_request: Request) => Response.json(payload));
    mockGetCloudflareContext.mockReturnValue({ env: { CACHE_WORKER: { fetch: bindingFetch } } });
    vi.stubEnv("CACHE_WORKER_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(payload);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bindingFetch).toHaveBeenCalledTimes(1);
    const request = bindingFetch.mock.calls[0][0];
    expect(new URL(request.url).pathname).toBe("/api/vaults");
    expect(request.headers.get("content-type")).toBe("application/json");
  });

  it("prefers the service binding over the url when both are configured", async () => {
    const bindingFetch = vi.fn(async (_request: Request) => Response.json({ ycvxcrv: { tvlUsd: 1 } }));
    mockGetCloudflareContext.mockReturnValue({ env: { CACHE_WORKER: { fetch: bindingFetch } } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(bindingFetch).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the url when the context has no binding", async () => {
    mockGetCloudflareContext.mockReturnValue({ env: {} });
    const fetchMock = vi.fn(async () => Response.json({ ycvxcrv: { tvlUsd: 1 } }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(CACHE_URL, expect.anything());
  });

  describe("in local development", () => {
    const payload = { ycvxcrv: { tvlUsd: 1 } };

    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "development");
    });

    it("uses the url, not a present binding, when remote bindings are off", async () => {
      const bindingFetch = vi.fn(async (_request: Request) => Response.json(payload));
      mockGetCloudflareContext.mockReturnValue({ env: { CACHE_WORKER: { fetch: bindingFetch } } });
      vi.stubEnv("YLDFI_DEV_REMOTE_BINDINGS", "");
      const fetchMock = vi.fn(async () => Response.json(payload));
      vi.stubGlobal("fetch", fetchMock);

      const response = await GET();

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(CACHE_URL, expect.anything());
      expect(bindingFetch).not.toHaveBeenCalled();
    });

    it("uses the binding when remote bindings are on", async () => {
      const bindingFetch = vi.fn(async (_request: Request) => Response.json(payload));
      mockGetCloudflareContext.mockReturnValue({ env: { CACHE_WORKER: { fetch: bindingFetch } } });
      vi.stubEnv("YLDFI_DEV_REMOTE_BINDINGS", "1");
      vi.stubEnv("CACHE_WORKER_URL", "");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const response = await GET();

      expect(response.status).toBe(200);
      expect(bindingFetch).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("uses the binding in production even with the url set and remote bindings off", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("YLDFI_DEV_REMOTE_BINDINGS", "");
    const bindingFetch = vi.fn(async (_request: Request) => Response.json({ ycvxcrv: { tvlUsd: 1 } }));
    mockGetCloudflareContext.mockReturnValue({ env: { CACHE_WORKER: { fetch: bindingFetch } } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(bindingFetch).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
