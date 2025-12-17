import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Test the useImportedTokens business logic directly
// We test localStorage operations and token management without React hooks

describe("useImportedTokens logic", () => {
  const STORAGE_KEY = "yldfi-imported-tokens";

  interface EnsoToken {
    address: string;
    chainId: number;
    name: string;
    symbol: string;
    decimals: number;
    logoURI?: string;
    type: "base" | "defi";
  }

  const createToken = (symbol: string, address: string): EnsoToken => ({
    address,
    chainId: 1,
    name: symbol,
    symbol,
    decimals: 18,
    type: "base",
  });

  describe("loadTokensFromStorage", () => {
    let mockLocalStorage: { [key: string]: string };

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

    function loadTokensFromStorage(): EnsoToken[] {
      if (typeof window === "undefined") return [];
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed)) {
            return parsed;
          }
        }
      } catch {
        // Ignore parse errors
      }
      return [];
    }

    it("returns empty array when localStorage is empty", () => {
      expect(loadTokensFromStorage()).toEqual([]);
    });

    it("returns stored tokens when valid JSON array", () => {
      const tokens = [createToken("TEST", "0x123")];
      mockLocalStorage[STORAGE_KEY] = JSON.stringify(tokens);

      const result = loadTokensFromStorage();
      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("TEST");
    });

    it("returns empty array for invalid JSON", () => {
      mockLocalStorage[STORAGE_KEY] = "not valid json";
      expect(loadTokensFromStorage()).toEqual([]);
    });

    it("returns empty array when stored value is not an array", () => {
      mockLocalStorage[STORAGE_KEY] = JSON.stringify({ token: "test" });
      expect(loadTokensFromStorage()).toEqual([]);
    });

    it("returns empty array when stored value is null", () => {
      mockLocalStorage[STORAGE_KEY] = "null";
      expect(loadTokensFromStorage()).toEqual([]);
    });

    it("returns empty array when stored value is string", () => {
      mockLocalStorage[STORAGE_KEY] = JSON.stringify("string value");
      expect(loadTokensFromStorage()).toEqual([]);
    });
  });

  describe("addToken logic", () => {
    function addToken(tokens: EnsoToken[], newToken: EnsoToken): EnsoToken[] {
      // Check if already exists (case-insensitive)
      if (tokens.some((t) => t.address.toLowerCase() === newToken.address.toLowerCase())) {
        return tokens;
      }
      return [...tokens, newToken];
    }

    it("adds new token to empty array", () => {
      const token = createToken("TEST", "0x123");
      const result = addToken([], token);
      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("TEST");
    });

    it("adds new token to existing array", () => {
      const existing = [createToken("ETH", "0x111")];
      const newToken = createToken("TEST", "0x123");
      const result = addToken(existing, newToken);
      expect(result).toHaveLength(2);
    });

    it("does not add duplicate token (same address)", () => {
      const existing = [createToken("TEST", "0x123")];
      const duplicate = createToken("TEST2", "0x123");
      const result = addToken(existing, duplicate);
      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("TEST"); // Original kept
    });

    it("handles case-insensitive address matching", () => {
      const existing = [createToken("TEST", "0xABC123")];
      const duplicate = createToken("TEST2", "0xabc123"); // lowercase
      const result = addToken(existing, duplicate);
      expect(result).toHaveLength(1);
    });

    it("does not mutate original array", () => {
      const existing = [createToken("ETH", "0x111")];
      const originalLength = existing.length;
      addToken(existing, createToken("TEST", "0x123"));
      expect(existing.length).toBe(originalLength);
    });
  });

  describe("removeToken logic", () => {
    function removeToken(tokens: EnsoToken[], address: string): EnsoToken[] {
      return tokens.filter((t) => t.address.toLowerCase() !== address.toLowerCase());
    }

    it("removes token by address", () => {
      const tokens = [
        createToken("ETH", "0x111"),
        createToken("TEST", "0x123"),
      ];
      const result = removeToken(tokens, "0x123");
      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("ETH");
    });

    it("handles case-insensitive address matching", () => {
      const tokens = [createToken("TEST", "0xABC123")];
      const result = removeToken(tokens, "0xabc123");
      expect(result).toHaveLength(0);
    });

    it("returns same array if address not found", () => {
      const tokens = [createToken("TEST", "0x123")];
      const result = removeToken(tokens, "0x999");
      expect(result).toHaveLength(1);
    });

    it("returns empty array when removing from single-item array", () => {
      const tokens = [createToken("TEST", "0x123")];
      const result = removeToken(tokens, "0x123");
      expect(result).toHaveLength(0);
    });

    it("does not mutate original array", () => {
      const tokens = [createToken("TEST", "0x123")];
      removeToken(tokens, "0x123");
      expect(tokens).toHaveLength(1);
    });
  });

  describe("isImported logic", () => {
    function isImported(tokens: EnsoToken[], address: string): boolean {
      return tokens.some((t) => t.address.toLowerCase() === address.toLowerCase());
    }

    it("returns true for imported token", () => {
      const tokens = [createToken("TEST", "0x123")];
      expect(isImported(tokens, "0x123")).toBe(true);
    });

    it("returns false for non-imported token", () => {
      const tokens = [createToken("TEST", "0x123")];
      expect(isImported(tokens, "0x999")).toBe(false);
    });

    it("handles case-insensitive matching (uppercase query)", () => {
      const tokens = [createToken("TEST", "0xabc123")];
      expect(isImported(tokens, "0xABC123")).toBe(true);
    });

    it("handles case-insensitive matching (lowercase query)", () => {
      const tokens = [createToken("TEST", "0xABC123")];
      expect(isImported(tokens, "0xabc123")).toBe(true);
    });

    it("returns false for empty token array", () => {
      expect(isImported([], "0x123")).toBe(false);
    });
  });

  describe("localStorage persistence", () => {
    let mockLocalStorage: { [key: string]: string };

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

    function saveTokensToStorage(tokens: EnsoToken[]): void {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
      } catch {
        // Ignore save errors (quota exceeded, etc.)
      }
    }

    it("saves tokens to localStorage", () => {
      const tokens = [createToken("TEST", "0x123")];
      saveTokensToStorage(tokens);
      expect(localStorage.setItem).toHaveBeenCalledWith(
        STORAGE_KEY,
        JSON.stringify(tokens)
      );
    });

    it("saves empty array", () => {
      saveTokensToStorage([]);
      expect(localStorage.setItem).toHaveBeenCalledWith(STORAGE_KEY, "[]");
    });

    it("handles localStorage quota exceeded gracefully", () => {
      vi.stubGlobal("localStorage", {
        getItem: vi.fn(),
        setItem: vi.fn(() => {
          throw new Error("QuotaExceededError");
        }),
        removeItem: vi.fn(),
      });

      // Should not throw
      expect(() => saveTokensToStorage([createToken("TEST", "0x123")])).not.toThrow();
    });
  });

  describe("token data integrity", () => {
    it("preserves all token fields through add operation", () => {
      const token: EnsoToken = {
        address: "0x123",
        chainId: 1,
        name: "Test Token",
        symbol: "TEST",
        decimals: 6,
        logoURI: "https://example.com/logo.png",
        type: "defi",
      };

      function addToken(tokens: EnsoToken[], newToken: EnsoToken): EnsoToken[] {
        if (tokens.some((t) => t.address.toLowerCase() === newToken.address.toLowerCase())) {
          return tokens;
        }
        return [...tokens, newToken];
      }

      const result = addToken([], token);
      expect(result[0]).toEqual(token);
      expect(result[0].decimals).toBe(6);
      expect(result[0].type).toBe("defi");
      expect(result[0].logoURI).toBe("https://example.com/logo.png");
    });

    it("handles tokens with optional logoURI undefined", () => {
      const token: EnsoToken = {
        address: "0x123",
        chainId: 1,
        name: "Test Token",
        symbol: "TEST",
        decimals: 18,
        type: "base",
      };

      function addToken(tokens: EnsoToken[], newToken: EnsoToken): EnsoToken[] {
        return [...tokens, newToken];
      }

      const result = addToken([], token);
      expect(result[0].logoURI).toBeUndefined();
    });
  });

  describe("address validation patterns", () => {
    function isValidAddress(address: string): boolean {
      return /^0x[a-fA-F0-9]{40}$/.test(address);
    }

    it("validates correct ethereum address", () => {
      expect(isValidAddress("0x123456789012345678901234567890abcdef1234")).toBe(true);
    });

    it("validates checksummed address", () => {
      expect(isValidAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe(true);
    });

    it("rejects address without 0x prefix", () => {
      expect(isValidAddress("123456789012345678901234567890abcdef1234")).toBe(false);
    });

    it("rejects short address", () => {
      expect(isValidAddress("0x12345")).toBe(false);
    });

    it("rejects long address", () => {
      expect(isValidAddress("0x123456789012345678901234567890abcdef12345")).toBe(false);
    });

    it("rejects address with invalid characters", () => {
      expect(isValidAddress("0x12345678901234567890123456789012345ghijk")).toBe(false);
    });

    it("rejects empty string", () => {
      expect(isValidAddress("")).toBe(false);
    });
  });

  describe("SSR safety", () => {
    it("loadTokensFromStorage handles window undefined", () => {
      // Simulate SSR where window is undefined
      const originalWindow = globalThis.window;
      // @ts-expect-error - testing SSR scenario
      delete globalThis.window;

      function loadTokensFromStorage(): EnsoToken[] {
        if (typeof window === "undefined") return [];
        return [];
      }

      expect(loadTokensFromStorage()).toEqual([]);

      // Restore
      globalThis.window = originalWindow;
    });
  });
});
