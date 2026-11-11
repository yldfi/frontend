// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getAddress } from "viem";
import fixture from "@/__tests__/fixtures/simulation-pricing-yscvx-pxcvx.json";

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
import { GET as share } from "@/app/api/simulate/share/[simulationId]/route";
import { simulationNonceBinding } from "@/lib/simulation-nonce";

const TARGET = "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf";
const DATA = "0x21025a06";
const FROM = fixture.wallet;
// Lowercase sender for the normalisation case; its EIP-55 checksummed form is
// mixed case, so casing normalisation is actually exercised.
const FROM_LOWERCASE = "0xbce0cf87f513102f22232436cca2ca49e815c3ac";
const SECRET = "fixture-only-local-secret";

type NonceResult = { success: boolean; nonce: string; expires: number; sig: string };
type SimulateResult = { success: boolean; errorMessage?: string | null; tenderlyUrl?: string | null };

let fetchMock: ReturnType<typeof vi.fn>;

function headers() {
  return { origin: "http://localhost:3000", "x-forwarded-for": `fixture-${crypto.randomUUID()}` };
}

function baseBody(extra: Record<string, unknown> = {}) {
  return { from: FROM, to: TARGET, data: DATA, value: "0", ...extra };
}

function getNonce(bind?: string) {
  const url = bind === undefined
    ? "http://localhost:3000/api/simulate/nonce"
    : `http://localhost:3000/api/simulate/nonce?bind=${bind}`;
  return nonce(new NextRequest(url, { headers: headers() }));
}

async function getCredentials(bind?: string): Promise<NonceResult> {
  return (await getNonce(bind)).json() as Promise<NonceResult>;
}

function postSimulation(body: Record<string, unknown>) {
  return POST(new NextRequest("http://localhost:3000/api/simulate", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  }));
}

function boundCreds(subject: Parameters<typeof simulationNonceBinding>[0]) {
  return getCredentials(simulationNonceBinding(subject));
}

function base64Url(bytes: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(bytes))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function hmac(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

beforeEach(() => {
  vi.stubEnv("TENDERLY_ACCOUNT_SLUG", "fixture");
  vi.stubEnv("TENDERLY_PROJECT_SLUG", "fixture");
  vi.stubEnv("TENDERLY_ACCESS_KEY", "fixture-only");
  vi.stubEnv("SIMULATION_NONCE_SECRET", SECRET);
  fetchMock = vi.fn(async () => Response.json(fixture.tenderly));
  vi.stubGlobal("fetch", fetchMock);
  mocks.prices.mockImplementation(async (addresses: string[]) => fixture.prices.filter(p => addresses.includes(p.address.toLowerCase())));
  mocks.readContract.mockImplementation(async ({ functionName, args }) => {
    if (functionName === "convertToAssets") return BigInt(args[0]);
    throw new Error("not ERC4626");
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("simulation nonce binding", () => {
  it("accepts a bound nonce when the body matches the bound transaction", async () => {
    const credentials = await boundCreds({ from: FROM, to: TARGET, data: DATA, value: "0" });
    const response = await postSimulation({ ...baseBody(), ...credentials });
    const result = await response.json() as SimulateResult;
    expect(response.status).toBe(200);
    expect(result.success).toBe(true);
  });

  it("rejects a bound nonce used with different calldata", async () => {
    const credentials = await boundCreds({ from: FROM, to: TARGET, data: DATA, value: "0" });
    const response = await postSimulation({ ...baseBody({ data: "0x21025a07" }), ...credentials });
    const result = await response.json() as SimulateResult;
    expect(response.status).toBe(400);
    expect(result.errorMessage).toBe("Invalid nonce");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a bound nonce used with a different value", async () => {
    const credentials = await boundCreds({ from: FROM, to: TARGET, data: DATA, value: "0" });
    const response = await postSimulation({ ...baseBody({ value: "1" }), ...credentials });
    const result = await response.json() as SimulateResult;
    expect(response.status).toBe(400);
    expect(result.errorMessage).toBe("Invalid nonce");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalises sender casing and an omitted value", async () => {
    const checksummedFrom = getAddress(FROM_LOWERCASE);
    // Guards the point of the case: the POST body must differ from the bound form.
    expect(checksummedFrom).not.toBe(FROM_LOWERCASE);
    // Bound against the lowercase sender with no value (implicitly "0").
    const credentials = await boundCreds({ from: FROM_LOWERCASE, to: TARGET, data: DATA });
    const response = await postSimulation({
      ...baseBody({ from: checksummedFrom, value: "0" }),
      ...credentials,
    });
    const result = await response.json() as SimulateResult;
    expect(response.status).toBe(200);
    expect(result.success).toBe(true);
  });

  it("rejects replaying a share-link signature as an unbound nonce", async () => {
    const credentials = await boundCreds({ from: FROM, to: TARGET, data: DATA, value: "0" });
    const first = await postSimulation({ ...baseBody(), ...credentials });
    const firstResult = await first.json() as SimulateResult;
    expect(first.status).toBe(200);
    const shareUrl = new URL(firstResult.tenderlyUrl as string, "http://localhost:3000");
    const sig = shareUrl.searchParams.get("sig") as string;
    const simulationId = shareUrl.pathname.split("/").pop() as string;
    // The share signature is a valid signature for `sim-share.v1.<id>`, which is
    // exactly the payload the unbound fallback would accept if `expires` were
    // allowed to be this non-numeric string.
    expect(await hmac(SECRET, `sim-share.v1.${simulationId}`)).toBe(sig);
    const tenderlyCallsBefore = fetchMock.mock.calls.length;

    const replayed = await postSimulation({
      ...baseBody(),
      nonce: "sim-share.v1",
      expires: simulationId,
      sig,
    });
    const result = await replayed.json() as SimulateResult;
    expect(replayed.status).toBe(400);
    expect(result.errorMessage).toBe("Invalid nonce");
    expect(fetchMock.mock.calls.length).toBe(tenderlyCallsBefore);
  });

  it("rejects a numeric string expires", async () => {
    const credentials = await getCredentials();
    const response = await postSimulation({
      ...baseBody(),
      ...credentials,
      expires: String(credentials.expires),
    });
    const result = await response.json() as SimulateResult;
    expect(response.status).toBe(400);
    expect(result.errorMessage).toBe("Invalid nonce");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still accepts an unbound nonce while ALLOW_UNBOUND_NONCE is true", async () => {
    const credentials = await getCredentials();
    const response = await postSimulation({ ...baseBody(), ...credentials });
    const result = await response.json() as SimulateResult;
    expect(response.status).toBe(200);
    expect(result.success).toBe(true);
  });

  it("rejects a malformed nonce binding", async () => {
    const response = await getNonce("nothex");
    const result = await response.json() as { success: boolean; errorMessage: string };
    expect(response.status).toBe(400);
    expect(result.errorMessage).toBe("Invalid nonce binding");
  });

  it("always simulates on mainnet even when the body names another network", async () => {
    const credentials = await boundCreds({ from: FROM, to: TARGET, data: DATA, value: "0" });
    const response = await postSimulation({ ...baseBody(), networkId: 137, ...credentials });
    const result = await response.json() as SimulateResult;
    expect(response.status).toBe(200);
    expect(result.success).toBe(true);
    const tenderlyCall = fetchMock.mock.calls.find(([url]) => String(url).includes("api.tenderly.co"));
    expect(tenderlyCall).toBeDefined();
    const body = String((tenderlyCall as [unknown, { body: string }])[1].body);
    expect(body).toContain('"network_id":"1"');
    expect(body).not.toContain("137");
  });

  it("rejects a malformed sender", async () => {
    const credentials = await getCredentials();
    const response = await postSimulation({ ...baseBody({ from: "0x123" }), ...credentials });
    const result = await response.json() as SimulateResult;
    expect(response.status).toBe(400);
    expect(result.errorMessage).toBe("Invalid from/to/data");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-decimal or negative value", async () => {
    for (const value of ["abc", "-1"]) {
      const credentials = await getCredentials();
      const response = await postSimulation({ ...baseBody({ value }), ...credentials });
      const result = await response.json() as SimulateResult;
      expect(response.status).toBe(400);
      expect(result.errorMessage).toBe("Invalid value");
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("signs the share link with its own payload prefix", async () => {
    const credentials = await boundCreds({ from: FROM, to: TARGET, data: DATA, value: "0" });
    const result = await (await postSimulation({ ...baseBody(), ...credentials })).json() as SimulateResult;
    expect(result.tenderlyUrl).toBeTruthy();
    const shareUrl = new URL(result.tenderlyUrl as string, "http://localhost:3000");
    const simulationId = shareUrl.pathname.split("/").pop() as string;
    expect(simulationId).toBe("3b0f453a-2cb3-47c4-ac3c-01c3eb54531b");

    const allowed = await share(
      new NextRequest(shareUrl),
      { params: Promise.resolve({ simulationId }) },
    );
    expect(allowed.status).not.toBe(403);

    const bareIdSig = await hmac(SECRET, simulationId);
    const rejected = await share(
      new NextRequest(`http://localhost:3000/api/simulate/share/${simulationId}?sig=${bareIdSig}`),
      { params: Promise.resolve({ simulationId }) },
    );
    expect(rejected.status).toBe(403);
  });
});
