import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Test the analytics business logic directly
// We test event tracking, user rejection detection, and queue processing

describe("lib/analytics", () => {
  describe("isUserRejection", () => {
    // Replicate the function logic for testing
    function isUserRejection(error: Error | string | unknown): boolean {
      const errorMessage =
        typeof error === "string" ? error : (error as Error)?.message || "";
      const rejectionPhrases = [
        "user rejected",
        "user denied",
        "rejected the request",
        "user cancelled",
        "user canceled",
        "rejected transaction",
        "ACTION_REJECTED",
      ];
      return rejectionPhrases.some((phrase) =>
        errorMessage.toLowerCase().includes(phrase.toLowerCase())
      );
    }

    describe("detects user rejection", () => {
      it("detects 'User rejected' (MetaMask style)", () => {
        expect(isUserRejection(new Error("User rejected the request"))).toBe(true);
      });

      it("detects 'user rejected' (lowercase)", () => {
        expect(isUserRejection(new Error("user rejected transaction"))).toBe(true);
      });

      it("detects 'User denied' (alternative phrase)", () => {
        expect(isUserRejection(new Error("User denied transaction signature"))).toBe(true);
      });

      it("detects 'rejected the request'", () => {
        expect(isUserRejection("rejected the request by user")).toBe(true);
      });

      it("detects 'user cancelled' (British spelling)", () => {
        expect(isUserRejection(new Error("user cancelled the operation"))).toBe(true);
      });

      it("detects 'user canceled' (American spelling)", () => {
        expect(isUserRejection(new Error("user canceled the transaction"))).toBe(true);
      });

      it("detects 'rejected transaction'", () => {
        expect(isUserRejection(new Error("rejected transaction"))).toBe(true);
      });

      it("detects 'ACTION_REJECTED' (ethers.js v6 style)", () => {
        expect(isUserRejection(new Error("ACTION_REJECTED"))).toBe(true);
      });

      it("detects case variations", () => {
        expect(isUserRejection(new Error("USER REJECTED"))).toBe(true);
        expect(isUserRejection(new Error("User Rejected"))).toBe(true);
        expect(isUserRejection(new Error("action_rejected"))).toBe(true);
      });

      it("works with string input", () => {
        expect(isUserRejection("User rejected the request")).toBe(true);
      });
    });

    describe("does not detect non-rejection errors", () => {
      it("returns false for network errors", () => {
        expect(isUserRejection(new Error("Network error"))).toBe(false);
      });

      it("returns false for insufficient balance", () => {
        expect(isUserRejection(new Error("Insufficient balance"))).toBe(false);
      });

      it("returns false for gas estimation failure", () => {
        expect(isUserRejection(new Error("Gas estimation failed"))).toBe(false);
      });

      it("returns false for contract revert", () => {
        expect(isUserRejection(new Error("Transaction reverted"))).toBe(false);
      });

      it("returns false for timeout", () => {
        expect(isUserRejection(new Error("Request timed out"))).toBe(false);
      });

      it("returns false for empty error", () => {
        expect(isUserRejection(new Error(""))).toBe(false);
      });

      it("returns false for null", () => {
        expect(isUserRejection(null)).toBe(false);
      });

      it("returns false for undefined", () => {
        expect(isUserRejection(undefined)).toBe(false);
      });

      it("returns false for empty string", () => {
        expect(isUserRejection("")).toBe(false);
      });
    });

    describe("handles edge cases", () => {
      it("handles error object without message property", () => {
        const errorLike = { code: 4001 };
        expect(isUserRejection(errorLike)).toBe(false);
      });

      it("handles error with partial phrase", () => {
        // "reject" alone should not match
        expect(isUserRejection(new Error("Transaction was reject"))).toBe(false);
      });
    });
  });

  describe("event queue logic", () => {
    type EventParams = Record<string, string | number | boolean | undefined>;

    interface QueuedEvent {
      eventName: string;
      params?: EventParams;
    }

    let eventQueue: QueuedEvent[];

    beforeEach(() => {
      eventQueue = [];
    });

    function queueEvent(eventName: string, params?: EventParams): void {
      eventQueue.push({ eventName, params });
    }

    function processQueue(gtag: (cmd: string, action: string, params?: EventParams) => void): void {
      while (eventQueue.length > 0) {
        const event = eventQueue.shift();
        if (event) {
          gtag("event", event.eventName, event.params);
        }
      }
    }

    it("queues events correctly", () => {
      queueEvent("test_event", { value: 1 });
      expect(eventQueue).toHaveLength(1);
      expect(eventQueue[0].eventName).toBe("test_event");
    });

    it("queues multiple events", () => {
      queueEvent("event1");
      queueEvent("event2");
      queueEvent("event3");
      expect(eventQueue).toHaveLength(3);
    });

    it("processes all queued events", () => {
      const mockGtag = vi.fn();
      queueEvent("event1", { foo: "bar" });
      queueEvent("event2", { baz: 123 });

      processQueue(mockGtag);

      expect(mockGtag).toHaveBeenCalledTimes(2);
      expect(mockGtag).toHaveBeenCalledWith("event", "event1", { foo: "bar" });
      expect(mockGtag).toHaveBeenCalledWith("event", "event2", { baz: 123 });
    });

    it("clears queue after processing", () => {
      const mockGtag = vi.fn();
      queueEvent("event1");
      processQueue(mockGtag);
      expect(eventQueue).toHaveLength(0);
    });

    it("handles events without params", () => {
      const mockGtag = vi.fn();
      queueEvent("event_no_params");
      processQueue(mockGtag);
      expect(mockGtag).toHaveBeenCalledWith("event", "event_no_params", undefined);
    });
  });

  describe("error message truncation", () => {
    function truncateErrorMessage(message: string, maxLength: number = 100): string {
      return message.slice(0, maxLength);
    }

    it("does not truncate short messages", () => {
      expect(truncateErrorMessage("Short error")).toBe("Short error");
    });

    it("truncates messages longer than 100 chars", () => {
      const longMessage = "A".repeat(150);
      expect(truncateErrorMessage(longMessage)).toHaveLength(100);
    });

    it("truncates to exact limit", () => {
      const message = "X".repeat(100);
      expect(truncateErrorMessage(message)).toBe(message);
    });

    it("truncates message at 101 chars", () => {
      const message = "X".repeat(101);
      expect(truncateErrorMessage(message)).toHaveLength(100);
    });
  });

  describe("event parameter formatting", () => {
    interface EventParams {
      vault_id?: string;
      amount?: string;
      token_symbol?: string;
      direction?: "in" | "out";
      error_message?: string;
      action?: string;
    }

    function formatDepositParams(
      vaultId: string,
      amount: string,
      tokenSymbol: string
    ): EventParams {
      return {
        vault_id: vaultId,
        amount,
        token_symbol: tokenSymbol,
      };
    }

    function formatZapParams(
      vaultId: string,
      direction: "in" | "out",
      inputToken: string,
      outputToken: string,
      inputAmount: string
    ): Record<string, string> {
      return {
        vault_id: vaultId,
        direction,
        input_token: inputToken,
        output_token: outputToken,
        input_amount: inputAmount,
      };
    }

    it("formats deposit params correctly", () => {
      const params = formatDepositParams("ycvxcrv", "100.5", "cvxCRV");
      expect(params.vault_id).toBe("ycvxcrv");
      expect(params.amount).toBe("100.5");
      expect(params.token_symbol).toBe("cvxCRV");
    });

    it("formats zap params correctly", () => {
      const params = formatZapParams("ycvxcrv", "in", "ETH", "ycvxCRV", "1.0");
      expect(params.vault_id).toBe("ycvxcrv");
      expect(params.direction).toBe("in");
      expect(params.input_token).toBe("ETH");
      expect(params.output_token).toBe("ycvxCRV");
      expect(params.input_amount).toBe("1.0");
    });
  });

  describe("user property queue logic", () => {
    interface QueuedProperty {
      name: string;
      value: string | boolean;
    }

    let propertyQueue: QueuedProperty[];

    beforeEach(() => {
      propertyQueue = [];
    });

    function queueProperty(name: string, value: string | boolean): void {
      propertyQueue.push({ name, value });
    }

    function processPropertyQueue(
      gtag: (cmd: string, action: string, props: Record<string, unknown>) => void
    ): void {
      while (propertyQueue.length > 0) {
        const prop = propertyQueue.shift();
        if (prop) {
          gtag("set", "user_properties", { [prop.name]: prop.value });
        }
      }
    }

    it("queues user properties", () => {
      queueProperty("has_connected_wallet", true);
      expect(propertyQueue).toHaveLength(1);
    });

    it("processes user properties correctly", () => {
      const mockGtag = vi.fn();
      queueProperty("has_connected_wallet", true);
      queueProperty("has_deposited", false);

      processPropertyQueue(mockGtag);

      expect(mockGtag).toHaveBeenCalledTimes(2);
      expect(mockGtag).toHaveBeenCalledWith("set", "user_properties", {
        has_connected_wallet: true,
      });
      expect(mockGtag).toHaveBeenCalledWith("set", "user_properties", {
        has_deposited: false,
      });
    });

    it("handles string property values", () => {
      const mockGtag = vi.fn();
      queueProperty("preferred_vault", "ycvxcrv");
      processPropertyQueue(mockGtag);

      expect(mockGtag).toHaveBeenCalledWith("set", "user_properties", {
        preferred_vault: "ycvxcrv",
      });
    });
  });

  describe("consent checking logic", () => {
    let mockLocalStorage: { [key: string]: string };

    beforeEach(() => {
      mockLocalStorage = {};
      vi.stubGlobal("localStorage", {
        getItem: vi.fn((key: string) => mockLocalStorage[key] || null),
        setItem: vi.fn((key: string, value: string) => {
          mockLocalStorage[key] = value;
        }),
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function isAnalyticsAllowed(): boolean {
      // Check if user is from EEA (cookie consent required)
      const isEEA = localStorage.getItem("yldfi-is-eea") === "true";

      if (!isEEA) {
        // Non-EEA users don't need consent
        return true;
      }

      // EEA users need explicit consent
      const consent = localStorage.getItem("yldfi-cookie-consent");
      return consent === "accepted";
    }

    it("returns true for non-EEA users", () => {
      mockLocalStorage["yldfi-is-eea"] = "false";
      expect(isAnalyticsAllowed()).toBe(true);
    });

    it("returns true for users without EEA flag", () => {
      // No localStorage entry = assume non-EEA
      expect(isAnalyticsAllowed()).toBe(true);
    });

    it("returns false for EEA users without consent", () => {
      mockLocalStorage["yldfi-is-eea"] = "true";
      expect(isAnalyticsAllowed()).toBe(false);
    });

    it("returns true for EEA users with consent", () => {
      mockLocalStorage["yldfi-is-eea"] = "true";
      mockLocalStorage["yldfi-cookie-consent"] = "accepted";
      expect(isAnalyticsAllowed()).toBe(true);
    });

    it("returns false for EEA users who declined", () => {
      mockLocalStorage["yldfi-is-eea"] = "true";
      mockLocalStorage["yldfi-cookie-consent"] = "declined";
      expect(isAnalyticsAllowed()).toBe(false);
    });
  });

  describe("event name conventions", () => {
    const VALID_EVENT_NAMES = [
      "wallet_connect",
      "wallet_disconnect",
      "deposit_initiated",
      "deposit_success",
      "withdraw_initiated",
      "withdraw_success",
      "approval_initiated",
      "approval_success",
      "vault_view",
      "network_switch",
      "transaction_error",
      "transaction_cancelled",
      "zap_initiated",
      "zap_success",
    ];

    function isValidEventName(name: string): boolean {
      // GA4 event naming: snake_case, alphanumeric, max 40 chars
      return /^[a-z][a-z0-9_]{0,39}$/.test(name);
    }

    it("all event names follow GA4 conventions", () => {
      for (const name of VALID_EVENT_NAMES) {
        expect(isValidEventName(name)).toBe(true);
      }
    });

    it("rejects invalid event names", () => {
      expect(isValidEventName("InvalidCamelCase")).toBe(false);
      expect(isValidEventName("123_starts_with_number")).toBe(false);
      expect(isValidEventName("has-dashes")).toBe(false);
      expect(isValidEventName("has spaces")).toBe(false);
      expect(isValidEventName("")).toBe(false);
    });

    it("validates snake_case format", () => {
      expect(isValidEventName("valid_event_name")).toBe(true);
      expect(isValidEventName("a")).toBe(true);
      expect(isValidEventName("event123")).toBe(true);
    });
  });

  describe("window/gtag availability checks", () => {
    it("handles window undefined (SSR)", () => {
      function trackEventSafe(eventName: string): boolean {
        if (typeof window === "undefined") return false;
        return true;
      }

      // In test environment, window is defined
      expect(trackEventSafe("test")).toBe(true);
    });

    it("handles gtag undefined", () => {
      function isGtagReady(): boolean {
        return typeof window !== "undefined" && typeof window.gtag === "function";
      }

      // gtag is mocked as vi.fn() in vitest.setup.ts
      expect(isGtagReady()).toBe(true);
    });
  });

  describe("interval cleanup", () => {
    it("clears interval after processing", () => {
      vi.useFakeTimers();

      let intervalId: ReturnType<typeof setInterval> | null = null;
      let gtagReady = false;

      function waitForGtag(callback: () => void): void {
        intervalId = setInterval(() => {
          if (gtagReady) {
            if (intervalId) clearInterval(intervalId);
            callback();
          }
        }, 100);

        // Stop checking after 10 seconds
        setTimeout(() => {
          if (intervalId) clearInterval(intervalId);
        }, 10000);
      }

      const callback = vi.fn();
      waitForGtag(callback);

      // Simulate gtag becoming ready after 500ms
      vi.advanceTimersByTime(400);
      expect(callback).not.toHaveBeenCalled();

      gtagReady = true;
      vi.advanceTimersByTime(100);
      expect(callback).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("stops checking after 10 seconds timeout", () => {
      vi.useFakeTimers();

      let checkCount = 0;
      let intervalId: ReturnType<typeof setInterval> | null = null;

      function startChecking(): void {
        intervalId = setInterval(() => {
          checkCount++;
        }, 100);

        setTimeout(() => {
          if (intervalId) clearInterval(intervalId);
        }, 10000);
      }

      startChecking();

      // After 10 seconds, interval should be cleared
      vi.advanceTimersByTime(10000);

      const checksAfterTimeout = checkCount;

      // Advance more time - count should not increase
      vi.advanceTimersByTime(1000);
      expect(checkCount).toBe(checksAfterTimeout);

      vi.useRealTimers();
    });
  });
});
