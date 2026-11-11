import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getKong } from "@/app/api/kong/[op]/route";
import { GET as getMerkl } from "@/app/api/merkl/[...path]/route";
import { GET as getHistory } from "@/app/api/history/route";
import { GET as getVaults } from "@/app/api/vaults/route";
import { clearUpstreamJsonCache } from "@/lib/upstream-json-cache";

// Route handlers must keep working exactly as before, but repeated identical
// requests should reach upstream only once. Errors, invalid input and per-wallet
// Merkl data must never be cached.

const ADDRESS = "0x0000000000000000000000000000000000000001";
const OTHER_ADDRESS = "0x0000000000000000000000000000000000000002";
const CACHE_WORKER_URL = "https://cache.example/api/vaults";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

function kongRequest(search: string, op = "vault") {
  return getKong(new NextRequest(`https://yldfi.co/api/kong/${op}?${search}`), {
    params: Promise.resolve({ op }),
  });
}

function merklRequest(path: string[], search = "") {
  return getMerkl(new NextRequest(`https://yldfi.co/api/merkl/${path.join("/")}${search}`), {
    params: Promise.resolve({ path }),
  });
}

function historyRequest(search: string) {
  return getHistory(new NextRequest(`https://yldfi.co/api/history${search}`));
}

describe("proxy route upstream cache", () => {
  beforeEach(() => {
    clearUpstreamJsonCache();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CACHE_WORKER_URL", CACHE_WORKER_URL);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearUpstreamJsonCache();
  });

  it("serves repeated Kong vault requests without another upstream call", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ data: { vault: { address: ADDRESS } } })
    );

    const first = await kongRequest(`chainId=1&address=${ADDRESS}`);
    const second = await kongRequest(`chainId=1&address=${ADDRESS}`);

    expect(first.status).toBe(200);
    expect(first.headers.get("x-yld-cache")).toBe("miss");
    expect(second.headers.get("x-yld-cache")).toBe("memory");
    expect(await first.json()).toEqual({ data: { vault: { address: ADDRESS } } });
    expect(await second.json()).toEqual({ data: { vault: { address: ADDRESS } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not share Kong cache entries across different addresses", async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { variables: { address: string } };
      return jsonResponse({ data: { vault: { address: body.variables.address } } });
    });

    const first = await kongRequest(`chainId=1&address=${ADDRESS}`);
    const second = await kongRequest(`chainId=1&address=${OTHER_ADDRESS}`);

    expect(await first.json()).toEqual({ data: { vault: { address: ADDRESS } } });
    expect(await second.json()).toEqual({ data: { vault: { address: OTHER_ADDRESS } } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache Kong upstream errors", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ errors: ["boom"] }, 500));

    const first = await kongRequest(`chainId=1&address=${ADDRESS}`);
    expect(first.status).toBe(500);
    expect(await first.json()).toEqual({ error: "Kong upstream error: 500" });

    const second = await kongRequest(`chainId=1&address=${ADDRESS}`);
    expect(second.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid Kong params before touching the cache", async () => {
    const response = await kongRequest("chainId=1");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid params" });
    expect(response.headers.get("x-yld-cache")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an unknown-operation response instead of throwing for /api/kong/constructor", async () => {
    const response = await kongRequest("", "constructor");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Unknown op" });
    expect(response.headers.get("x-yld-cache")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not cache a Kong 200 reply that carries errors", async () => {
    const body = { errors: [{ message: "boom" }] };
    fetchMock.mockImplementation(async () => jsonResponse(body));

    const first = await kongRequest(`chainId=1&address=${ADDRESS}`);
    const second = await kongRequest(`chainId=1&address=${ADDRESS}`);

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(body);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(body);
    expect(first.headers.get("x-yld-cache")).toBeNull();
    expect(second.headers.get("x-yld-cache")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a Kong 200 reply with errors even when data is present", async () => {
    const body = { data: { vault: null }, errors: [{ message: "boom" }] };
    fetchMock.mockImplementation(async () => jsonResponse(body));

    const first = await kongRequest(`chainId=1&address=${ADDRESS}`);
    const second = await kongRequest(`chainId=1&address=${ADDRESS}`);

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(body);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(body);
    expect(second.headers.get("x-yld-cache")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a Kong vault reply without a vault", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ data: { vault: null } }));

    const first = await kongRequest(`chainId=1&address=${ADDRESS}`);
    const second = await kongRequest(`chainId=1&address=${ADDRESS}`);

    expect(first.status).toBe(200);
    expect(await second.json()).toEqual({ data: { vault: null } });
    expect(second.headers.get("x-yld-cache")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a Kong timeseries reply with an empty series", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ data: { timeseries: [] } })
    );

    const first = await kongRequest(`chainId=1&address=${ADDRESS}`, "tvl");
    const second = await kongRequest(`chainId=1&address=${ADDRESS}`, "tvl");

    expect(first.status).toBe(200);
    expect(await second.json()).toEqual({ data: { timeseries: [] } });
    expect(second.headers.get("x-yld-cache")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one Kong cache entry across address casings without changing upstream variables", async () => {
    const mixedCase = "0x00000000000000000000000000000000000000AA";
    fetchMock.mockImplementation(async () => jsonResponse({ data: { vault: { address: ADDRESS } } }));

    const first = await kongRequest(`chainId=1&address=${mixedCase}`);
    const second = await kongRequest(`chainId=1&address=${mixedCase.toLowerCase()}`);

    expect(first.status).toBe(200);
    expect(first.headers.get("x-yld-cache")).toBe("miss");
    expect(second.headers.get("x-yld-cache")).toBe("memory");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const sent = JSON.parse(String(init.body)) as { variables: { address: string } };
    // Only the cache key is lowercased; the caller's casing goes upstream.
    expect(sent.variables.address).toBe(mixedCase);
  });

  it("fails both concurrent callers of a rejected shared upstream call, then fetches again", async () => {
    const gate = Promise.withResolvers<Response>();
    fetchMock.mockImplementation(() => gate.promise);

    const a = kongRequest(`chainId=1&address=${ADDRESS}`);
    const b = kongRequest(`chainId=1&address=${ADDRESS}`);
    // Let both requests reach the shared in-flight producer.
    await new Promise((resolve) => setTimeout(resolve, 0));
    gate.reject(new Error("network down"));

    const [first, second] = await Promise.all([a, b]);
    expect(first.status).toBe(502);
    expect(await first.json()).toEqual({ error: "Kong proxy error" });
    expect(second.status).toBe(502);
    expect(await second.json()).toEqual({ error: "Kong proxy error" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(async () =>
      jsonResponse({ data: { vault: { address: ADDRESS } } })
    );
    const next = await kongRequest(`chainId=1&address=${ADDRESS}`);
    expect(next.status).toBe(200);
    expect(next.headers.get("x-yld-cache")).toBe("miss");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serves repeated Merkl opportunities requests from the cache", async () => {
    const path = ["v4", "opportunities"];
    const search = "?chainId=1&type=ENCOMPASSING&campaigns=true";
    fetchMock.mockImplementation(async () => jsonResponse([{ id: "opp-1" }]));

    const first = await merklRequest(path, search);
    const second = await merklRequest(path, search);

    expect(first.status).toBe(200);
    expect(first.headers.get("x-yld-cache")).toBe("miss");
    expect(second.headers.get("x-yld-cache")).toBe("memory");
    expect(await first.json()).toEqual([{ id: "opp-1" }]);
    expect(await second.json()).toEqual([{ id: "opp-1" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keys Merkl opportunities by allow-listed params regardless of order", async () => {
    const path = ["v4", "opportunities"];
    fetchMock.mockImplementation(async () => jsonResponse([{ id: "opp-1" }]));

    const first = await merklRequest(path, "?chainId=1&type=ENCOMPASSING&campaigns=true");
    const second = await merklRequest(path, "?type=ENCOMPASSING&campaigns=true&chainId=1");

    expect(first.headers.get("x-yld-cache")).toBe("miss");
    expect(second.headers.get("x-yld-cache")).toBe("memory");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a Merkl path that only starts with the opportunities prefix", async () => {
    const path = ["v4", "opportunitiesX"];
    fetchMock.mockImplementation(async () => jsonResponse([{ id: "opp-1" }]));

    const first = await merklRequest(path);
    const second = await merklRequest(path);

    expect(first.status).toBe(200);
    expect(first.headers.get("x-yld-cache")).toBeNull();
    expect(second.headers.get("x-yld-cache")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a Merkl opportunities path with extra segments", async () => {
    const path = ["v4", "opportunities", "../users", ADDRESS, "rewards"];
    fetchMock.mockImplementation(async () => jsonResponse([{ id: "opp-1" }]));

    const first = await merklRequest(path);
    const second = await merklRequest(path);

    expect(first.status).toBe(200);
    expect(first.headers.get("x-yld-cache")).toBeNull();
    expect(second.headers.get("x-yld-cache")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache Merkl opportunities with a query param outside the allow-list", async () => {
    const path = ["v4", "opportunities"];
    const search = "?chainId=1&status=LIVE";
    fetchMock.mockImplementation(async () => jsonResponse([{ id: "opp-1" }]));

    const first = await merklRequest(path, search);
    const second = await merklRequest(path, search);

    expect(first.status).toBe(200);
    expect(first.headers.get("x-yld-cache")).toBeNull();
    expect(second.headers.get("x-yld-cache")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache Merkl opportunities with a duplicated allow-listed param", async () => {
    const path = ["v4", "opportunities"];
    const search = "?chainId=1&chainId=2&type=ENCOMPASSING&campaigns=true";
    fetchMock.mockImplementation(async () => jsonResponse([{ id: "opp-1" }]));

    const first = await merklRequest(path, search);
    const second = await merklRequest(path, search);

    expect(first.status).toBe(200);
    expect(first.headers.get("x-yld-cache")).toBeNull();
    expect(second.headers.get("x-yld-cache")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache Merkl opportunities with an invalid param value", async () => {
    const path = ["v4", "opportunities"];
    fetchMock.mockImplementation(async () => jsonResponse([{ id: "opp-1" }]));

    for (const search of [
      "?chainId=abc&type=ENCOMPASSING&campaigns=true",
      "?chainId=1&type=encompassing&campaigns=true",
      "?chainId=1&type=ENCOMPASSING&campaigns=maybe",
    ]) {
      const before = fetchMock.mock.calls.length;
      const first = await merklRequest(path, search);
      const second = await merklRequest(path, search);

      expect(first.status).toBe(200);
      expect(first.headers.get("x-yld-cache")).toBeNull();
      expect(second.headers.get("x-yld-cache")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(before + 2);
    }
  });

  it("keys Merkl opportunities and fetches upstream with one canonical query", async () => {
    const path = ["v4", "opportunities"];
    fetchMock.mockImplementation(async () => jsonResponse([{ id: "opp-1" }]));

    const first = await merklRequest(path, "?chainId=1&type=ENCOMPASSING&campaigns=true");
    const second = await merklRequest(path, "?type=ENCOMPASSING&campaigns=true&chainId=1");

    expect(first.headers.get("x-yld-cache")).toBe("miss");
    expect(second.headers.get("x-yld-cache")).toBe("memory");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // What was fetched is exactly what was keyed: sorted, validated, canonical.
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://api.merkl.xyz/v4/opportunities?campaigns=true&chainId=1&type=ENCOMPASSING"
    );
  });

  it("does not let an encoded separator share the app's opportunities entry", async () => {
    const path = ["v4", "opportunities"];
    const appSearch = "?chainId=1&type=ENCOMPASSING&campaigns=true";
    // Decoded this reads as the app's own query, but the raw upstream request differs.
    const injectedSearch = "?campaigns=true%26chainId%3D1%26type%3DENCOMPASSING";
    fetchMock.mockImplementation(async () => jsonResponse([{ id: "app" }]));

    const primed = await merklRequest(path, appSearch);
    expect(primed.headers.get("x-yld-cache")).toBe("miss");

    const injected = await merklRequest(path, injectedSearch);
    expect(injected.status).toBe(200);
    expect(injected.headers.get("x-yld-cache")).toBeNull();
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      "campaigns=true%26chainId%3D1%26type%3DENCOMPASSING"
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The app's entry is untouched and still holds the app's data.
    const again = await merklRequest(path, appSearch);
    expect(again.headers.get("x-yld-cache")).toBe("memory");
    expect(await again.json()).toEqual([{ id: "app" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache an empty Merkl opportunities list", async () => {
    const path = ["v4", "opportunities"];
    const search = "?chainId=1&type=ENCOMPASSING&campaigns=true";
    fetchMock.mockImplementation(async () => jsonResponse([]));

    const first = await merklRequest(path, search);
    const second = await merklRequest(path, search);

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual([]);
    expect(await second.json()).toEqual([]);
    expect(first.headers.get("x-yld-cache")).toBeNull();
    expect(second.headers.get("x-yld-cache")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a Merkl upstream failure", async () => {
    const path = ["v4", "opportunities"];
    const search = "?chainId=1&type=ENCOMPASSING&campaigns=true";
    fetchMock.mockImplementation(async () => jsonResponse({ error: "boom" }, 503));

    const first = await merklRequest(path, search);
    const second = await merklRequest(path, search);

    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: "Merkl upstream error: 503" });
    expect(second.status).toBe(503);
    expect(second.headers.get("x-yld-cache")).toBeNull();
    // Each request tries the primary host, then the fallback host.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("never caches Merkl per-wallet rewards", async () => {
    const path = ["v4", "users", ADDRESS, "rewards"];
    fetchMock.mockImplementation(async () => jsonResponse({ rewards: [] }));

    const first = await merklRequest(path);
    const second = await merklRequest(path);

    expect(first.status).toBe(200);
    expect(first.headers.get("x-yld-cache")).toBeNull();
    expect(second.headers.get("x-yld-cache")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects Merkl paths outside the v4 API before any fetch", async () => {
    const response = await merklRequest(["v3", "opportunities"]);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden path" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches history by key and metric only", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ data: { timeseries: [{ time: 1, value: 2 }] } })
    );

    const first = await historyRequest("?key=yscvx&metric=tvl");
    const second = await historyRequest("?key=yscvx&metric=tvl");
    const otherMetric = await historyRequest("?key=yscvx&metric=pps");

    expect(first.status).toBe(200);
    expect(first.headers.get("x-yld-cache")).toBe("miss");
    expect(second.headers.get("x-yld-cache")).toBe("memory");
    expect(otherMetric.headers.get("x-yld-cache")).toBe("miss");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const response = await historyRequest("?metric=tvl");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Missing key" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns an empty history series without caching it", async () => {
    const body = { data: { timeseries: [] } };
    fetchMock.mockImplementation(async () => jsonResponse(body));

    const first = await historyRequest("?key=yscvx&metric=tvl");
    const second = await historyRequest("?key=yscvx&metric=tvl");

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(body);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(body);
    expect(second.headers.get("x-yld-cache")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a history error body without caching it", async () => {
    const body = { error: "History unavailable" };
    fetchMock.mockImplementation(async () => jsonResponse(body));

    const first = await historyRequest("?key=yscvx&metric=tvl");
    const second = await historyRequest("?key=yscvx&metric=tvl");

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(body);
    expect(second.status).toBe(200);
    expect(second.headers.get("x-yld-cache")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches the vaults payload and still fails fast without configuration", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ vaults: [] }));

    const first = await getVaults();
    const second = await getVaults();

    expect(first.status).toBe(200);
    expect(first.headers.get("x-yld-cache")).toBe("miss");
    expect(second.headers.get("x-yld-cache")).toBe("memory");
    expect(await second.json()).toEqual({ vaults: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clearUpstreamJsonCache();
    vi.stubEnv("CACHE_WORKER_URL", undefined);

    const misconfigured = await getVaults();
    expect(misconfigured.status).toBe(500);
    expect(await misconfigured.json()).toEqual({ error: "Configuration error" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a non-200 history reply", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: "nope" }, 503));

    const first = await historyRequest("?key=yscvx&metric=tvl");
    const second = await historyRequest("?key=yscvx&metric=tvl");

    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: "Failed to fetch history" });
    expect(second.status).toBe(503);
    expect(second.headers.get("x-yld-cache")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the history failure response when the fetch rejects", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    const first = await historyRequest("?key=yscvx&metric=tvl");
    expect(first.status).toBe(500);
    expect(await first.json()).toEqual({ error: "Internal server error" });

    const second = await historyRequest("?key=yscvx&metric=tvl");
    expect(second.status).toBe(500);
    expect(await second.json()).toEqual({ error: "Internal server error" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a non-200 vaults reply", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: "nope" }, 503));

    const first = await getVaults();
    const second = await getVaults();

    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: "Failed to fetch vault data" });
    expect(second.status).toBe(503);
    expect(second.headers.get("x-yld-cache")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the vaults failure response when the fetch rejects", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    expect(await (await getVaults()).json()).toEqual({ error: "Internal server error" });
    const second = await getVaults();
    expect(second.status).toBe(500);
    expect(await second.json()).toEqual({ error: "Internal server error" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a vaults error body without caching it", async () => {
    const body = { error: "Refresh failed; previous snapshot retained" };
    fetchMock.mockImplementation(async () => jsonResponse(body));

    const first = await getVaults();
    const second = await getVaults();

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(body);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(body);
    expect(second.headers.get("x-yld-cache")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns an empty vaults object without caching it", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}));

    const first = await getVaults();
    const second = await getVaults();

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({});
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({});
    expect(second.headers.get("x-yld-cache")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
