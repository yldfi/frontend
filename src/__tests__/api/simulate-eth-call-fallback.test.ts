// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { RPC_URL_LIST } from "@/config/rpc";
import { simulationNonceBinding } from "@/lib/simulation-nonce";

// viem is deliberately NOT mocked here: the point of this spec is that the
// route's eth_call fallback walks the real provider list instead of one host.
vi.mock("@/lib/enso", () => ({
  fetchTokenPricesDirect: vi.fn(async () => []),
  ENSO_ROUTER_V2: "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf",
  MORPHO_BUNDLER3_ADDRESS: "0x6566194141eefa99af43bb5aa71460ca2dc90245",
}));

const PRIVATE_RPC_URL = "https://private.node.example/rpc";
const PRIVATE_RPC_SECRET_URL = "https://private.node.example/rpc/secret-key";
const PRIVATE_RPC_AUTH = "fixture-rpc-credential";
const CALLDATA = "0x21025a06deadbeef";
const NETWORK_DOWN_MESSAGE = "Could not check the transaction: the network did not answer";

type Recorded = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

const recorded: Recorded[] = [];

/** Routes every request the route makes; records URL, headers and body. */
function routeFetch(handler: (call: Recorded, init?: RequestInit) => Response | Promise<Response>) {
  recorded.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const call: Recorded = {
        url,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: typeof init?.body === "string" ? init.body : "",
      };
      recorded.push(call);
      return handler(call, init);
    }),
  );
}

const rpcOk = () => Response.json({ jsonrpc: "2.0", id: 1, result: "0x" });
const rpcRevert = () =>
  Response.json({
    jsonrpc: "2.0",
    id: 1,
    error: { code: 3, message: "execution reverted: Too little received" },
  });
const rpcRevertReason = (reason: string) =>
  Response.json({
    jsonrpc: "2.0",
    id: 1,
    error: { code: 3, message: `execution reverted: ${reason}` },
  });
const rpcError = (code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", id: 1, error: { code, message } });
/** A provider that accepts the connection and never answers; only the abort signal ends it. */
const hangingProvider = (_call: Recorded, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  });
const rpcInsufficientFunds = () =>
  Response.json({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32000, message: "insufficient funds for gas * price + value" },
  });
const forbidden = () => new Response("Forbidden", { status: 403 });
const tenderlyDown = () => {
  throw new Error("simulation service unreachable");
};

async function simulate() {
  // Fresh module graph per test so the lazily built client reads the stubbed env.
  vi.resetModules();
  const { POST } = await import("@/app/api/simulate/route");
  const { GET: nonce } = await import("@/app/api/simulate/nonce/route");

  const headers = {
    origin: "http://localhost:3000",
    "x-forwarded-for": `fixture-${crypto.randomUUID()}`,
  };
  const body = {
    from: "0x1111111111111111111111111111111111111111",
    to: "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf",
    data: CALLDATA,
  };
  const bind = simulationNonceBinding(body);
  const nonceResponse = await nonce(
    new NextRequest(`http://localhost:3000/api/simulate/nonce?bind=${bind}`, { headers }),
  );
  const credentials = await nonceResponse.json() as { nonce: string; expires: number; sig: string };
  return POST(
    new NextRequest("http://localhost:3000/api/simulate", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, ...credentials }),
    }),
  );
}

function expectNoOldHost() {
  for (const call of recorded) {
    expect(call.url).not.toContain("merkle");
  }
}

/** Every console line written during one request, plus its parsed `[Simulate]` events. */
function captureLogs() {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(record);
  vi.spyOn(console, "error").mockImplementation(record);
  const events = () => lines
    .filter((line) => line.startsWith("[Simulate] "))
    .map((line) => JSON.parse(line.slice("[Simulate] ".length)) as {
      event?: string;
      stage?: string;
      detail?: string;
      error?: string;
    });
  return { lines, events };
}

/** Nothing a provider's own error text could carry: key, path, request body, calldata. */
function expectNoProviderDetail(lines: string[]) {
  const text = lines.join("\n");
  expect(text).not.toContain("secret-key");
  expect(text).not.toContain("/rpc/");
  expect(text).not.toContain("Request body");
  expect(text).not.toContain(CALLDATA.slice(2));
}

beforeEach(() => {
  vi.stubEnv("TENDERLY_ACCOUNT_SLUG", "fixture");
  vi.stubEnv("TENDERLY_PROJECT_SLUG", "fixture");
  vi.stubEnv("TENDERLY_ACCESS_KEY", "fixture-only");
  vi.stubEnv("SIMULATION_NONCE_SECRET", "fixture-only-local-secret");
  vi.stubEnv("DEBUG_RPC_URL", PRIVATE_RPC_URL);
  vi.stubEnv("DEBUG_RPC_AUTH", PRIVATE_RPC_AUTH);
  // Pin the static list so a background chainid.network fetch cannot race the mock.
  vi.stubEnv("RPC_DYNAMIC_DISCOVERY", "off");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("simulate route eth_call fallback", () => {
  it("uses the configured private node, with its auth header, when the simulation service is down", async () => {
    routeFetch((call) => {
      if (call.url.includes("tenderly")) return tenderlyDown();
      if (call.url === PRIVATE_RPC_URL) return rpcOk();
      return forbidden();
    });

    const response = await simulate();
    const result = await response.json() as { success: boolean; simulationUnavailable?: boolean };

    expect(response.status).toBe(200);
    expect(result.success).toBe(true);
    expect(result.simulationUnavailable).toBe(true);

    const ethCall = recorded.find((call) => call.url === PRIVATE_RPC_URL);
    expect(ethCall).toBeDefined();
    expect(ethCall?.headers.authorization).toBe(`Basic ${PRIVATE_RPC_AUTH}`);
    expect(ethCall?.body).toContain("eth_call");
    expectNoOldHost();
  });

  it("falls through to a public provider without the private credential when the private node rejects", async () => {
    routeFetch((call) => {
      if (call.url.includes("tenderly")) return tenderlyDown();
      if (call.url === PRIVATE_RPC_URL) return forbidden();
      return rpcOk();
    });

    const response = await simulate();
    const result = await response.json() as { success: boolean; simulationUnavailable?: boolean };

    expect(response.status).toBe(200);
    expect(result.success).toBe(true);
    expect(result.simulationUnavailable).toBe(true);

    // Private node first, then the first public URL from the shared list.
    expect(recorded[1]?.url).toBe(PRIVATE_RPC_URL);
    const publicCall = recorded.find((call) => call.url !== PRIVATE_RPC_URL && !call.url.includes("tenderly"));
    expect(RPC_URL_LIST.map((url) => `${url.replace(/\/$/, "")}/`)).toContain(publicCall?.url);
    expect(publicCall?.headers.authorization).toBeUndefined();
    expectNoOldHost();
  });

  it("answers with a short message and no transport detail when every provider rejects", async () => {
    routeFetch((call) => {
      if (call.url.includes("tenderly")) return tenderlyDown();
      return forbidden();
    });

    const response = await simulate();
    const result = await response.json() as { success: boolean; errorMessage: string };
    const bodyText = JSON.stringify(result);

    expect(response.status).toBe(400);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe(NETWORK_DOWN_MESSAGE);
    expect(bodyText.toLowerCase()).not.toContain("http");
    expect(bodyText).not.toContain(CALLDATA.slice(2));
    expect(bodyText).not.toContain("rpc");
    expectNoOldHost();
  });

  it("reports a revert without leaking the provider error text", async () => {
    routeFetch((call) => {
      if (call.url.includes("tenderly")) return tenderlyDown();
      return rpcRevert();
    });

    const response = await simulate();
    const result = await response.json() as { success: boolean; errorMessage: string };
    const bodyText = JSON.stringify(result);

    expect(response.status).toBe(400);
    expect(result.success).toBe(false);
    // The node's revert reason, never viem's transport text or its wrapper wording.
    expect(result.errorMessage).toBe("Too little received");
    expect(bodyText).not.toContain("private.node.example");
    expect(bodyText).not.toContain(CALLDATA.slice(2));
    expectNoOldHost();
  });

  it("logs no URL path or key in the fallback detail", async () => {
    vi.stubEnv("DEBUG_RPC_URL", PRIVATE_RPC_SECRET_URL);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    routeFetch((call) => {
      if (call.url.includes("tenderly")) return tenderlyDown();
      return forbidden();
    });

    const response = await simulate();
    expect(response.status).toBe(400);

    // The key-bearing URL really was called, so the log assertions below are about it.
    expect(recorded.some((call) => call.url === PRIVATE_RPC_SECRET_URL)).toBe(true);

    const logged = logSpy.mock.calls.map((args) => JSON.stringify(args));
    for (const line of logged) {
      expect(line).not.toContain("secret-key");
      expect(line).not.toContain("/rpc/");
    }

    const details = logSpy.mock.calls
      .map((args) => args[1])
      .filter((value): value is string => typeof value === "string")
      .map((value) => JSON.parse(value) as { detail?: unknown })
      .map((entry) => entry.detail)
      .filter((detail): detail is string => typeof detail === "string");

    // The detail drops the transport's URL line outright, so no host survives —
    // the key cannot be split back out of a truncated path either.
    expect(details.length).toBeGreaterThan(0);
    for (const detail of details) {
      expect(detail).not.toContain("://");
      expect(detail).not.toContain("/rpc/");
      expect(detail).not.toContain("node.example");
    }
  });

  it("names an insufficient balance instead of a network failure", async () => {
    routeFetch((call) => {
      if (call.url.includes("tenderly")) return tenderlyDown();
      return rpcInsufficientFunds();
    });

    const response = await simulate();
    const result = await response.json() as { success: boolean; errorMessage: string };

    expect(response.status).toBe(400);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe("Not enough balance to cover this transaction and its gas");
    expectNoOldHost();
  });

  it("logs no key, path, request body or calldata when the first provider rejects with a JSON-RPC code", async () => {
    vi.stubEnv("DEBUG_RPC_URL", PRIVATE_RPC_SECRET_URL);
    const logs = captureLogs();
    routeFetch((call) => {
      if (call.url.includes("tenderly")) return tenderlyDown();
      if (call.url === PRIVATE_RPC_SECRET_URL) return rpcError(-32003, "transaction rejected");
      return forbidden();
    });

    const response = await simulate();

    expect(response.status).toBe(400);
    // The transport stops at the first provider for this code, so its error is the one
    // that reaches the log; the key-bearing URL really was the one that answered.
    expect(recorded.some((call) => call.url === PRIVATE_RPC_SECRET_URL)).toBe(true);
    expectNoProviderDetail(logs.lines);
    expect(
      logs.events().some((event) => event.event === "stage_error" && event.stage === "eth_call"),
    ).toBe(true);
  });

  it("logs no key, path, request body or calldata when the first provider reverts", async () => {
    vi.stubEnv("DEBUG_RPC_URL", PRIVATE_RPC_SECRET_URL);
    const logs = captureLogs();
    routeFetch((call) => {
      if (call.url.includes("tenderly")) return tenderlyDown();
      if (call.url === PRIVATE_RPC_SECRET_URL) {
        return rpcError(3, "execution reverted: Too little received");
      }
      return forbidden();
    });

    const response = await simulate();

    expect(response.status).toBe(400);
    expect(recorded.some((call) => call.url === PRIVATE_RPC_SECRET_URL)).toBe(true);
    expectNoProviderDetail(logs.lines);
    expect(
      logs.events().some((event) => event.event === "stage_error" && event.stage === "eth_call"),
    ).toBe(true);
  });

  it("fails over to the next provider when the private node never answers", async () => {
    routeFetch((call, init) => {
      if (call.url.includes("tenderly")) return tenderlyDown();
      if (call.url === PRIVATE_RPC_URL) return hangingProvider(call, init);
      return rpcOk();
    });

    const response = await simulate();
    const result = await response.json() as { success: boolean; simulationUnavailable?: boolean };

    expect(response.status).toBe(200);
    expect(result.success).toBe(true);
    expect(result.simulationUnavailable).toBe(true);
    // The hang was given up on inside the stage budget and another host answered.
    expect(
      recorded.some((call) => call.url !== PRIVATE_RPC_URL && !call.url.includes("tenderly")),
    ).toBe(true);
  });

  it("shows a token's own revert reason rather than a balance problem", async () => {
    routeFetch((call) => {
      if (call.url.includes("tenderly")) return tenderlyDown();
      return rpcRevertReason("ERC20: transfer amount exceeds balance");
    });

    const response = await simulate();
    const result = await response.json() as { success: boolean; errorMessage: string };

    expect(response.status).toBe(400);
    expect(result.errorMessage).toBe("ERC20: transfer amount exceeds balance");
    expect(result.errorMessage).not.toBe("Not enough balance to cover this transaction and its gas");
  });

  it("reports a revert worded without \"execution reverted\" as a revert", async () => {
    routeFetch((call) => {
      if (call.url.includes("tenderly")) return tenderlyDown();
      return rpcError(-32015, "VM execution error.");
    });

    const response = await simulate();
    const result = await response.json() as { success: boolean; errorMessage: string };

    expect(response.status).toBe(400);
    expect(result.errorMessage).toBe("Transaction would revert");
  });

  it("strips control characters and links from a revert reason and bounds its length", async () => {
    routeFetch((call) => {
      if (call.url.includes("tenderly")) return tenderlyDown();
      return rpcRevertReason("see https://evil.example/x?k=1 \u0007 now");
    });

    const response = await simulate();
    const result = await response.json() as { success: boolean; errorMessage: string };
    const errorMessage = result.errorMessage ?? "";

    expect(response.status).toBe(400);
    expect(errorMessage.length).toBeGreaterThan(0);
    expect(errorMessage.length).toBeLessThanOrEqual(120);
    // A URL inside a contract's own reason is its text, but it must not be shown as one.
    expect(errorMessage).toContain("[link removed]");
    expect(errorMessage).not.toContain("evil.example");
    expect(errorMessage.toLowerCase()).not.toContain("http");
    expect(/[\u0000-\u001f\u007f]/.test(errorMessage)).toBe(false);
  });

  it("replaces a link inside a revert reason with a placeholder", async () => {
    routeFetch((call) => {
      if (call.url.includes("tenderly")) return tenderlyDown();
      return rpcRevertReason("Claim refund at https://evil.example/claim now");
    });

    const response = await simulate();
    const result = await response.json() as { success: boolean; errorMessage: string };

    expect(response.status).toBe(400);
    expect(result.errorMessage).toBe("Claim refund at [link removed] now");
  });

  it("removes a www link from a revert reason", async () => {
    routeFetch((call) => {
      if (call.url.includes("tenderly")) return tenderlyDown();
      return rpcRevertReason("visit www.evil.example/x");
    });

    const response = await simulate();
    const result = await response.json() as { success: boolean; errorMessage: string };

    expect(response.status).toBe(400);
    expect(result.errorMessage).not.toContain("evil.example");
    expect(result.errorMessage).not.toContain("www.");
  });

  it("removes a bare host with a path from a revert reason", async () => {
    routeFetch((call) => {
      if (call.url.includes("tenderly")) return tenderlyDown();
      return rpcRevertReason("evil.example/claim?a=1");
    });

    const response = await simulate();
    const result = await response.json() as { success: boolean; errorMessage: string };

    expect(response.status).toBe(400);
    expect(result.errorMessage).not.toContain("evil.example");
    // Nothing but a link was left, so the generic revert wording applies.
    expect(result.errorMessage).toBe("Transaction would revert");
  });

  it("reports a revert reason that is only a link as a revert", async () => {
    routeFetch((call) => {
      if (call.url.includes("tenderly")) return tenderlyDown();
      return rpcRevertReason("https://evil.example");
    });

    const response = await simulate();
    const result = await response.json() as { success: boolean; errorMessage: string };

    expect(response.status).toBe(400);
    expect(result.errorMessage).toBe("Transaction would revert");
  });

  it("leaves a revert reason with a dot and slash but no link unchanged", async () => {
    routeFetch((call) => {
      if (call.url.includes("tenderly")) return tenderlyDown();
      return rpcRevertReason("Too little received (min 1.5/2)");
    });

    const response = await simulate();
    const result = await response.json() as { success: boolean; errorMessage: string };

    expect(response.status).toBe(400);
    expect(result.errorMessage).toBe("Too little received (min 1.5/2)");
  });

  it("does not report a gateway error body that merely says \"reverted\" as a revert", async () => {
    routeFetch((call) => {
      if (call.url.includes("tenderly")) return tenderlyDown();
      return new Response("upstream reverted connection", { status: 502 });
    });

    const response = await simulate();
    const result = await response.json() as { success: boolean; errorMessage: string };

    expect(response.status).toBe(400);
    expect(result.errorMessage).toBe(NETWORK_DOWN_MESSAGE);
    expect(result.errorMessage).not.toBe("Transaction would revert");
  });

  it("names an out-of-gas answer", async () => {
    routeFetch((call) => {
      if (call.url.includes("tenderly")) return tenderlyDown();
      return rpcError(-32000, "out of gas");
    });

    const response = await simulate();
    const result = await response.json() as { success: boolean; errorMessage: string };

    expect(response.status).toBe(400);
    expect(result.errorMessage).toBe("Transaction would run out of gas");
  });

  it("names a gas-required-exceeds-allowance answer as out of gas", async () => {
    routeFetch((call) => {
      if (call.url.includes("tenderly")) return tenderlyDown();
      return rpcError(-32000, "gas required exceeds allowance (30000000)");
    });

    const response = await simulate();
    const result = await response.json() as { success: boolean; errorMessage: string };

    expect(response.status).toBe(400);
    expect(result.errorMessage).toBe("Transaction would run out of gas");
  });

  it("redacts a provider URL that sits inside a long log line", async () => {
    vi.stubEnv("DEBUG_RPC_URL", PRIVATE_RPC_SECRET_URL);
    const logs = captureLogs();
    // The URL sits early in the message, so the 300-character cut cannot be what
    // keeps the key out of the log: only the redaction itself can.
    routeFetch((call) => {
      if (call.url.includes("tenderly")) return tenderlyDown();
      if (call.url === PRIVATE_RPC_SECRET_URL) {
        return rpcError(-32003, `upstream ${PRIVATE_RPC_SECRET_URL} refused the call`);
      }
      return forbidden();
    });

    const response = await simulate();

    expect(response.status).toBe(400);
    expect(recorded.some((call) => call.url === PRIVATE_RPC_SECRET_URL)).toBe(true);
    const text = logs.lines.join("\n");
    // The host survives, so the message really reached the log…
    expect(text).toContain("private.node.example");
    // …and its key-bearing path did not.
    expect(text).not.toContain("secret-key");
    expect(text).not.toContain("/rpc/");
  });
});
