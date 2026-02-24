import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useImportedTokens } from "@/hooks/useImportedTokens";
import type { EnsoToken } from "@/types/enso";

describe("useImportedTokens", () => {
  const STORAGE_KEY = "yldfi-imported-tokens";
  let mockLocalStorage: { [key: string]: string };

  const createToken = (symbol: string, address: string): EnsoToken => ({
    address,
    chainId: 1,
    name: symbol,
    symbol,
    decimals: 18,
    logoURI: "",
    type: "base",
  });

  beforeEach(() => {
    mockLocalStorage = {};
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => mockLocalStorage[key] || null),
      setItem: vi.fn((key: string, value: string) => {
        mockLocalStorage[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete mockLocalStorage[key];
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("initialization", () => {
    it("returns empty array when localStorage is empty", () => {
      const { result } = renderHook(() => useImportedTokens());
      expect(result.current.importedTokens).toEqual([]);
      expect(result.current.isLoaded).toBe(true);
    });

    it("loads tokens from localStorage on mount", () => {
      const tokens = [createToken("TEST", "0x1234567890123456789012345678901234567890")];
      mockLocalStorage[STORAGE_KEY] = JSON.stringify(tokens);

      const { result } = renderHook(() => useImportedTokens());
      expect(result.current.importedTokens).toHaveLength(1);
      expect(result.current.importedTokens[0].symbol).toBe("TEST");
    });

    it("handles invalid JSON in localStorage gracefully", () => {
      mockLocalStorage[STORAGE_KEY] = "not valid json";

      const { result } = renderHook(() => useImportedTokens());
      expect(result.current.importedTokens).toEqual([]);
    });

    it("handles non-array value in localStorage", () => {
      mockLocalStorage[STORAGE_KEY] = JSON.stringify({ token: "test" });

      const { result } = renderHook(() => useImportedTokens());
      expect(result.current.importedTokens).toEqual([]);
    });
  });

  describe("addToken", () => {
    it("adds a new token", () => {
      const { result } = renderHook(() => useImportedTokens());
      const token = createToken("TEST", "0x1234567890123456789012345678901234567890");

      act(() => {
        result.current.addToken(token);
      });

      expect(result.current.importedTokens).toHaveLength(1);
      expect(result.current.importedTokens[0].symbol).toBe("TEST");
    });

    it("does not add duplicate token (same address)", () => {
      const { result } = renderHook(() => useImportedTokens());
      const token1 = createToken("TEST1", "0x1234567890123456789012345678901234567890");
      const token2 = createToken("TEST2", "0x1234567890123456789012345678901234567890");

      act(() => {
        result.current.addToken(token1);
      });

      act(() => {
        result.current.addToken(token2);
      });

      expect(result.current.importedTokens).toHaveLength(1);
      expect(result.current.importedTokens[0].symbol).toBe("TEST1");
    });

    it("handles case-insensitive address matching", () => {
      const { result } = renderHook(() => useImportedTokens());
      const token1 = createToken("TEST1", "0xaBcDef1234567890123456789012345678901234");
      const token2 = createToken("TEST2", "0xabcdef1234567890123456789012345678901234");

      act(() => {
        result.current.addToken(token1);
      });

      act(() => {
        result.current.addToken(token2);
      });

      expect(result.current.importedTokens).toHaveLength(1);
    });

    it("persists tokens to localStorage after adding", () => {
      const { result } = renderHook(() => useImportedTokens());
      const token = createToken("TEST", "0x1234567890123456789012345678901234567890");

      act(() => {
        result.current.addToken(token);
      });

      expect(localStorage.setItem).toHaveBeenCalledWith(
        STORAGE_KEY,
        expect.stringContaining("TEST")
      );
    });
  });

  describe("removeToken", () => {
    it("removes a token by address", () => {
      const tokens = [
        createToken("ETH", "0x0000000000000000000000000000000000000001"),
        createToken("TEST", "0x1234567890123456789012345678901234567890"),
      ];
      mockLocalStorage[STORAGE_KEY] = JSON.stringify(tokens);

      const { result } = renderHook(() => useImportedTokens());

      act(() => {
        result.current.removeToken("0x1234567890123456789012345678901234567890");
      });

      expect(result.current.importedTokens).toHaveLength(1);
      expect(result.current.importedTokens[0].symbol).toBe("ETH");
    });

    it("handles case-insensitive address matching when removing", () => {
      const tokens = [createToken("TEST", "0xaBcDef1234567890123456789012345678901234")];
      mockLocalStorage[STORAGE_KEY] = JSON.stringify(tokens);

      const { result } = renderHook(() => useImportedTokens());

      act(() => {
        result.current.removeToken("0xabcdef1234567890123456789012345678901234");
      });

      expect(result.current.importedTokens).toHaveLength(0);
    });

    it("does nothing when address not found", () => {
      const tokens = [createToken("TEST", "0x1234567890123456789012345678901234567890")];
      mockLocalStorage[STORAGE_KEY] = JSON.stringify(tokens);

      const { result } = renderHook(() => useImportedTokens());

      act(() => {
        result.current.removeToken("0x9999999999999999999999999999999999999999");
      });

      expect(result.current.importedTokens).toHaveLength(1);
    });
  });

  describe("isImported", () => {
    it("returns true for imported token", () => {
      const tokens = [createToken("TEST", "0x1234567890123456789012345678901234567890")];
      mockLocalStorage[STORAGE_KEY] = JSON.stringify(tokens);

      const { result } = renderHook(() => useImportedTokens());

      expect(result.current.isImported("0x1234567890123456789012345678901234567890")).toBe(true);
    });

    it("returns false for non-imported token", () => {
      const { result } = renderHook(() => useImportedTokens());

      expect(result.current.isImported("0x9999999999999999999999999999999999999999")).toBe(false);
    });

    it("handles case-insensitive matching", () => {
      const tokens = [createToken("TEST", "0xabcdef1234567890123456789012345678901234")];
      mockLocalStorage[STORAGE_KEY] = JSON.stringify(tokens);

      const { result } = renderHook(() => useImportedTokens());

      expect(result.current.isImported("0xaBcDef1234567890123456789012345678901234")).toBe(true);
    });
  });

  describe("localStorage error handling", () => {
    it("handles localStorage.setItem error gracefully", () => {
      vi.stubGlobal("localStorage", {
        getItem: vi.fn(() => null),
        setItem: vi.fn(() => {
          throw new Error("QuotaExceededError");
        }),
        removeItem: vi.fn(),
      });

      const { result } = renderHook(() => useImportedTokens());
      const token = createToken("TEST", "0x1234567890123456789012345678901234567890");

      // Should not throw
      act(() => {
        result.current.addToken(token);
      });

      // Token should still be in state even if localStorage fails
      expect(result.current.importedTokens).toHaveLength(1);
    });
  });
});
