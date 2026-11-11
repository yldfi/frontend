import { afterEach, describe, expect, it, vi } from "vitest";
import { anvilCall } from "@/lib/tx-utils";
import { runVNetSimulation } from "@/lib/vnet-simulation";
import {
  buildUnavailableSimulationResult,
  getSimulationErrorText,
  runTxPreflight,
} from "@/lib/tx-preflight";
import { simulationNonceBinding } from "@/lib/simulation-nonce";
import type { SimulationResult } from "@/types/enso";

vi.mock("@/lib/tx-utils", () => ({
  anvilCall: vi.fn(),
}));

vi.mock("@/lib/vnet-simulation", () => ({
  runVNetSimulation: vi.fn(),
}));

const userAddress = "0x1234567890123456789012345678901234567890" as const;
const to = "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e" as const;
const data = "0xdeadbeef" as const;
// A sentinel transport, so a VNet simulation test can prove which client the
// shared helper actually forwards.
const transport = { type: "custom", sentinel: "preflight-transport" } as const;
const publicClient = { transport } as unknown as Parameters<typeof runTxPreflight>[0]["publicClient"];

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function nonceResponse() {
  return jsonResponse({
    success: true,
    nonce: "test-nonce",
    expires: Date.now() + 60_000,
    sig: "test-sig",
  });
}

const baseParams = {
  publicClient,
  userAddress,
  tx: { to, data, value: 1500000000000000n },
  ethCall: { account: userAddress, to, data, value: 1500000000000000n },
  simulateBodyExtra: {
    inputToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    spender: "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf",
    approvalTransactions: [{ to, data }],
  },
  vnetValue: "0x5555555555555",
  testNetworkType: null,
  chainId: 1,
  logTag: "[Tenderly Simulation]",
} as const;

const successfulSimulation: SimulationResult = {
  success: true,
  gasUsed: 21000,
  errorMessage: null,
  simulationId: "sim-1",
  tenderlyUrl: "https://example.test/sim-1",
  assetChanges: [],
};

afterEach(() => {
  vi.mocked(anvilCall).mockReset();
  vi.mocked(runVNetSimulation).mockReset();
  vi.mocked(fetch).mockReset();
});

describe("getSimulationErrorText", () => {
  it("returns null for missing or empty errors", () => {
    expect(getSimulationErrorText(null)).toBeNull();
    expect(getSimulationErrorText(undefined)).toBeNull();
    expect(getSimulationErrorText("")).toBeNull();
    expect(getSimulationErrorText({})).toBeNull();
  });

  it("returns a plain string error unchanged", () => {
    expect(getSimulationErrorText("boom")).toBe("boom");
  });

  it("reads message first, then slug", () => {
    expect(getSimulationErrorText({ message: "m", slug: "s" })).toBe("m");
    expect(getSimulationErrorText({ slug: "s" })).toBe("s");
    expect(getSimulationErrorText({ message: "", slug: "s" })).toBe("s");
  });
});

describe("buildUnavailableSimulationResult", () => {
  it("keeps the failed result's fields and marks the simulation unavailable", () => {
    const failed: SimulationResult = {
      success: false,
      gasUsed: null,
      errorMessage: "reverted",
      simulationId: "sim-1",
      tenderlyUrl: "https://example.test/sim-1",
      assetChanges: [{
        type: "send",
        symbol: "USDC",
        amount: "1",
        rawAmount: "1000000",
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        decimals: 6,
      }],
    };

    expect(buildUnavailableSimulationResult(failed, "temporarily unavailable")).toEqual({
      ...failed,
      success: true,
      errorMessage: null,
      simulationUnavailable: true,
      simulationUnavailableReason: "temporarily unavailable",
    });
  });

  it("builds an empty result when there is nothing to keep", () => {
    expect(buildUnavailableSimulationResult(null, "temporarily unavailable")).toEqual({
      success: true,
      gasUsed: null,
      simulationId: null,
      tenderlyUrl: null,
      assetChanges: [],
      errorMessage: null,
      simulationUnavailable: true,
      simulationUnavailableReason: "temporarily unavailable",
    });
  });
});

describe("runTxPreflight", () => {
  it("signs the simulate request with the nonce and runs eth_call in parallel", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url.startsWith("/api/simulate/nonce")) {
        expect(init?.method).toBe("GET");
        return Promise.resolve(jsonResponse({
          success: true,
          nonce: "test-nonce",
          expires: Date.now() + 60_000,
          sig: "test-sig",
        }));
      }
      if (url === "/api/simulate") {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Promise.resolve(jsonResponse(successfulSimulation));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
    vi.mocked(anvilCall).mockResolvedValue(undefined);

    const { simResult, ethCallResult } = await runTxPreflight(baseParams);

    expect(simResult.ok).toBe(true);
    expect(simResult.result).toEqual(successfulSimulation);
    expect(ethCallResult.ok).toBe(true);
    expect(anvilCall).toHaveBeenCalledWith(publicClient, baseParams.ethCall);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({
      from: userAddress,
      to,
      data,
      value: "1500000000000000",
      inputToken: baseParams.simulateBodyExtra.inputToken,
      spender: baseParams.simulateBodyExtra.spender,
      approvalTransactions: baseParams.simulateBodyExtra.approvalTransactions,
      nonce: "test-nonce",
      expires: expect.any(Number),
      sig: "test-sig",
    });
  });

  it("binds the nonce request to the body it posts", async () => {
    let nonceUrl: string | undefined;
    const bodies: Record<string, unknown>[] = [];
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url.startsWith("/api/simulate/nonce")) {
        nonceUrl = url;
        return Promise.resolve(nonceResponse());
      }
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Promise.resolve(jsonResponse(successfulSimulation));
    });
    vi.mocked(anvilCall).mockResolvedValue(undefined);

    const { simResult } = await runTxPreflight(baseParams);

    expect(simResult.ok).toBe(true);
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as { from: string; to: string; data: string; value?: string };
    const bind = new URL(nonceUrl as string, "http://localhost").searchParams.get("bind");
    expect(bind).toBe(simulationNonceBinding({
      from: body.from,
      to: body.to,
      data: body.data,
      value: body.value,
    }));
  });

  it("keeps the bound request fields when extras try to override them", async () => {
    let nonceUrl: string | undefined;
    const bodies: Record<string, unknown>[] = [];
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url.startsWith("/api/simulate/nonce")) {
        nonceUrl = url;
        return Promise.resolve(nonceResponse());
      }
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Promise.resolve(jsonResponse(successfulSimulation));
    });
    vi.mocked(anvilCall).mockResolvedValue(undefined);

    // Extras collide with every field the nonce is bound to.
    const { simResult } = await runTxPreflight({
      ...baseParams,
      simulateBodyExtra: {
        ...baseParams.simulateBodyExtra,
        from: "0x0000000000000000000000000000000000000001",
        to: "0x0000000000000000000000000000000000000002",
        data: "0xcafebabe",
        value: "1",
      },
    });

    expect(simResult.ok).toBe(true);
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as { from: string; to: string; data: string; value?: string };
    expect(body.from).toBe(userAddress);
    expect(body.to).toBe(to);
    expect(body.data).toBe(data);
    expect(body.value).toBe("1500000000000000");
    // The nonce request and the POSTed body still agree on the bound fields.
    const bind = new URL(nonceUrl as string, "http://localhost").searchParams.get("bind");
    expect(bind).toBe(simulationNonceBinding({
      from: body.from,
      to: body.to,
      data: body.data,
      value: body.value,
    }));
  });

  it("fails before the simulate POST when the nonce is missing", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: false }));
    vi.mocked(anvilCall).mockResolvedValue(undefined);

    const { simResult } = await runTxPreflight(baseParams);

    expect(simResult).toEqual({
      ok: false,
      errorMessage: "Failed to obtain simulation nonce",
      retryable: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/simulate/nonce?bind="),
      expect.anything(),
    );
  });

  it("returns the failed simulation result when Tenderly reports a revert", async () => {
    const failed = {
      success: false,
      gasUsed: null,
      errorMessage: "reverted",
      simulationId: null,
      tenderlyUrl: null,
      assetChanges: [],
      retryable: false,
    };
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.startsWith("/api/simulate/nonce")) {
        return Promise.resolve(jsonResponse({
          success: true,
          nonce: "test-nonce",
          expires: Date.now() + 60_000,
          sig: "test-sig",
        }));
      }
      return Promise.resolve(jsonResponse(failed));
    });
    vi.mocked(anvilCall).mockResolvedValue(undefined);

    const { simResult } = await runTxPreflight(baseParams);

    expect(simResult.ok).toBe(false);
    expect(simResult.errorMessage).toBe("reverted");
    expect(simResult.retryable).toBe(false);
    expect(simResult.result).toEqual(failed);
  });

  it("marks a simulate timeout as retryable", async () => {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.startsWith("/api/simulate/nonce")) {
        return Promise.resolve(jsonResponse({
          success: true,
          nonce: "test-nonce",
          expires: Date.now() + 60_000,
          sig: "test-sig",
        }));
      }
      return Promise.reject(new Error("timeout"));
    });
    vi.mocked(anvilCall).mockResolvedValue(undefined);

    const { simResult } = await runTxPreflight(baseParams);

    expect(simResult).toEqual({
      ok: false,
      result: null,
      errorMessage: "timeout",
      retryable: true,
    });
  });

  it("reports an eth_call revert alongside the simulation result", async () => {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.startsWith("/api/simulate/nonce")) {
        return Promise.resolve(jsonResponse({
          success: true,
          nonce: "test-nonce",
          expires: Date.now() + 60_000,
          sig: "test-sig",
        }));
      }
      return Promise.resolve(jsonResponse(successfulSimulation));
    });
    vi.mocked(anvilCall).mockRejectedValue(new Error("execution reverted"));

    const { ethCallResult } = await runTxPreflight(baseParams);

    expect(ethCallResult).toEqual({ ok: false, errorMessage: "execution reverted" });
  });

  it("uses the VNet RPC simulation with the caller's value format", async () => {
    vi.mocked(runVNetSimulation).mockResolvedValue({
      ok: true,
      result: successfulSimulation,
    });
    vi.mocked(anvilCall).mockResolvedValue(undefined);

    const { simResult } = await runTxPreflight({
      ...baseParams,
      testNetworkType: "tenderly",
      vnetValue: "0x5555555555555",
    });

    expect(simResult.ok).toBe(true);
    expect(runVNetSimulation).toHaveBeenCalledWith(
      transport,
      { from: userAddress, to, data, value: "0x5555555555555" },
      userAddress,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the simulate body even when the response is not a 200", async () => {
    const failed = {
      success: false,
      gasUsed: null,
      errorMessage: "Tenderly upstream error",
      simulationId: null,
      tenderlyUrl: null,
      assetChanges: [],
    };
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.startsWith("/api/simulate/nonce")) return Promise.resolve(nonceResponse());
      return Promise.resolve(jsonResponse(failed, 500));
    });
    vi.mocked(anvilCall).mockResolvedValue(undefined);

    const { simResult } = await runTxPreflight(baseParams);

    // The helper reads the body unconditionally: a non-200 still surfaces the
    // failed result and its message (rather than a generic transport error).
    expect(simResult).toEqual({
      ok: false,
      result: failed,
      errorMessage: "Tenderly upstream error",
      retryable: false,
    });
  });

  it("treats an unparseable simulate body as a retryable failure", async () => {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.startsWith("/api/simulate/nonce")) return Promise.resolve(nonceResponse());
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0");
        },
      } as unknown as Response);
    });
    vi.mocked(anvilCall).mockResolvedValue(undefined);

    const { simResult } = await runTxPreflight(baseParams);

    expect(simResult).toEqual({
      ok: false,
      result: null,
      errorMessage: "Unexpected token < in JSON at position 0",
      retryable: true,
    });
  });

  it("fails as retryable when the nonce request itself rejects", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("nonce endpoint unavailable"));
    vi.mocked(anvilCall).mockResolvedValue(undefined);

    const { simResult, ethCallResult } = await runTxPreflight(baseParams);

    expect(simResult).toEqual({
      ok: false,
      result: null,
      errorMessage: "nonce endpoint unavailable",
      retryable: true,
    });
    expect(ethCallResult).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/simulate/nonce?bind="),
      expect.anything(),
    );
  });

  it("falls back to a generic retryable message when simulate rejects with a non-Error", async () => {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.startsWith("/api/simulate/nonce")) return Promise.resolve(nonceResponse());
      return Promise.reject("gateway exploded");
    });
    vi.mocked(anvilCall).mockResolvedValue(undefined);

    const { simResult } = await runTxPreflight(baseParams);

    expect(simResult).toEqual({
      ok: false,
      result: null,
      errorMessage: "Tenderly simulation failed",
      retryable: true,
    });
  });

  it("falls back to a generic message when the eth_call rejects with a non-Error", async () => {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.startsWith("/api/simulate/nonce")) return Promise.resolve(nonceResponse());
      return Promise.resolve(jsonResponse(successfulSimulation));
    });
    vi.mocked(anvilCall).mockRejectedValue("boom");

    const { simResult, ethCallResult } = await runTxPreflight(baseParams);

    expect(simResult.ok).toBe(true);
    expect(ethCallResult).toEqual({ ok: false, errorMessage: "Unknown error" });
  });

  it("keeps the eth_call-only path for chainId 1337 on the default network", async () => {
    vi.mocked(anvilCall).mockResolvedValue(undefined);

    const { simResult, ethCallResult } = await runTxPreflight({
      ...baseParams,
      testNetworkType: null,
      chainId: 1337,
    });

    expect(simResult).toEqual({ ok: true, result: null });
    expect(ethCallResult).toEqual({ ok: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(runVNetSimulation).not.toHaveBeenCalled();
    expect(anvilCall).toHaveBeenCalledWith(publicClient, baseParams.ethCall);
  });

  it("sends no optional body fields when the caller passes no extras", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url.startsWith("/api/simulate/nonce")) return Promise.resolve(nonceResponse());
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Promise.resolve(jsonResponse(successfulSimulation));
    });
    vi.mocked(anvilCall).mockResolvedValue(undefined);

    const { simResult } = await runTxPreflight({ ...baseParams, simulateBodyExtra: undefined });

    expect(simResult.ok).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("inputToken");
    expect(bodies[0]).not.toHaveProperty("spender");
    expect(bodies[0]).not.toHaveProperty("approvalTransactions");
    expect(bodies[0]).toEqual({
      from: userAddress,
      to,
      data,
      value: "1500000000000000",
      nonce: "test-nonce",
      expires: expect.any(Number),
      sig: "test-sig",
    });
  });

  it("skips both simulations on an anvil fork", async () => {
    vi.mocked(anvilCall).mockResolvedValue(undefined);

    const { simResult } = await runTxPreflight({
      ...baseParams,
      testNetworkType: "anvil",
      chainId: 31337,
    });

    expect(simResult).toEqual({ ok: true, result: null });
    expect(fetch).not.toHaveBeenCalled();
    expect(runVNetSimulation).not.toHaveBeenCalled();
  });
});
