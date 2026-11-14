// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters } from "viem";

const { mockFetchRoute } = vi.hoisted(() => ({
  mockFetchRoute: vi.fn(),
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

import { POST } from "@/app/api/enso/[method]/route";
import { ENSO_ROUTER_V2 } from "@/lib/enso/constants";
import { SAFE_LOG_MAX_LENGTH } from "@/lib/safe-log";
import { TOKENS } from "@/config/vaults";

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
  responseData?: unknown;
  response?: { data?: unknown };
};

type ErrorLogFields = {
  status?: number;
  message?: string;
  upstream?: unknown;
};

const upstreamError = (
  message: string,
  extra: { statusCode?: number; responseData?: unknown; response?: { data?: unknown } } = {},
): UpstreamError => Object.assign(new Error(message), extra);

const COULD_NOT_QUOTE = "API Error: Could not quote shortcuts for route";
const GENERIC_ADVICE =
  "No swap route could be quoted for this transaction. Increase the amount, increase slippage, or use a different token.";

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

  const loggedFields = (): ErrorLogFields => {
    expect(errorLog).toHaveBeenCalledTimes(1);
    return errorLog.mock.calls[0][1] as ErrorLogFields;
  };

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
      status: 500,
      message: "builder boom",
      upstream: expect.stringContaining("do-not-return"),
    });
  });

  it("logs an SDK error's responseData while returning only its message", async () => {
    mockFetchRoute.mockRejectedValueOnce(
      Object.assign(new Error("API Error: boom"), {
        statusCode: 400,
        responseData: { message: "boom", detail: "why" },
      }),
    );

    const response = await postPlainSwap();
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({ error: "API Error: boom" });
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith("[Enso Proxy] intent error:", {
      status: 400,
      message: "API Error: boom",
      upstream: expect.stringContaining("why"),
    });
  });

  it("reduces a URL in the upstream body to its host before logging", async () => {
    mockFetchRoute.mockRejectedValueOnce(
      upstreamError("builder boom", {
        responseData: { message: "upstream https://private.node.example/rpc/secret-key refused" },
      }),
    );

    await postPlainSwap();
    const { upstream } = loggedFields();

    expect(upstream).toContain("private.node.example");
    expect(upstream).not.toContain("secret-key");
  });

  it("reduces a URL in the error message to its host before logging", async () => {
    mockFetchRoute.mockRejectedValueOnce(
      upstreamError("upstream https://private.node.example/rpc/secret-key refused"),
    );

    await postPlainSwap();
    const { message } = loggedFields();

    expect(message).toContain("private.node.example");
    expect(message).not.toContain("secret-key");
    expect(message).not.toContain("/rpc/");
  });

  it("bounds a very long error message in the log", async () => {
    mockFetchRoute.mockRejectedValueOnce(upstreamError("x".repeat(5000)));

    await postPlainSwap();
    const { message } = loggedFields();

    expect(typeof message).toBe("string");
    expect((message as string).length).toBeLessThanOrEqual(SAFE_LOG_MAX_LENGTH);
  });

  it("logs no upstream field when the error carries no upstream body", async () => {
    mockFetchRoute.mockRejectedValueOnce(upstreamError("builder boom"));

    await postPlainSwap();

    expect(loggedFields().upstream).toBeUndefined();
  });

  it("answers could-not-quote with advice but logs the upstream message", async () => {
    mockFetchRoute.mockRejectedValueOnce(upstreamError(COULD_NOT_QUOTE, { statusCode: 400 }));

    const response = await postPlainSwap();
    const payload = (await response.json()) as { error: string };

    expect(payload.error).toBe(GENERIC_ADVICE);
    expect(loggedFields().message).toBe(COULD_NOT_QUOTE);
  });

  it("bounds a long upstream body in the log", async () => {
    mockFetchRoute.mockRejectedValueOnce(
      upstreamError("builder boom", { response: { data: { detail: "x".repeat(5000) } } }),
    );

    await postPlainSwap();
    const { upstream } = loggedFields();

    expect(typeof upstream).toBe("string");
    expect((upstream as string).length).toBeLessThanOrEqual(500);
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
