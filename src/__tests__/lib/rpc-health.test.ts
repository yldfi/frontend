// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  logRpcAttempt,
  markRpcHealthy,
  markRpcTimedOut,
  orderRpcUrls,
  resetRpcHealth,
  RPC_COOLDOWN_MAX_MS,
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

  describe("growing cooldown", () => {
    const urls = [PRIVATE, PUBLIC_A];
    const at = (now: number) => orderRpcUrls(urls, now);
    const COOLDOWN = RPC_COOLDOWN_MS;

    it("cools a first timeout for 60 seconds", () => {
      const t0 = Date.now();
      markRpcTimedOut(PRIVATE, t0);

      expect(at(t0 + COOLDOWN - 1)).toEqual([PUBLIC_A, PRIVATE]);
      expect(at(t0 + COOLDOWN)).toEqual(urls);
    });

    it("doubles the cooldown for a timeout right after the previous one ended", () => {
      const t0 = Date.now();
      markRpcTimedOut(PRIVATE, t0); // 60 s
      markRpcTimedOut(PRIVATE, t0 + COOLDOWN); // 120 s, ends t0 + 180 s

      expect(at(t0 + 3 * COOLDOWN - 1)).toEqual([PUBLIC_A, PRIVATE]);
      expect(at(t0 + 3 * COOLDOWN)).toEqual(urls);
    });

    it("doubles again for a third consecutive timeout", () => {
      const t0 = Date.now();
      markRpcTimedOut(PRIVATE, t0); // 60 s, ends t0 + 60 s
      markRpcTimedOut(PRIVATE, t0 + COOLDOWN); // 120 s, ends t0 + 180 s
      markRpcTimedOut(PRIVATE, t0 + 3 * COOLDOWN); // 240 s, ends t0 + 420 s

      expect(at(t0 + 420_000 - 1)).toEqual([PUBLIC_A, PRIVATE]);
      expect(at(t0 + 420_000)).toEqual(urls);
    });

    it("caps the cooldown at 600 seconds", () => {
      const t0 = Date.now();
      markRpcTimedOut(PRIVATE, t0);
      markRpcTimedOut(PRIVATE, t0 + 60_000); // 120 s
      markRpcTimedOut(PRIVATE, t0 + 180_000); // 240 s
      markRpcTimedOut(PRIVATE, t0 + 420_000); // 480 s
      // A fifth consecutive timeout would be 960 s, capped at 600 s.
      markRpcTimedOut(PRIVATE, t0 + 900_000);

      expect(at(t0 + 900_000 + RPC_COOLDOWN_MAX_MS - 1)).toEqual([PUBLIC_A, PRIVATE]);
      expect(at(t0 + 900_000 + RPC_COOLDOWN_MAX_MS)).toEqual(urls);
    });

    it("starts over after a timeout long past the previous cooldown", () => {
      const t0 = Date.now();
      markRpcTimedOut(PRIVATE, t0);

      const later = t0 + COOLDOWN + RPC_COOLDOWN_MAX_MS + 1;
      markRpcTimedOut(PRIVATE, later);

      expect(at(later + COOLDOWN - 1)).toEqual([PUBLIC_A, PRIVATE]);
      expect(at(later + COOLDOWN)).toEqual(urls);
    });

    it("markRpcHealthy removes the cooldown at once", () => {
      const t0 = Date.now();
      markRpcTimedOut(PRIVATE, t0);
      markRpcTimedOut(PRIVATE, t0 + COOLDOWN);

      markRpcHealthy(PRIVATE);

      expect(at(t0 + COOLDOWN)).toEqual(urls);
    });

    it("markRpcHealthy resets the strikes, so the next timeout is 60 seconds again", () => {
      const t0 = Date.now();
      markRpcTimedOut(PRIVATE, t0);
      markRpcTimedOut(PRIVATE, t0 + COOLDOWN);
      markRpcHealthy(PRIVATE);

      markRpcTimedOut(PRIVATE, t0 + COOLDOWN);

      expect(at(t0 + 2 * COOLDOWN - 1)).toEqual([PUBLIC_A, PRIVATE]);
      expect(at(t0 + 2 * COOLDOWN)).toEqual(urls);
    });

    it("keeps an expired record for the strike count but stops reordering", () => {
      const t0 = Date.now();
      markRpcTimedOut(PRIVATE, t0);

      expect(at(t0 + COOLDOWN)).toEqual(urls);

      // The record is still there: a timeout now counts as a second strike.
      markRpcTimedOut(PRIVATE, t0 + COOLDOWN);
      expect(at(t0 + 3 * COOLDOWN - 1)).toEqual([PUBLIC_A, PRIVATE]);
      expect(at(t0 + 3 * COOLDOWN)).toEqual(urls);
    });
  });

  describe("one strike per outage", () => {
    const urls = [PRIVATE, PUBLIC_A];
    const at = (now: number) => orderRpcUrls(urls, now);
    const COOLDOWN = RPC_COOLDOWN_MS;

    it("counts five timeouts at the same instant as one 60 second cooldown", () => {
      const t0 = Date.now();
      for (let i = 0; i < 5; i += 1) markRpcTimedOut(PRIVATE, t0);

      expect(at(t0 + COOLDOWN - 1)).toEqual([PUBLIC_A, PRIVATE]);
      expect(at(t0 + COOLDOWN)).toEqual(urls);
      expect(at(t0 + COOLDOWN + 1)).toEqual(urls);
    });

    it("does not extend a cooldown for a timeout inside it", () => {
      const t0 = Date.now();
      markRpcTimedOut(PRIVATE, t0);
      markRpcTimedOut(PRIVATE, t0 + 30_000);

      expect(at(t0 + COOLDOWN - 1)).toEqual([PUBLIC_A, PRIVATE]);
      expect(at(t0 + COOLDOWN)).toEqual(urls);
    });

    it("doubles the cooldown for timeouts just past each previous one", () => {
      const t0 = Date.now();
      markRpcTimedOut(PRIVATE, t0); // 60 s, ends t0 + 60 s

      const t1 = t0 + COOLDOWN + 1;
      markRpcTimedOut(PRIVATE, t1); // 120 s, ends t1 + 120 s
      expect(at(t1 + 2 * COOLDOWN - 1)).toEqual([PUBLIC_A, PRIVATE]);
      expect(at(t1 + 2 * COOLDOWN)).toEqual(urls);

      const t2 = t1 + 2 * COOLDOWN + 1;
      markRpcTimedOut(PRIVATE, t2); // 240 s, ends t2 + 240 s
      expect(at(t2 + 4 * COOLDOWN - 1)).toEqual([PUBLIC_A, PRIVATE]);
      expect(at(t2 + 4 * COOLDOWN)).toEqual(urls);
    });

    it("counts a timeout just inside the strike window as a second strike", () => {
      const t0 = Date.now();
      markRpcTimedOut(PRIVATE, t0); // 60 s, ends t0 + 60 s

      const second = t0 + COOLDOWN + RPC_COOLDOWN_MAX_MS - 1;
      markRpcTimedOut(PRIVATE, second); // 120 s

      expect(at(second + 2 * COOLDOWN - 1)).toEqual([PUBLIC_A, PRIVATE]);
      expect(at(second + 2 * COOLDOWN)).toEqual(urls);
    });

    it("starts over at exactly the strike window", () => {
      const t0 = Date.now();
      markRpcTimedOut(PRIVATE, t0); // 60 s, ends t0 + 60 s

      const second = t0 + COOLDOWN + RPC_COOLDOWN_MAX_MS;
      markRpcTimedOut(PRIVATE, second); // 60 s again

      expect(at(second + COOLDOWN - 1)).toEqual([PUBLIC_A, PRIVATE]);
      expect(at(second + COOLDOWN)).toEqual(urls);
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
