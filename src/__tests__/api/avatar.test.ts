// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET, OPTIONS } from "@/app/api/avatar/[name]/route";

function request(name: string, origin = "https://yldfi.co") {
  return new NextRequest(`https://yldfi.co/api/avatar/${encodeURIComponent(name)}`, {
    headers: { origin, "x-forwarded-for": `avatar-${crypto.randomUUID()}` },
  });
}

function get(name: string, origin?: string) {
  return GET(request(name, origin), { params: Promise.resolve({ name }) });
}

function imageResponse(type: string, bytes = 4) {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": type },
  });
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("GET /api/avatar/[name]", () => {
  it("proxies a valid ENS name to euc.li and returns the image", async () => {
    const fetchMock = vi.fn(async () => imageResponse("image/jpeg"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await get("vitalik.eth");

    expect(fetchMock).toHaveBeenCalledWith("https://euc.li/vitalik.eth", {
      headers: { "User-Agent": "yld ENS Avatar Proxy" },
      signal: expect.any(AbortSignal),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(new Uint8Array(await response.arrayBuffer())).toHaveLength(4);
  });

  it("preserves subdomains and their casing in the upstream request", async () => {
    const fetchMock = vi.fn(async () => imageResponse("image/png"));
    vi.stubGlobal("fetch", fetchMock);

    await get("Sub.Domain.eth");

    expect(fetchMock).toHaveBeenCalledWith("https://euc.li/Sub.Domain.eth", expect.anything());
  });

  it.each(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"])(
    "passes an upstream %s through with that content type",
    async (type) => {
      vi.stubGlobal("fetch", vi.fn(async () => imageResponse(type)));

      const response = await get("vitalik.eth");

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(type);
    }
  );

  it("strips parameters and casing from an allowed upstream content type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse("IMAGE/JPEG; charset=binary")));

    const response = await get("vitalik.eth");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
  });

  it("marks a served avatar as inert", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse("image/png")));

    const response = await get("vitalik.eth");

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });

  it.each(["image/svg+xml", "image/png+xml", "text/html", "image/png, text/html"])(
    "refuses an upstream %s response",
    async (type) => {
      vi.stubGlobal("fetch", vi.fn(async () => imageResponse(type)));

      const response = await get("vitalik.eth");

      expect(response.status).toBe(415);
      expect(await response.text()).toBe("Unsupported avatar type");
    }
  );

  it("refuses an upstream response that has no content type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(2), { status: 200 })));

    const response = await get("vitalik.eth");

    expect(response.status).toBe(415);
    expect(await response.text()).toBe("Unsupported avatar type");
  });

  it("refuses an upstream avatar that declares itself over the size cap without reading it", async () => {
    let cancelled = false;
    let pulls = 0;
    const upstream = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++;
            controller.enqueue(new Uint8Array(4));
            controller.close();
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 }
      ),
      {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(2 * 1024 * 1024 + 1),
        },
      }
    );
    vi.stubGlobal("fetch", vi.fn(async () => upstream));

    const response = await get("vitalik.eth");

    expect(response.status).toBe(413);
    expect(await response.text()).toBe("Avatar too large");
    // The body is released instead of left dangling.
    expect(cancelled).toBe(true);
    // Nothing was read: the declared length alone settled it.
    expect(pulls).toBe(0);
  });

  it.each([
    ["a refused content type", 415, { status: 200, headers: { "content-type": "image/svg+xml" } }],
    ["a failed upstream response", 503, { status: 503 }],
  ])("releases the upstream body of %s", async (_label, status, init) => {
    let cancelled = false;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(4));
          controller.close();
        },
        cancel() {
          cancelled = true;
        },
      }),
      init
    );
    vi.stubGlobal("fetch", vi.fn(async () => upstream));

    const response = await get("vitalik.eth");

    expect(response.status).toBe(status);
    expect(cancelled).toBe(true);
  });

  it("refuses a body that crosses the size cap without a content-length before reading it all", async () => {
    const total = 3 * 1024 * 1024;
    const chunkSize = 64 * 1024;
    let sent = 0;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= total) {
            controller.close();
            return;
          }
          const size = Math.min(chunkSize, total - sent);
          controller.enqueue(new Uint8Array(size));
          sent += size;
        },
      }),
      { status: 200, headers: { "content-type": "image/png" } }
    );
    expect(upstream.headers.get("content-length")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => upstream));

    const response = await get("vitalik.eth");

    expect(response.status).toBe(413);
    expect(await response.text()).toBe("Avatar too large");
    expect(sent).toBeLessThan(total);
  });

  it.each([
    ["a name without a TLD", "vitalik"],
    ["a non-eth TLD", "test.xyz"],
    ["markup", "vitalik<script>.eth"],
    ["a slash", "vitalik/eth"],
    ["an empty name", ""],
  ])("rejects %s before calling euc.li", async (_label, name) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await get(name);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid ENS name" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([404, 403, 500])("passes an upstream %i through as a failed image response", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status })));

    const response = await get("vitalik.eth");

    expect(response.status).toBe(status);
    expect(await response.text()).toBe("Avatar not found");
  });

  it("reports an unreachable avatar service as a server error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("network down"))));

    const response = await get("vitalik.eth");

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Failed to fetch avatar");
  });

  it("adds CORS headers to every response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse("image/png")));

    const allowed = await get("vitalik.eth", "https://www.yldfi.co");
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://www.yldfi.co");
    expect(allowed.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");

    const unknown = await get("vitalik.eth", "https://attacker.example");
    expect(unknown.headers.get("access-control-allow-origin")).toBe("https://yldfi.co");
  });

  it("answers the CORS preflight", async () => {
    const response = await OPTIONS(request("vitalik.eth", "https://yldfi.co"));

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://yldfi.co");
  });
});
