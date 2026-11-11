import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/app/debug/DebugPageClient", () => ({ default: () => null }));

import DebugPage from "@/app/debug/page";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/debug page gate", () => {
  it("returns a 404 in a production build when the flag is not set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_DEBUG_PAGE", "");

    expect(() => DebugPage()).toThrow("NEXT_NOT_FOUND");
  });

  it("renders in a production build when the flag was set at build time", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_DEBUG_PAGE", "1");

    expect(() => DebugPage()).not.toThrow();
  });

  it("renders in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_DEBUG_PAGE", "");

    expect(() => DebugPage()).not.toThrow();
  });
});
