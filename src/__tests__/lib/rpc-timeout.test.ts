// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PRIVATE = "https://private.node.example/rpc/secret-key";
const timeoutError = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

type RpcModule = typeof import("@/lib/curve/rpc");

describe("server-side RPC timeouts", () => {
  let rpc: RpcModule;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Production-like retry settings (live mode), with a private node first in the list.
    vi.stubEnv("ENSO_API_KEY", "test-key");
    vi.stubEnv("DEBUG_RPC_URL", PRIVATE);
    vi.resetModules();
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith(PRIVATE)) throw timeoutError();
      if (url.includes("chainid.network")) return { ok: false, json: async () => [] } as unknown as Response;
      const body = JSON.parse(String(init?.body));
      const result = "0x" + (1234n).toString(16).padStart(64, "0");
      return {
        ok: true,
        json: async () => (Array.isArray(body) ? body.map((r: { id: number }) => ({ id: r.id, result })) : { id: body.id, result }),
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    rpc = await import("@/lib/curve/rpc");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const privateCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(PRIVATE));

  it("gives every RPC fetch a timeout signal", async () => {
    await rpc.batchRpcCalls([{ to: "0x0000000000000000000000000000000000000001", data: "0x" }]);
    const rpcCalls = fetchMock.mock.calls.filter(([url]) => !String(url).includes("chainid.network"));
    expect(rpcCalls.length).toBeGreaterThan(0);
    for (const [, init] of rpcCalls) expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("batchRpcCalls tries a timed-out node once, then falls back to the public list", async () => {
    const results = await rpc.batchRpcCalls([{ to: "0x0000000000000000000000000000000000000001", data: "0x" }]);
    expect(results).toEqual([1234n]);
    expect(privateCalls()).toHaveLength(1);
  });

  it("getCurveGetDy does not retry a timed-out node (was up to 5 attempts)", async () => {
    const out = await rpc.getCurveGetDy("0x0000000000000000000000000000000000000002", 0, 1, "1000");
    expect(out).toBe(1234n);
    expect(privateCalls()).toHaveLength(1);
  });
});
