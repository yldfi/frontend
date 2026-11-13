// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  logRpcAttempt,
  markRpcTimedOut,
  orderRpcUrls,
  resetRpcHealth,
  RPC_COOLDOWN_MS,
  RPC_SLOW_LOG_MS,
} from "@/lib/rpc-health";

const PRIVATE = "https://private.node.example/rpc/secret-key";
const PUBLIC_A = "https://ethereum-rpc.publicnode.com";
const PUBLIC_B = "https://1rpc.io/eth";

describe("RPC provider health", () => {
  beforeEach(() => {
    resetRpcHealth();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetRpcHealth();
  });

  describe("orderRpcUrls", () => {
    it("returns an unmarked list unchanged", () => {
      expect(orderRpcUrls([PRIVATE, PUBLIC_A, PUBLIC_B])).toEqual([PRIVATE, PUBLIC_A, PUBLIC_B]);
    });

    it("moves a marked URL to the end and keeps the rest in order", () => {
      markRpcTimedOut(PRIVATE);

      expect(orderRpcUrls([PRIVATE, PUBLIC_A, PUBLIC_B])).toEqual([PUBLIC_A, PUBLIC_B, PRIVATE]);
    });

    it("keeps two marked URLs in their relative order at the end", () => {
      markRpcTimedOut(PRIVATE);
      markRpcTimedOut(PUBLIC_A);

      expect(orderRpcUrls([PRIVATE, PUBLIC_A, PUBLIC_B])).toEqual([PUBLIC_B, PRIVATE, PUBLIC_A]);
    });

    it("restores the original order after the cooldown", () => {
      markRpcTimedOut(PRIVATE);
      expect(orderRpcUrls([PRIVATE, PUBLIC_A])).toEqual([PUBLIC_A, PRIVATE]);

      vi.advanceTimersByTime(RPC_COOLDOWN_MS);

      expect(orderRpcUrls([PRIVATE, PUBLIC_A])).toEqual([PRIVATE, PUBLIC_A]);
    });

    it("never changes the set of URLs", () => {
      markRpcTimedOut(PRIVATE);
      markRpcTimedOut(PUBLIC_B);

      expect(orderRpcUrls([PRIVATE, PUBLIC_A, PUBLIC_B]).sort()).toEqual([PRIVATE, PUBLIC_A, PUBLIC_B].sort());
    });

    it("drops a cooldown for a URL that is no longer offered", () => {
      markRpcTimedOut(PRIVATE);
      expect(orderRpcUrls([PUBLIC_A])).toEqual([PUBLIC_A]);

      // Had the entry survived, the URL would still be moved to the end.
      expect(orderRpcUrls([PRIVATE, PUBLIC_A])).toEqual([PRIVATE, PUBLIC_A]);
    });
  });

  describe("resetRpcHealth", () => {
    it("clears every cooldown", () => {
      markRpcTimedOut(PRIVATE);
      resetRpcHealth();

      expect(orderRpcUrls([PRIVATE, PUBLIC_A])).toEqual([PRIVATE, PUBLIC_A]);
    });
  });

  describe("logRpcAttempt", () => {
    const logSpy = () => vi.mocked(console.log);

    it("prints nothing for a fast successful attempt", () => {
      vi.spyOn(console, "log").mockImplementation(() => {});

      logRpcAttempt(PRIVATE, Date.now() - 10, "ok", "test");

      expect(logSpy()).not.toHaveBeenCalled();
    });

    it("prints a slow successful attempt", () => {
      vi.spyOn(console, "log").mockImplementation(() => {});

      logRpcAttempt(PRIVATE, Date.now() - RPC_SLOW_LOG_MS, "ok", "test");

      expect(logSpy()).toHaveBeenCalledTimes(1);
    });

    it.each(["timeout", "http_error", "rpc_error", "error"] as const)(
      "prints every failed outcome (%s)",
      (outcome) => {
        vi.spyOn(console, "log").mockImplementation(() => {});

        logRpcAttempt(PRIVATE, Date.now(), outcome, "test");

        expect(logSpy()).toHaveBeenCalledTimes(1);
      },
    );

    it("logs the host but never the path or key", () => {
      vi.spyOn(console, "log").mockImplementation(() => {});

      logRpcAttempt(PRIVATE, Date.now() - RPC_SLOW_LOG_MS, "ok", "test");

      const printed = logSpy().mock.calls[0].map((part) => String(part)).join(" ");
      expect(printed).toContain("private.node.example");
      expect(printed).not.toContain("secret-key");
      expect(printed).not.toContain("/rpc/");
    });
  });
});
