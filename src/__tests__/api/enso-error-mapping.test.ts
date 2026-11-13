// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters } from "viem";

const { mockFetchRoute, mockFetchRepayWithSwapBundle } = vi.hoisted(() => ({
  mockFetchRoute: vi.fn(),
  mockFetchRepayWithSwapBundle: vi.fn(),
}));

const { mockGetCloudflareContext } = vi.hoisted(() => ({
  mockGetCloudflareContext: vi.fn(),
}));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: mockGetCloudflareContext,
}));

vi.mock("@ensofinance/sdk", () => ({
  EnsoClient: class MockEnsoClient {},
}));

vi.mock("@/lib/enso", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/enso")>();
  return { ...actual, fetchRoute: mockFetchRoute };
});

vi.mock("@/lib/curve-lending", () => ({
  fetchRepayBundle: vi.fn(),
  fetchRepayWithSwapBundle: mockFetchRepayWithSwapBundle,
}));

import { POST } from "@/app/api/enso/[method]/route";
import { ENSO_ROUTER_V2 } from "@/lib/enso/constants";
import { TOKENS, VAULT_ADDRESSES } from "@/config/vaults";

const USER = "0x1000000000000000000000000000000000000001";
const ONE_ETHER = "1000000000000000000";

const ROUTE_ENTRYPOINT_ABI = parseAbi([
  "function routeSingle((uint8 tokenType, bytes data) tokenIn, bytes data) payable returns (bytes)",
]);
const TOKEN_AMOUNT_PARAMETERS = parseAbiParameters("address token, uint256 amount");

const routeCalldata = encodeFunctionData({
  abi: ROUTE_ENTRYPOINT_ABI,
  functionName: "routeSingle",
  args: [
    {
      tokenType: 1,
      data: encodeAbiParameters(TOKEN_AMOUNT_PARAMETERS, [
        TOKENS.CVX as `0x${string}`,
        BigInt(ONE_ETHER),
      ]),
    },
    "0x1234",
  ],
});

const ROUTE_RESPONSE = {
  tx: { to: ENSO_ROUTER_V2, data: routeCalldata, value: "0" },
  gas: "100000",
  amountOut: "1000000",
  route: [],
};

const plainSwapBody = {
  intent: "plainTokenSwap",
  fromAddress: USER,
  tokenIn: TOKENS.CVX,
  tokenOut: TOKENS.CVXCRV,
  amountIn: ONE_ETHER,
  slippage: "100",
};

const closeLoanBody = {
  intent: "curveLendingRepayWithSwap",
  fromAddress: USER,
  vaultAddress: VAULT_ADDRESSES.YCVXCRV,
  tokenIn: TOKENS.CVX,
  amountIn: ONE_ETHER,
  slippage: "100",
  closeLoan: true,
};

const post = (method: string, body: unknown) =>
  POST(
    new Request(`https://yldfi.co/api/enso/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://yldfi.co" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ method }) },
  );

const postPlainSwap = () => post("intent", plainSwapBody);

type UpstreamError = Error & {
  statusCode?: number;
  response?: { data?: unknown };
};

const upstreamError = (
  message: string,
  extra: { statusCode?: number; response?: { data?: unknown } } = {},
): UpstreamError => Object.assign(new Error(message), extra);

const COULD_NOT_QUOTE = "API Error: Could not quote shortcuts for route";
const GENERIC_ADVICE =
  "No swap route could be quoted for this transaction. Increase the amount, increase slippage, or use a different token.";
const CRVUSD_ADVICE =
  "No swap route could produce enough crvUSD for this close. Increase the amount, increase slippage, or use crvUSD.";

describe("Enso proxy error mapping", () => {
  let errorLog: ReturnType<typeof vi.spyOn>;
  let infoLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ENSO_API_KEY", "test-key");
    mockGetCloudflareContext.mockImplementation(() => {
      throw new Error("no cf context");
    });
    errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    infoLog = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    errorLog.mockRestore();
    infoLog.mockRestore();
    vi.unstubAllEnvs();
  });

  it("keeps an upstream 429 status and passes a plain message through", async () => {
    mockFetchRoute.mockRejectedValueOnce(
      upstreamError("Too Many Requests", { statusCode: 429 }),
    );

    const response = await postPlainSwap();

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: "Too Many Requests" });
  });

  it("uses the upstream status when present and 500 when there is none or it is 0", async () => {
    mockFetchRoute.mockRejectedValueOnce(upstreamError("bad request", { statusCode: 400 }));
    expect((await postPlainSwap()).status).toBe(400);

    mockFetchRoute.mockRejectedValueOnce(upstreamError("no status"));
    expect((await postPlainSwap()).status).toBe(500);

    mockFetchRoute.mockRejectedValueOnce(upstreamError("zero status", { statusCode: 0 }));
    expect((await postPlainSwap()).status).toBe(500);
  });

  it("falls back to a generic message when the thrown value carries no message", async () => {
    mockFetchRoute.mockRejectedValueOnce({});

    const response = await postPlainSwap();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Enso API error" });
  });

  it("rewrites a could-not-quote message into advice and keeps the upstream status", async () => {
    mockFetchRoute.mockRejectedValueOnce(upstreamError(COULD_NOT_QUOTE, { statusCode: 400 }));

    const response = await postPlainSwap();

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: GENERIC_ADVICE });
  });

  it("uses the crvUSD advice when the request body closes a loan", async () => {
    mockFetchRepayWithSwapBundle.mockRejectedValueOnce(
      upstreamError(COULD_NOT_QUOTE, { statusCode: 400 }),
    );

    const response = await post("intent", closeLoanBody);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: CRVUSD_ADVICE });
  });

  it("rewrites a could-not-quote message written in mixed case", async () => {
    mockFetchRoute.mockRejectedValueOnce(upstreamError("COULD NOT QUOTE shortcuts"));

    const response = await postPlainSwap();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: GENERIC_ADVICE });
  });

  it("strips the path and key from a URL in an upstream message", async () => {
    mockFetchRoute.mockRejectedValueOnce(
      upstreamError("upstream https://private.node.example/rpc/secret-key refused"),
    );

    const response = await postPlainSwap();
    const payload = (await response.json()) as { error: string };

    expect(payload.error).toContain("private.node.example");
    expect(payload.error).not.toContain("secret-key");
    expect(payload.error).not.toContain("/rpc/");
  });

  it("never returns upstream response data in the body but logs it", async () => {
    mockFetchRoute.mockRejectedValueOnce(
      upstreamError("builder boom", { response: { data: { secret: "do-not-return" } } }),
    );

    const response = await postPlainSwap();
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(Object.keys(payload)).toEqual(["error"]);
    expect(JSON.stringify(payload)).not.toContain("do-not-return");
    expect(errorLog).toHaveBeenCalledWith("[Enso Proxy] intent error:", {
      secret: "do-not-return",
    });
  });

  it("answers an unknown method with 404", async () => {
    const response = await post("nope", {});

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Unknown method: nope" });
  });

  it("sets the same CORS headers on a failure as on a success", async () => {
    mockFetchRoute.mockResolvedValueOnce(ROUTE_RESPONSE);
    const success = await postPlainSwap();
    expect(success.status).toBe(200);

    mockFetchRoute.mockRejectedValueOnce(upstreamError("builder boom"));
    const failure = await postPlainSwap();
    expect(failure.status).toBe(500);

    expect(failure.headers.get("Access-Control-Allow-Origin")).toBe(
      success.headers.get("Access-Control-Allow-Origin"),
    );
    expect([...failure.headers.keys()].sort()).toEqual([...success.headers.keys()].sort());
  });
});
