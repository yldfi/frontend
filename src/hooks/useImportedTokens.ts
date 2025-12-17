"use client";

import { useState, useEffect, useCallback } from "react";
import type { EnsoToken } from "@/types/enso";

const STORAGE_KEY = "yldfi-imported-tokens";

/**
 * Hook to manage user-imported tokens with localStorage persistence
 */
export function useImportedTokens() {
  const [importedTokens, setImportedTokens] = useState<EnsoToken[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          setImportedTokens(parsed);
        }
      }
    } catch (e) {
      console.error("Failed to load imported tokens:", e);
    }
    setIsLoaded(true);
  }, []);

  // Save to localStorage when tokens change
  useEffect(() => {
    if (isLoaded) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(importedTokens));
      } catch (e) {
        console.error("Failed to save imported tokens:", e);
      }
    }
  }, [importedTokens, isLoaded]);

  // Add a token
  const addToken = useCallback((token: EnsoToken) => {
    setImportedTokens((prev) => {
      // Check if already exists
      if (prev.some((t) => t.address.toLowerCase() === token.address.toLowerCase())) {
        return prev;
      }
      return [...prev, token];
    });
  }, []);

  // Remove a token
  const removeToken = useCallback((address: string) => {
    setImportedTokens((prev) =>
      prev.filter((t) => t.address.toLowerCase() !== address.toLowerCase())
    );
  }, []);

  // Check if a token is imported
  const isImported = useCallback(
    (address: string) => {
      return importedTokens.some(
        (t) => t.address.toLowerCase() === address.toLowerCase()
      );
    },
    [importedTokens]
  );

  return {
    importedTokens,
    addToken,
    removeToken,
    isImported,
    isLoaded,
  };
}
