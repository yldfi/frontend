import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../.open-next/worker.js", () => ({
  default: { fetch: vi.fn() },
}));

import edgeWorker from "../../../workers/yldfi-edge";

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

const openNextFetch = vi.mocked((await import("../../../.open-next/worker.js")).default.fetch);

beforeEach(() => {
  openNextFetch.mockReset();
});

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