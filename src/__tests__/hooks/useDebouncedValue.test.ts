import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

describe("useDebouncedValue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns initial value immediately", () => {
    const { result } = renderHook(() => useDebouncedValue("test", 300));
    expect(result.current).toBe("test");
  });

  it("debounces value changes", () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebouncedValue(value, delay),
      { initialProps: { value: "initial", delay: 300 } }
    );

    expect(result.current).toBe("initial");

    // Change value
    rerender({ value: "updated", delay: 300 });

    // Value shouldn't update immediately
    expect(result.current).toBe("initial");

    // Advance time but not enough
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe("initial");

    // Advance past the delay
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe("updated");
  });

  it("uses default delay of 300ms", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value),
      { initialProps: { value: "initial" } }
    );

    rerender({ value: "updated" });
    expect(result.current).toBe("initial");

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe("initial");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("updated");
  });

  it("resets timer on rapid value changes", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 300),
      { initialProps: { value: "first" } }
    );

    rerender({ value: "second" });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // Change again before timer completes
    rerender({ value: "third" });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // Should still be "first" because timer reset
    expect(result.current).toBe("first");

    // Now advance past new delay
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe("third"); // Skipped "second"
  });

  it("works with numbers", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 100),
      { initialProps: { value: 0 } }
    );

    rerender({ value: 42 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe(42);
  });

  it("works with objects", () => {
    const initialObj = { count: 0 };
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 100),
      { initialProps: { value: initialObj } }
    );

    const newObj = { count: 1 };
    rerender({ value: newObj });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toEqual({ count: 1 });
  });

  it("works with null", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue<string | null>(value, 100),
      { initialProps: { value: "test" as string | null } }
    );

    rerender({ value: null });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBeNull();
  });

  it("cleans up timer on unmount", () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

    const { unmount, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 300),
      { initialProps: { value: "initial" } }
    );

    rerender({ value: "updated" });
    unmount();

    // Timer should be cleared on unmount
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it("handles delay change", () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebouncedValue(value, delay),
      { initialProps: { value: "test", delay: 100 } }
    );

    rerender({ value: "updated", delay: 500 });

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe("test");

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current).toBe("updated");
  });
});
