// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Rejection = { success: boolean; errorMessage?: string; retryable?: boolean };
type Credentials = { nonce: string; expires: number; sig: string };

const mocks = vi.hoisted(() => ({ prices: vi.fn(), readContract: vi.fn() }));
vi.mock("@/lib/enso", () => ({
  fetchTokenPricesDirect: mocks.prices,
  ENSO_ROUTER_V2: "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf",
  MORPHO_BUNDLER3_ADDRESS: "0x6566194141eefa99af43bb5aa71460ca2dc90245",
}));
vi.mock("viem", async (importOriginal) => ({
  ...await importOriginal<typeof import("viem")>(),
  createPublicClient: () => ({ readContract: mocks.readContract }),
}));
import { POST } from "@/app/api/simulate/route";
import { GET as nonce } from "@/app/api/simulate/nonce/route";
import { simulationNonceBinding } from "@/lib/simulation-nonce";

const VALID_TO = "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf";
const FROM = "0x1234567890123456789012345678901234567890";
const DATA = "0x21025a06";

function headers() {
  return { origin: "http://localhost:3000", "x-forwarded-for": `rej-${crypto.randomUUID()}` };
}

async function credentials(
  requestHeaders: Record<string, string>,
  subject: Parameters<typeof simulationNonceBinding>[0],
): Promise<Credentials> {
  const bind = simulationNonceBinding(subject);
  const response = await nonce(new NextRequest(`http://localhost:3000/api/simulate/nonce?bind=${bind}`, { headers: requestHeaders }));
  return await response.json() as Credentials;
}

function post(body: unknown, requestHeaders: Record<string, string>) {
  return POST(new NextRequest("http://localhost:3000/api/simulate", {
    method: "POST",
    headers: requestHeaders,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

beforeEach(() => {
  vi.stubEnv("TENDERLY_ACCOUNT_SLUG", "fixture");
  vi.stubEnv("TENDERLY_PROJECT_SLUG", "fixture");
  vi.stubEnv("TENDERLY_ACCESS_KEY", "fixture-only");
  vi.stubEnv("SIMULATION_NONCE_SECRET", "fixture-only-local-secret");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("POST /api/simulate rejections", () => {
  it("refuses to run without Tenderly credentials", async () => {
    vi.stubEnv("TENDERLY_ACCESS_KEY", "");
    const response = await post({ from: FROM, to: VALID_TO, data: DATA }, headers());
    const result = await response.json() as Rejection;

    expect(response.status).toBe(500);
    expect(result.errorMessage).toBe("Tenderly not configured");
    expect(result.retryable).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const response = await post("not json", headers());
    const result = await response.json() as Rejection;

    expect(response.status).toBe(400);
    expect(result.errorMessage).toBe("Invalid JSON body");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a body missing data", async () => {
    const response = await post({ from: FROM, to: VALID_TO }, headers());
    const result = await response.json() as Rejection;

    expect(response.status).toBe(400);
    expect(result.errorMessage).toBe("Missing from/to/data");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a request when the nonce secret is not configured", async () => {
    vi.stubEnv("SIMULATION_NONCE_SECRET", "");
    const response = await post({ from: FROM, to: VALID_TO, data: DATA }, headers());
    const result = await response.json() as Rejection;

    expect(response.status).toBe(500);
    expect(result.errorMessage).toBe("Nonce secret not configured");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a request with no nonce fields", async () => {
    const response = await post({ from: FROM, to: VALID_TO, data: DATA }, headers());
    const result = await response.json() as Rejection;

    expect(response.status).toBe(400);
    expect(result.errorMessage).toBe("Missing nonce");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an expired nonce without verifying it", async () => {
    const response = await post(
      { from: FROM, to: VALID_TO, data: DATA, nonce: "expired", expires: Date.now() - 1, sig: "sig" },
      headers()
    );
    const result = await response.json() as Rejection;

    expect(response.status).toBe(400);
    expect(result.errorMessage).toBe("Nonce expired");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a nonce whose signature does not match", async () => {
    const requestHeaders = headers();
    const valid = await credentials(requestHeaders, { from: FROM, to: VALID_TO, data: DATA });
    const response = await post(
      { from: FROM, to: VALID_TO, data: DATA, ...valid, nonce: `${valid.nonce}-tampered` },
      requestHeaders
    );
    const result = await response.json() as Rejection;

    expect(response.status).toBe(400);
    expect(result.errorMessage).toBe("Invalid nonce");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a target that is not allowlisted", async () => {
    const requestHeaders = headers();
    const valid = await credentials(requestHeaders, {
      from: FROM,
      to: "0x000000000000000000000000000000000000dEaD",
      data: DATA,
    });
    const response = await post(
      { from: FROM, to: "0x000000000000000000000000000000000000dEaD", data: DATA, ...valid },
      requestHeaders
    );
    const result = await response.json() as Rejection;

    expect(response.status).toBe(400);
    expect(result.errorMessage).toContain("Simulation target not in allowlist");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects calldata that is too short", async () => {
    const requestHeaders = headers();
    const valid = await credentials(requestHeaders, { from: FROM, to: VALID_TO, data: "0x1234" });
    const response = await post(
      { from: FROM, to: VALID_TO, data: "0x1234", ...valid },
      requestHeaders
    );
    const result = await response.json() as Rejection;

    expect(response.status).toBe(400);
    expect(result.errorMessage).toBe("Invalid calldata");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects calldata without a 0x prefix", async () => {
    const requestHeaders = headers();
    const valid = await credentials(requestHeaders, { from: FROM, to: VALID_TO, data: "abcdefghijkl" });
    const response = await post(
      { from: FROM, to: VALID_TO, data: "abcdefghijkl", ...valid },
      requestHeaders
    );
    const result = await response.json() as Rejection;

    expect(response.status).toBe(400);
    expect(result.errorMessage).toBe("Invalid calldata");
    expect(fetch).not.toHaveBeenCalled();
  });

  // Pins current behaviour, which is probably unintended: the nonce is burned before the allowlist check, so a rejected target still consumes it. Expected to change when nonce validation is reworked.
  it("burns the nonce even when the allowlist rejects the request", async () => {
    const requestHeaders = headers();
    const valid = await credentials(requestHeaders, {
      from: FROM,
      to: "0x000000000000000000000000000000000000dEaD",
      data: DATA,
    });

    const first = await post(
      { from: FROM, to: "0x000000000000000000000000000000000000dEaD", data: DATA, ...valid },
      requestHeaders
    );
    expect(first.status).toBe(400);
    expect((await first.json() as Rejection).errorMessage).toContain("Simulation target not in allowlist");

    // The nonce is bound to the rejected target, so the replay repeats the same
    // request: the burn is still observed ahead of the allowlist check.
    const second = await post(
      { from: FROM, to: "0x000000000000000000000000000000000000dEaD", data: DATA, ...valid },
      requestHeaders
    );
    const result = await second.json() as Rejection;

    expect(second.status).toBe(400);
    expect(result.errorMessage).toBe("Nonce already used");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rate limits a sender after eight requests in a minute", async () => {
    const requestHeaders = { origin: "http://localhost:3000", "x-forwarded-for": `rej-${crypto.randomUUID()}` };

    for (let index = 0; index < 8; index++) {
      const response = await post({}, requestHeaders);
      expect(response.status).toBe(400);
      expect((await response.json() as Rejection).errorMessage).toBe("Missing from/to/data");
    }

    const response = await post({}, requestHeaders);
    const result = await response.json() as Rejection;

    expect(response.status).toBe(429);
    expect(result.errorMessage).toBe("Rate limit exceeded");
    expect(result.retryable).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
