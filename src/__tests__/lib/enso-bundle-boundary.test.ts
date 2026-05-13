import { describe, expect, it, vi } from "vitest";

vi.mock("@ensofinance/sdk", () => ({
  EnsoClient: class MockEnsoClient {},
}));

import { fetchBundle } from "@/lib/enso";

describe("Enso bundle boundary", () => {
  it("does not submit raw bundle actions from the browser", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);

    await expect(
      fetchBundle({
        fromAddress: "0x1234567890123456789012345678901234567890",
        actions: [],
      })
    ).rejects.toThrow(
      "Raw Enso bundle actions cannot be submitted from the browser; use a server-owned Enso intent"
    );

    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/enso/bundle",
      expect.anything()
    );
  });
});
