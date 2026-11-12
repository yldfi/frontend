import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MockInstance } from "vitest";

import edgeWorker, { isMissingStaticAsset, withCountryVary } from "../../../workers/yldfi-edge";
import openNext from "../../../.open-next/worker.js";

class FakeStatement {
  args: unknown[] = [];
  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }
  async run() {
    return this.args;
  }
}

class FakeD1 {
  rows: FakeStatement[] = [];
  throws = false;
  prepare(_sql: string) {
    if (this.throws) throw new Error("d1 down");
    const stmt = new FakeStatement();
    this.rows.push(stmt);
    return stmt;
  }
}

function makeEnv(overrides: Partial<{ fakeD1: FakeD1 }> = {}) {
  const fakeD1 = overrides.fakeD1 ?? new FakeD1();
  const env = {
    ASSETS: {} as Fetcher,
    VAULT_CACHE: {} as KVNamespace,
    EXPLORER_CACHE: {} as KVNamespace,
    LOGS: fakeD1 as unknown as D1Database,
  };
  return { env, fakeD1 };
}

function captureWaitUntil() {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;
  return { ctx, pending: () => Promise.all(pending) };
}

let openNextFetch: MockInstance<typeof openNext.fetch>;

beforeEach(() => {
  vi.restoreAllMocks();
  openNextFetch = vi.spyOn(openNext, "fetch");
});

/** Throws `err` from the inner worker and returns the message stored in D1. */
async function storedErrorMessage(err: string | Error) {
  openNextFetch.mockRejectedValue(err);
  const { env, fakeD1 } = makeEnv();
  const { ctx, pending } = captureWaitUntil();

  const res = await edgeWorker.fetch(new Request("https://yldfi.co/vaults"), env, ctx);

  expect(res.status).toBe(500);
  await pending();
  expect(fakeD1.rows).toHaveLength(1);
  return String(fakeD1.rows[0].args[3]);
}

describe("yldfi-edge wrapper", () => {
  it("passes through successful responses", async () => {
    openNextFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    const { env, fakeD1 } = makeEnv();

    const res = await edgeWorker.fetch(new Request("https://yldfi.co/vaults"), env, captureWaitUntil().ctx);

    expect(res.status).toBe(200);
    expect(fakeD1.rows).toHaveLength(0);
  });

  it("logs uncaught errors to D1 and returns 500", async () => {
    openNextFetch.mockRejectedValue(new Error("boom in handler"));
    const { env, fakeD1 } = makeEnv();
    const { ctx, pending } = captureWaitUntil();

    const res = await edgeWorker.fetch(new Request("https://yldfi.co/vaults", {
      method: "POST",
      headers: { "cf-ipcountry": "US" },
    }), env, ctx);

    expect(res.status).toBe(500);
    await pending();
    expect(fakeD1.rows).toHaveLength(1);
    const [timestamp, level, source, message, meta] = fakeD1.rows[0].args;
    expect(level).toBe("error");
    expect(source).toBe("frontend");
    expect(String(message)).toContain("boom in handler");
    expect(JSON.parse(String(meta))).toMatchObject({ method: "POST", pathname: "/vaults", country: "US" });
    expect(Number.isNaN(Date.parse(String(timestamp)))).toBe(false);
  });

  it("stores the path and referer without query strings", async () => {
    openNextFetch.mockRejectedValue(new Error("boom in handler"));
    const { env, fakeD1 } = makeEnv();
    const { ctx, pending } = captureWaitUntil();

    const res = await edgeWorker.fetch(new Request("https://yldfi.co/api/simulate/share/abc?sig=SECRETISH&x=1", {
      headers: { referer: "https://yldfi.co/zap?input=0xabc", "cf-ipcountry": "US" },
    }), env, ctx);

    expect(res.status).toBe(500);
    await pending();
    expect(fakeD1.rows).toHaveLength(1);
    const meta = JSON.parse(String(fakeD1.rows[0].args[4]));
    expect(meta.pathname).toBe("/api/simulate/share/abc");
    expect(meta.referer).toBe("https://yldfi.co/zap");
    expect(JSON.stringify(meta)).not.toContain("SECRETISH");
    expect(JSON.stringify(meta)).not.toContain("input=");
  });

  it("keeps only the host from a URL in an Error's message and stack", async () => {
    const message = await storedErrorMessage(
      new Error("fetch failed for https://api.example/v2/SECRETKEY?wallet=0xabc&sig=123"),
    );

    expect(message).toContain("fetch failed for");
    expect(message).toContain("api.example");
    expect(message).not.toContain("SECRETKEY");
    expect(message).not.toContain("wallet=");
    expect(message).not.toContain("sig=");
  });

  it("keeps only the host from a URL in a thrown string", async () => {
    const message = await storedErrorMessage("upstream failed: wss://rpc.example/SECRETKEY?token=abc");

    expect(message).toBe("upstream failed: rpc.example");
  });

  it("stores an error with no URL unchanged", async () => {
    const message = await storedErrorMessage("plain failure, nothing else");

    expect(message).toBe("plain failure, nothing else");
  });

  it("applies the 2,000-character cap after redaction", async () => {
    const longText = `${"x".repeat(1900)} https://api.example/v2/SECRETKEY?wallet=0xabc&sig=123 ${"y".repeat(3000)}`;

    const message = await storedErrorMessage(longText);

    expect(message).toContain("api.example");
    expect(message).not.toContain("SECRET");
    expect(message).not.toContain("wallet=");
    expect(message.length).toBe(2001);
    expect(message.endsWith("…")).toBe(true);
  });

  it("still returns 500 when the D1 write itself fails", async () => {
    openNextFetch.mockRejectedValue(new Error("boom"));
    const { env, fakeD1 } = makeEnv();
    fakeD1.throws = true;
    const { ctx, pending } = captureWaitUntil();

    const res = await edgeWorker.fetch(new Request("https://yldfi.co/"), env, ctx);

    expect(res.status).toBe(500);
    await pending();
  });
});

describe("withCountryVary", () => {
  it("appends cf-ipcountry to Vary for GET, preserving existing values", () => {
    const res = withCountryVary(
      new Request("https://yldfi.co/", { method: "GET" }),
      new Response("ok", { headers: { Vary: "RSC, Next-Router-State-Tree" } }),
    );
    expect(res.headers.get("vary")).toBe("RSC, Next-Router-State-Tree, cf-ipcountry");
  });

  it("adds Vary for GET responses that have none", () => {
    const res = withCountryVary(
      new Request("https://yldfi.co/", { method: "GET" }),
      new Response("ok"),
    );
    expect(res.headers.get("vary")).toBe("cf-ipcountry");
  });

  it("leaves non-GET/HEAD responses untouched", () => {
    const res = withCountryVary(
      new Request("https://yldfi.co/api/enso/prices", { method: "POST" }),
      new Response("ok", { headers: { Vary: "Accept" } }),
    );
    expect(res.headers.get("vary")).toBe("Accept");
  });

  it("preserves status and body", async () => {
    const res = withCountryVary(
      new Request("https://yldfi.co/", { method: "GET" }),
      new Response("hello", { status: 200 }),
    );
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("hello");
  });
});

describe("missing static assets", () => {
  it.each([
    "https://yldfi.co/tokens/nope.png",
    "https://yldfi.co/wp-content/x.jpg",
    "https://yldfi.co/favicon-99.ico",
    "https://yldfi.co/fonts/x.woff2",
  ])("answers %s with a bare 404 without rendering Next", async (url) => {
    const { env } = makeEnv();
    const res = await edgeWorker.fetch(new Request(url), env, captureWaitUntil().ctx);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
    expect(openNextFetch).not.toHaveBeenCalled();
  });

  it.each([
    "https://yldfi.co/api/avatar/vitalik.eth.png",
    "https://yldfi.co/zap",
    "https://yldfi.co/vaults/yscvx",
    "https://yldfi.co/sitemap.xml",
  ])("passes %s through to OpenNext", async (url) => {
    openNextFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    const { env } = makeEnv();
    const res = await edgeWorker.fetch(new Request(url), env, captureWaitUntil().ctx);
    expect(res.status).toBe(200);
    expect(openNextFetch).toHaveBeenCalledTimes(1);
  });

  it("ignores non-GET methods", () => {
    expect(isMissingStaticAsset(new Request("https://yldfi.co/x.png", { method: "POST" }))).toBe(false);
  });
});
