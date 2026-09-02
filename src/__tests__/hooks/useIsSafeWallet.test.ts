import { renderHook } from "@testing-library/react";
import { useReadContracts } from "wagmi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSafeAccountResult,
  useIsSafeWallet,
} from "@/hooks/useIsSafeWallet";

const mockUseReadContracts = vi.mocked(useReadContracts);
const ADDRESS = "0x8baecb301FD723Ff35FB1D9a6d595cAD35618A6f" as const;

describe("useIsSafeWallet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recognizes a valid Safe owner set and threshold", () => {
    expect(isSafeAccountResult([ADDRESS], 1n, "1.4.1")).toBe(true);
    expect(isSafeAccountResult([ADDRESS], 0n, "1.4.1")).toBe(false);
    expect(isSafeAccountResult([ADDRESS], 2n, "1.4.1")).toBe(false);
    expect(isSafeAccountResult([ADDRESS], 1n, undefined)).toBe(false);
    expect(isSafeAccountResult(undefined, undefined, undefined)).toBe(false);
  });

  it("identifies an account when both Safe reads succeed", () => {
    mockUseReadContracts.mockReturnValue({
      data: [
        { status: "success", result: [ADDRESS] },
        { status: "success", result: 1n },
        { status: "success", result: "1.4.1" },
      ],
    } as ReturnType<typeof useReadContracts>);

    const { result } = renderHook(() => useIsSafeWallet(ADDRESS, 1));

    expect(result.current).toBe(true);
    expect(mockUseReadContracts).toHaveBeenCalledWith(expect.objectContaining({
      allowFailure: true,
      query: expect.objectContaining({ enabled: true, retry: false }),
    }));
  });

  it("does not label EOAs or incompatible contracts as Safe", () => {
    mockUseReadContracts.mockReturnValue({
      data: [
        { status: "failure", error: new Error("execution reverted") },
        { status: "failure", error: new Error("execution reverted") },
        { status: "failure", error: new Error("execution reverted") },
      ],
    } as ReturnType<typeof useReadContracts>);

    const { result } = renderHook(() => useIsSafeWallet(ADDRESS, 1));

    expect(result.current).toBe(false);
  });

  it("disables reads until an account and chain are available", () => {
    mockUseReadContracts.mockReturnValue({
      data: undefined,
    } as ReturnType<typeof useReadContracts>);

    renderHook(() => useIsSafeWallet(undefined, undefined));

    expect(mockUseReadContracts).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.objectContaining({ enabled: false }),
    }));
  });
});
