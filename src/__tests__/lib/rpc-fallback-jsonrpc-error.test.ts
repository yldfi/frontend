// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PRIVATE = "https://private.node.example/rpc/secret-key";

const RATE_LIMITED = { id: 1, error: { code: -32005, message: "rate limited" } };
const REVERT = { id: 1, error: { code: 3, message: "execution reverted" } };

const json = (reply: unknown) => ({ ok: true, json: async () => reply }) as unknown as Response;

type RpcModule = typeof import("@/lib/enso/api");

describe("rpcWithFallback: a JSON-RPC error body retries the next provider", () => {
  let rpc: RpcModule;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.stubEnv("ENSO_API_KEY", "test-key");
    vi.stubEnv("DEBUG_RPC_URL", PRIVATE);
    vi.stubEnv("DEBUG_RPC_AUTH", "user:pass");
    vi.resetModules();
    rpc = await import("@/lib/enso/api");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Install a fetch mock that answers per URL; the chainlist probe always fails. */
  function installFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("chainid.network")) return { ok: false, json: async () => [] } as unknown as Response;
      return respond(String(url), init);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  }

  const rpcCalls = () => fetchMock.mock.calls.filter(([url]) => !String(url).includes("chainid.network"));
  const privateCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(PRIVATE));

  const single = { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] as unknown[] };

  it("moves past a rate-limited provider and returns the next provider's body", async () => {
    installFetch((url) => (url.startsWith(PRIVATE) ? json(RATE_LIMITED) : json({ id: 1, result: "0x01" })));

    const reply = await rpc.rpcWithFallback(single);

    expect(reply).toEqual({ id: 1, result: "0x01" });
    expect(privateCalls()).toHaveLength(1);
  });

  it("returns an execution revert immediately without asking another provider", async () => {
    installFetch(() => json(REVERT));

    const reply = await rpc.rpcWithFallback(single);

    expect(reply).toEqual(REVERT);
    expect(rpcCalls()).toHaveLength(1);
  });

  it("retries a batch whose entries answered with a JSON-RPC error", async () => {
    const batch = [
      { jsonrpc: "2.0", id: 0, method: "eth_call", params: [] },
      { jsonrpc: "2.0", id: 1, method: "eth_call", params: [] },
    ];
    installFetch((url) =>
      url.startsWith(PRIVATE)
        ? json([
            { id: 0, result: "0x1" },
            { id: 1, error: { code: -32000, message: "header not found" } },
          ])
        : json([
            { id: 0, result: "0x1" },
            { id: 1, result: "0x2" },
          ]),
    );

    const reply = await rpc.rpcWithFallback(batch);

    expect(reply).toEqual([
      { id: 0, result: "0x1" },
      { id: 1, result: "0x2" },
    ]);
    expect(privateCalls()).toHaveLength(1);
  });

  it("resolves with the first error body when every provider answers with one, after three providers", async () => {
    installFetch(() => json(RATE_LIMITED));

    await expect(rpc.rpcWithFallback(single)).resolves.toEqual(RATE_LIMITED);
    expect(rpcCalls()).toHaveLength(3);
  });

  it("still falls back from an HTTP error to the next provider", async () => {
    installFetch((url) =>
      url.startsWith(PRIVATE)
        ? ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)
        : json({ id: 1, result: "0x02" }),
    );

    const reply = await rpc.rpcWithFallback(single);

    expect(reply).toEqual({ id: 1, result: "0x02" });
    expect(privateCalls()).toHaveLength(1);
  });

  it("rejects without leaking the provider path or key when every provider throws", async () => {
    installFetch(() => ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response));

    const error = await rpc.rpcWithFallback(single).then(
      () => undefined,
      (e: unknown) => e as Error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("500");
    expect(error?.message).not.toContain("/rpc/");
    expect(error?.message).not.toContain("secret-key");
  });

  /** Headers sent with the request to `url`. */
  const headersFor = (urlPrefix: string) => {
    const call = fetchMock.mock.calls.find(([url]) => String(url).startsWith(urlPrefix));
    return ((call?.[1] as RequestInit | undefined)?.headers ?? {}) as Record<string, string>;
  };

  it("sends the basic-auth header to the private node only, after an HTTP error", async () => {
    installFetch((url) =>
      url.startsWith(PRIVATE)
        ? ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)
        : json({ id: 1, result: "0x02" }),
    );

    const reply = await rpc.rpcWithFallback(single);

    expect(reply).toEqual({ id: 1, result: "0x02" });
    expect(headersFor(PRIVATE).Authorization).toBe("Basic user:pass");
    const publicCall = rpcCalls().find(([url]) => !String(url).startsWith(PRIVATE));
    expect(publicCall).toBeDefined();
    expect((publicCall![1] as RequestInit).headers).not.toHaveProperty("Authorization");
  });

  it("sends the basic-auth header to the private node only, after a JSON-RPC error body", async () => {
    installFetch((url) => (url.startsWith(PRIVATE) ? json(RATE_LIMITED) : json({ id: 1, result: "0x03" })));

    const reply = await rpc.rpcWithFallback(single);

    expect(reply).toEqual({ id: 1, result: "0x03" });
    expect(headersFor(PRIVATE).Authorization).toBe("Basic user:pass");
    const publicCall = rpcCalls().find(([url]) => !String(url).startsWith(PRIVATE));
    expect(publicCall).toBeDefined();
    expect((publicCall![1] as RequestInit).headers).not.toHaveProperty("Authorization");
  });
});
