import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useIdle } from "@/hooks/useIdle";

describe("useIdle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("goes idle after the timeout with no activity", () => {
    const { result } = renderHook(() => useIdle(1000));
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(999); });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(true);
  });

  it("clicks and key presses reset the timer and clear idle", () => {
    const { result } = renderHook(() => useIdle(1000));
    act(() => { vi.advanceTimersByTime(800); window.dispatchEvent(new Event("pointerdown")); });
    act(() => { vi.advanceTimersByTime(800); });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(300); });
    expect(result.current).toBe(true);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown")); });
    expect(result.current).toBe(false);
  });

  it("returning to the tab counts as activity", () => {
    const { result } = renderHook(() => useIdle(1000));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current).toBe(true);
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(result.current).toBe(false);
  });

  it("mouse movement alone does not keep it active", () => {
    const { result } = renderHook(() => useIdle(1000));
    act(() => { vi.advanceTimersByTime(600); window.dispatchEvent(new Event("mousemove")); });
    act(() => { vi.advanceTimersByTime(400); });
    expect(result.current).toBe(true);
  });
});
