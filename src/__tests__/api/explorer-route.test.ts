// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// No KV in tests: the route's getKV() catches this and returns null.
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("no cf");
  },
}));

import { GET } from "@/app/api/explorer/route";

const ADDRESS = "0x1234567890123456789012345678901234567890";

const fetchMock = vi.fn();

function request(query: string, ip: string): NextRequest {
  return new NextRequest(`https://yldfi.co/api/explorer?${query}`, {
    headers: { "x-forwarded-for": ip },
  });
}

const okAbi = () => Response.json({ status: "1", message: "OK", result: "[]" });

describe("Explorer API route boundary", () => {
  beforeEach(() => {
    vi.stubEnv("ETHERSCAN_API_KEY", "test-key");
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("builds the mainnet upstream request from URLSearchParams", async () => {
    fetchMock.mockResolvedValue(okAbi());

    const response = await GET(request(`action=getABI&address=${ADDRESS}&chainId=1`, "203.0.113.1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ result: [], cached: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const upstream = new URL(fetchMock.mock.calls[0][0] as string);
    expect(Object.fromEntries(upstream.searchParams)).toEqual({
      chainid: "1",
      module: "contract",
      action: "getabi",
      address: ADDRESS,
      apikey: "test-key",
    });
  });

  it("defaults an omitted chainId to mainnet", async () => {
    fetchMock.mockResolvedValue(okAbi());

    const response = await GET(request(`action=getABI&address=${ADDRESS}`, "203.0.113.2"));

    expect(response.status).toBe(200);
    const upstream = new URL(fetchMock.mock.calls[0][0] as string);
    expect(Object.fromEntries(upstream.searchParams)).toEqual({
      chainid: "1",
      module: "contract",
      action: "getabi",
      address: ADDRESS,
      apikey: "test-key",
    });
  });

  it("encodes an API key containing URL syntax as a single query parameter", async () => {
    vi.stubEnv("ETHERSCAN_API_KEY", "k&module=account");
    fetchMock.mockResolvedValue(okAbi());

    const response = await GET(request(`action=getABI&address=${ADDRESS}&chainId=1`, "203.0.113.6"));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const upstream = new URL(fetchMock.mock.calls[0][0] as string);
    expect(upstream.searchParams.get("apikey")).toBe("k&module=account");
    expect(upstream.searchParams.get("module")).toBe("contract");
    expect(upstream.searchParams.getAll("module")).toHaveLength(1);
  });

  it("rejects a chain other than mainnet before calling Etherscan", async () => {
    const response = await GET(request(`action=getABI&address=${ADDRESS}&chainId=137`, "203.0.113.3"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Unsupported chainId" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a chainId carrying extra query syntax before calling Etherscan", async () => {
    const chainId = encodeURIComponent("1&module=account");

    const response = await GET(request(`action=getABI&address=${ADDRESS}&chainId=${chainId}`, "203.0.113.4"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Unsupported chainId" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid address before calling Etherscan", async () => {
    const response = await GET(request("action=getABI&address=0xnotanaddress&chainId=1", "203.0.113.5"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid address format" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hides an Etherscan failure result behind the fixed text", async () => {
    const leaked = "Query Timeout -- upstream secret";
    fetchMock.mockResolvedValue(
      Response.json({ status: "0", message: "NOTOK", result: leaked })
    );

    const response = await GET(request(`action=getABI&address=${ADDRESS}&chainId=1`, "203.0.113.7"));

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: "Failed to fetch ABI" });
    expect(JSON.stringify(body)).not.toContain(leaked);
  });

  it("hides a thrown Etherscan fetch behind the fixed internal error", async () => {
    const leaked = "socket hang up with upstream secret";
    fetchMock.mockRejectedValue(new Error(leaked));

    const response = await GET(request(`action=getABI&address=${ADDRESS}&chainId=1`, "203.0.113.8"));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: "Internal server error" });
    expect(JSON.stringify(body)).not.toContain(leaked);
  });
});
