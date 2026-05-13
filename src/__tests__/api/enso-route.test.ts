import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetBundleData } = vi.hoisted(() => ({
  mockGetBundleData: vi.fn(),
}));

vi.mock("@ensofinance/sdk", () => ({
  EnsoClient: class MockEnsoClient {
    getBundleData = mockGetBundleData;
  },
}));

import { POST } from "@/app/api/enso/[method]/route";

function request(body: Record<string, unknown>): Request {
  return new Request("https://yldfi.co/api/enso/bundle", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://yldfi.co",
    },
    body: JSON.stringify(body),
  });
}

describe("Enso API route boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ENSO_API_KEY", "test-key");
  });

  it("rejects public raw bundle actions before calling Enso", async () => {
    const response = await POST(
      request({
        fromAddress: "0x1234567890123456789012345678901234567890",
        actions: [],
      }) as never,
      { params: Promise.resolve({ method: "bundle" }) }
    );

    await expect(response.json()).resolves.toEqual({
      error: "Raw Enso bundle actions are disabled; use /api/enso/intent",
    });
    expect(response.status).toBe(410);
    expect(mockGetBundleData).not.toHaveBeenCalled();
  });
});
