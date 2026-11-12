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

const body = {
  intent: "plainTokenSwap",
  fromAddress: USER,
  tokenIn: TOKENS.CVX,
  tokenOut: TOKENS.CVXCRV,
  amountIn: ONE_ETHER,
  slippage: "100",
};

const postIntent = () =>
  POST(
    new Request("https://yldfi.co/api/enso/intent", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://yldfi.co" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ method: "intent" }) },
  );

type TimingLine = { intent: string; ms: number; ok: boolean };
const timingLines = (log: { mock: { calls: unknown[][] } }): TimingLine[] =>
  log.mock.calls
    .filter((args) => args[0] === "[Enso Proxy] intent timing")
    .map((args) => JSON.parse(String(args[1])) as TimingLine);

describe("Enso intent timing log line", () => {
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ENSO_API_KEY", "test-key");
    mockGetCloudflareContext.mockImplementation(() => {
      throw new Error("no cf context");
    });
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    vi.unstubAllEnvs();
  });

  it("logs the intent name and ok: true for a successful intent", async () => {
    mockFetchRoute.mockResolvedValueOnce(ROUTE_RESPONSE);

    const response = await postIntent();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ amountOut: "1000000" });

    const lines = timingLines(log);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ intent: "plainTokenSwap", ms: expect.any(Number), ok: true });
    expect(Object.keys(lines[0]).sort()).toEqual(["intent", "ms", "ok"]);
  });

  it("logs ok: false for a failing builder and keeps the existing error response", async () => {
    mockFetchRoute.mockRejectedValueOnce(new Error("builder boom"));

    const response = await postIntent();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "builder boom" });

    const lines = timingLines(log);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ intent: "plainTokenSwap", ms: expect.any(Number), ok: false });
    expect(Object.keys(lines[0]).sort()).toEqual(["intent", "ms", "ok"]);
  });
});
