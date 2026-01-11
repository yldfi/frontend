"use client";

import { useState, useEffect } from "react";

/**
 * Returns a debounced version of the value that only updates
 * after the specified delay has passed without the value changing.
 *
 * @param value The value to debounce
 * @param delay Delay in milliseconds (default: 300ms)
 * @returns The debounced value
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);

  return debouncedValue;
}
