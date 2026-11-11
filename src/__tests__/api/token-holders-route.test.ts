// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The route reads the key into a module-level constant, so stub it before import.
const { TEST_API_KEY } = vi.hoisted(() => {
  const key = "test-token-holder-api-key";
  vi.stubEnv("TOKEN_HOLDER_API_KEY", key);
  return { TEST_API_KEY: key };
});

import { GET, POST } from "@/app/api/token-holders/route";

const ADDRESS = "0x1234567890123456789012345678901234567890";

function post(body: unknown, ip = "203.0.113.10") {
  return POST(
    new NextRequest("https://yldfi.co/api/token-holders", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": TEST_API_KEY,
        "x-forwarded-for": ip,
      },
      body: JSON.stringify(body),
    })
  );
}

describe("Token holders API route", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("rejects a non-numeric minBalance with the fixed text before fetching", async () => {
    const response = await post({ token: ADDRESS, minBalance: "not-a-number" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Invalid minBalance",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not reveal whether the API key is configured", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
