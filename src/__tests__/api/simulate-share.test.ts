// @vitest-environment node
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET } from "@/app/api/simulate/share/[simulationId]/route";
import { shareLinkPayload } from "@/lib/simulation-nonce";

const SECRET = "share-secret-key-test";
const ACCOUNT = "acct";
const PROJECT = "proj";
const SIMULATION_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function sign(simulationId: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(shareLinkPayload(simulationId)).digest("base64url");
}

function request(simulationId: string, signature?: string) {
  const url = new URL(`https://yldfi.co/api/simulate/share/${simulationId}`);
  if (signature !== undefined) url.searchParams.set("sig", signature);
  return new NextRequest(url);
}

function get(simulationId: string, signature?: string) {
  return GET(request(simulationId, signature), { params: Promise.resolve({ simulationId }) });
}

beforeEach(() => {
  vi.stubEnv("TENDERLY_ACCOUNT_SLUG", ACCOUNT);
  vi.stubEnv("TENDERLY_PROJECT_SLUG", PROJECT);
  vi.stubEnv("TENDERLY_ACCESS_KEY", "fixture-only");
  vi.stubEnv("SIMULATION_NONCE_SECRET", SECRET);
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("GET /api/simulate/share/[simulationId]", () => {
  it("refuses to run without Tenderly credentials", async () => {
    vi.stubEnv("TENDERLY_ACCESS_KEY", "");

    const response = await get(SIMULATION_ID, sign(SIMULATION_ID));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Tenderly not configured" });
  });

  it.each([
    ["an empty id", ""],
    ["an underscore", "abc_def"],
    ["a slash", "abc/def"],
    ["markup", "abc<script>"],
    ["spaces", "abc def"],
  ])("rejects %s before verifying the signature", async (_label, simulationId) => {
    const response = await get(simulationId, sign(simulationId));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid simulation ID" });
  });

  it("accepts uppercase and dash-free hex ids", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));

    for (const simulationId of [SIMULATION_ID.toUpperCase(), SIMULATION_ID.replace(/-/g, "")]) {
      const response = await get(simulationId, sign(simulationId));
      expect(response.status).toBe(200);
    }
  });

  it("rejects a request without a signature", async () => {
    const response = await get(SIMULATION_ID);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("rejects a signature that was made for another simulation id", async () => {
    const response = await get(SIMULATION_ID, sign("a1b2c3d4-e5f6-7890-abcd-ef0000000000"));

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a signature made with another secret", async () => {
    const response = await get(SIMULATION_ID, sign(SIMULATION_ID, "wrong-secret"));

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a request when the nonce secret is not configured", async () => {
    vi.stubEnv("SIMULATION_NONCE_SECRET", "");

    const response = await get(SIMULATION_ID, sign(SIMULATION_ID));

    expect(response.status).toBe(403);
  });

  it("shares the simulation through Tenderly and returns the public url", async () => {
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    const response = await get(SIMULATION_ID, sign(SIMULATION_ID));

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.tenderly.co/api/v1/account/${ACCOUNT}/project/${PROJECT}/simulations/${SIMULATION_ID}/share`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: `https://dashboard.tenderly.co/shared/simulation/${SIMULATION_ID}`,
    });
  });

  it("falls back to the dashboard url when Tenderly refuses to share", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    const response = await get(SIMULATION_ID, sign(SIMULATION_ID));

    await expect(response.json()).resolves.toEqual({
      url: `https://dashboard.tenderly.co/${ACCOUNT}/${PROJECT}/simulator/${SIMULATION_ID}`,
    });
  });

  it("falls back to the dashboard url when the share request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("network down"))));

    const response = await get(SIMULATION_ID, sign(SIMULATION_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: `https://dashboard.tenderly.co/${ACCOUNT}/${PROJECT}/simulator/${SIMULATION_ID}`,
    });
  });
});
