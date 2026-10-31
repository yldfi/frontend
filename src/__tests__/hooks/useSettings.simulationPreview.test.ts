import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAccount } from "wagmi";

import { useIsSafeWallet } from "@/hooks/useIsSafeWallet";
import { useSettings } from "@/hooks/useSettings";
import { SIMULATION_PREVIEW_KEY, resolveSimulationPreview } from "@/lib/simulation-preview-setting";

vi.mock("@/hooks/useIsSafeWallet", () => ({ useIsSafeWallet: vi.fn() }));

// vitest.setup.ts stubs localStorage with no-op mocks; these tests need storage.
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
    key: (i) => [...data.keys()][i] ?? null,
    get length() { return data.size; },
  };
}

describe("simulation preview default", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.mocked(useAccount).mockReturnValue({
      address: "0x8baecb301FD723Ff35FB1D9a6d595cAD35618A6f",
      chainId: 1,
    } as unknown as ReturnType<typeof useAccount>);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("an explicit choice wins; without one, only Safes get the preview", () => {
    expect(resolveSimulationPreview(null, true)).toBe(true);
    expect(resolveSimulationPreview(null, false)).toBe(false);
    expect(resolveSimulationPreview(false, true)).toBe(false);
    expect(resolveSimulationPreview(true, false)).toBe(true);
  });

  it("turns the preview on for a Safe with no stored setting (e.g. inside the Safe App frame)", () => {
    vi.mocked(useIsSafeWallet).mockReturnValue(true);
    const { result } = renderHook(() => useSettings());
    expect(result.current.showSimulationPreview).toBe(true);
  });

  it("keeps the old default (off) for other wallets", () => {
    vi.mocked(useIsSafeWallet).mockReturnValue(false);
    const { result } = renderHook(() => useSettings());
    expect(result.current.showSimulationPreview).toBe(false);
  });

  it("respects a Safe user who turned the preview off, and persists changes", () => {
    vi.mocked(useIsSafeWallet).mockReturnValue(true);
    localStorage.setItem(SIMULATION_PREVIEW_KEY, "false");
    const { result } = renderHook(() => useSettings());
    expect(result.current.showSimulationPreview).toBe(false);

    act(() => result.current.setShowSimulationPreview(true));
    expect(result.current.showSimulationPreview).toBe(true);
    expect(localStorage.getItem(SIMULATION_PREVIEW_KEY)).toBe("true");
  });
});
