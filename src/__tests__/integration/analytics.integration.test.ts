import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  trackEvent,
  setUserProperty,
  trackWalletConnect,
  trackWalletDisconnect,
  trackDepositInitiated,
  trackDepositSuccess,
  trackWithdrawInitiated,
  trackWithdrawSuccess,
  trackApprovalInitiated,
  trackApprovalSuccess,
  trackVaultView,
  trackNetworkSwitch,
  trackTransactionError,
  trackTransactionCancelled,
  trackZapInitiated,
  trackZapSuccess,
  isUserRejection,
} from "@/lib/analytics";
import { isAnalyticsAllowed } from "@/components/CookieConsent";

// Get mocked functions
const mockIsAnalyticsAllowed = vi.mocked(isAnalyticsAllowed);

describe("analytics.ts integration", () => {
  let mockGtag: ReturnType<typeof vi.fn>;
  let originalGtag: unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGtag = vi.fn();
    originalGtag = (globalThis as Record<string, unknown>).gtag;
    (globalThis as Record<string, unknown>).gtag = mockGtag;
    mockIsAnalyticsAllowed.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
    if (originalGtag === undefined) {
      (globalThis as Record<string, unknown>).gtag = undefined;
    } else {
      (globalThis as Record<string, unknown>).gtag = originalGtag;
    }
  });

  describe("trackEvent", () => {
    it("sends event to gtag when analytics allowed", () => {
      trackEvent("test_event", { foo: "bar" });

      expect(mockGtag).toHaveBeenCalledWith("event", "test_event", { foo: "bar" });
    });

    it("does not send event when analytics not allowed", () => {
      mockIsAnalyticsAllowed.mockReturnValue(false);

      trackEvent("test_event", { foo: "bar" });

      expect(mockGtag).not.toHaveBeenCalled();
    });

    it("sends event without params", () => {
      trackEvent("simple_event");

      expect(mockGtag).toHaveBeenCalledWith("event", "simple_event", undefined);
    });

    it("queues events when gtag not available", () => {
      (globalThis as Record<string, unknown>).gtag = undefined;

      // This should queue the event
      trackEvent("queued_event", { test: true });

      // Event not sent yet since gtag not available
      expect(mockGtag).not.toHaveBeenCalled();

      // Add gtag back
      (globalThis as Record<string, unknown>).gtag = mockGtag;

      // Advance timer to let interval check run
      vi.advanceTimersByTime(150);

      // Event should be processed from queue
      expect(mockGtag).toHaveBeenCalledWith("event", "queued_event", { test: true });
    });

    it("processes multiple queued events when gtag loads", () => {
      (globalThis as Record<string, unknown>).gtag = undefined;

      // Queue multiple events
      trackEvent("event1", { a: 1 });
      trackEvent("event2", { b: 2 });
      trackEvent("event3", { c: 3 });

      expect(mockGtag).not.toHaveBeenCalled();

      // Add gtag back
      (globalThis as Record<string, unknown>).gtag = mockGtag;

      // Advance timer
      vi.advanceTimersByTime(150);

      // All events should be processed
      expect(mockGtag).toHaveBeenCalledWith("event", "event1", { a: 1 });
      expect(mockGtag).toHaveBeenCalledWith("event", "event2", { b: 2 });
      expect(mockGtag).toHaveBeenCalledWith("event", "event3", { c: 3 });
    });
  });

  describe("setUserProperty", () => {
    it("sets user property via gtag", () => {
      setUserProperty("has_wallet", true);

      expect(mockGtag).toHaveBeenCalledWith("set", "user_properties", {
        has_wallet: true,
      });
    });

    it("does not set property when analytics not allowed", () => {
      mockIsAnalyticsAllowed.mockReturnValue(false);

      setUserProperty("has_wallet", true);

      expect(mockGtag).not.toHaveBeenCalled();
    });
  });

  describe("wallet events", () => {
    it("tracks wallet connect", () => {
      trackWalletConnect("MetaMask");

      expect(mockGtag).toHaveBeenCalledWith("event", "wallet_connect", {
        wallet_type: "MetaMask",
      });
      expect(mockGtag).toHaveBeenCalledWith("set", "user_properties", {
        has_connected_wallet: true,
      });
    });

    it("tracks wallet disconnect", () => {
      trackWalletDisconnect();

      expect(mockGtag).toHaveBeenCalledWith("event", "wallet_disconnect", undefined);
    });
  });

  describe("transaction events", () => {
    const VAULT_ID = "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86";

    it("tracks deposit initiated", () => {
      trackDepositInitiated(VAULT_ID, "1000", "cvxCRV");

      expect(mockGtag).toHaveBeenCalledWith("event", "deposit_initiated", {
        vault_id: VAULT_ID,
        amount: "1000",
        token_symbol: "cvxCRV",
      });
    });

    it("tracks deposit success and sets user property", () => {
      trackDepositSuccess(VAULT_ID, "1000", "cvxCRV");

      expect(mockGtag).toHaveBeenCalledWith("event", "deposit_success", {
        vault_id: VAULT_ID,
        amount: "1000",
        token_symbol: "cvxCRV",
      });
      expect(mockGtag).toHaveBeenCalledWith("set", "user_properties", {
        has_deposited: true,
      });
    });

    it("tracks withdraw initiated", () => {
      trackWithdrawInitiated(VAULT_ID, "500", "ycvxCRV");

      expect(mockGtag).toHaveBeenCalledWith("event", "withdraw_initiated", {
        vault_id: VAULT_ID,
        shares: "500",
        token_symbol: "ycvxCRV",
      });
    });

    it("tracks withdraw success", () => {
      trackWithdrawSuccess(VAULT_ID, "500", "ycvxCRV");

      expect(mockGtag).toHaveBeenCalledWith("event", "withdraw_success", {
        vault_id: VAULT_ID,
        shares: "500",
        token_symbol: "ycvxCRV",
      });
    });

    it("tracks approval initiated", () => {
      trackApprovalInitiated("cvxCRV", VAULT_ID);

      expect(mockGtag).toHaveBeenCalledWith("event", "approval_initiated", {
        token_symbol: "cvxCRV",
        vault_id: VAULT_ID,
      });
    });

    it("tracks approval success", () => {
      trackApprovalSuccess("cvxCRV", VAULT_ID);

      expect(mockGtag).toHaveBeenCalledWith("event", "approval_success", {
        token_symbol: "cvxCRV",
        vault_id: VAULT_ID,
      });
    });
  });

  describe("view events", () => {
    it("tracks vault view", () => {
      trackVaultView("0x123", "ycvxCRV");

      expect(mockGtag).toHaveBeenCalledWith("event", "vault_view", {
        vault_id: "0x123",
        vault_name: "ycvxCRV",
      });
    });
  });

  describe("network events", () => {
    it("tracks network switch", () => {
      trackNetworkSwitch("ethereum", "arbitrum");

      expect(mockGtag).toHaveBeenCalledWith("event", "network_switch", {
        from_chain: "ethereum",
        to_chain: "arbitrum",
      });
    });

    it("handles undefined from chain", () => {
      trackNetworkSwitch(undefined, "ethereum");

      expect(mockGtag).toHaveBeenCalledWith("event", "network_switch", {
        from_chain: "unknown",
        to_chain: "ethereum",
      });
    });
  });

  describe("error events", () => {
    it("tracks transaction error", () => {
      trackTransactionError("deposit", "0x123", "Insufficient balance");

      expect(mockGtag).toHaveBeenCalledWith("event", "transaction_error", {
        action: "deposit",
        vault_id: "0x123",
        error_message: "Insufficient balance",
      });
    });

    it("truncates long error messages", () => {
      const longError = "x".repeat(200);
      trackTransactionError("deposit", "0x123", longError);

      const call = mockGtag.mock.calls.find(
        (c) => c[1] === "transaction_error"
      );
      expect(call?.[2].error_message.length).toBe(100);
    });

    it("tracks transaction cancelled", () => {
      trackTransactionCancelled("withdraw", "0x123");

      expect(mockGtag).toHaveBeenCalledWith("event", "transaction_cancelled", {
        action: "withdraw",
        vault_id: "0x123",
      });
    });
  });

  describe("zap events", () => {
    it("tracks zap initiated", () => {
      trackZapInitiated("0x123", "in", "ETH", "cvxCRV", "1.0");

      expect(mockGtag).toHaveBeenCalledWith("event", "zap_initiated", {
        vault_id: "0x123",
        direction: "in",
        input_token: "ETH",
        output_token: "cvxCRV",
        input_amount: "1.0",
      });
    });

    it("tracks zap success and sets user property", () => {
      trackZapSuccess("0x123", "out", "ycvxCRV", "USDC", "100", "95");

      expect(mockGtag).toHaveBeenCalledWith("event", "zap_success", {
        vault_id: "0x123",
        direction: "out",
        input_token: "ycvxCRV",
        output_token: "USDC",
        input_amount: "100",
        output_amount: "95",
      });
      expect(mockGtag).toHaveBeenCalledWith("set", "user_properties", {
        has_used_zap: true,
      });
    });
  });

  describe("isUserRejection", () => {
    it("detects user rejection errors", () => {
      expect(isUserRejection("user rejected transaction")).toBe(true);
      expect(isUserRejection("User denied transaction")).toBe(true);
      expect(isUserRejection("rejected the request")).toBe(true);
      expect(isUserRejection("user cancelled")).toBe(true);
      expect(isUserRejection("user canceled")).toBe(true);
      expect(isUserRejection("ACTION_REJECTED")).toBe(true);
    });

    it("detects Error objects with rejection messages", () => {
      expect(isUserRejection(new Error("user rejected"))).toBe(true);
      expect(isUserRejection(new Error("User denied the request"))).toBe(true);
    });

    it("returns false for non-rejection errors", () => {
      expect(isUserRejection("Insufficient balance")).toBe(false);
      expect(isUserRejection("Network error")).toBe(false);
      expect(isUserRejection(new Error("Transaction failed"))).toBe(false);
    });

    it("handles unknown error types", () => {
      expect(isUserRejection(null)).toBe(false);
      expect(isUserRejection(undefined)).toBe(false);
      expect(isUserRejection({})).toBe(false);
    });

    it("handles object with no message property", () => {
      expect(isUserRejection({ code: 4001 })).toBe(false);
      expect(isUserRejection({ name: "Error" })).toBe(false);
    });

    it("handles numbers and booleans", () => {
      expect(isUserRejection(42)).toBe(false);
      expect(isUserRejection(true)).toBe(false);
      expect(isUserRejection(false)).toBe(false);
    });

    it("handles nested error with rejection in shortMessage", () => {
      // Some wallets put rejection info in shortMessage
      const error = { shortMessage: "User rejected the request" };
      expect(isUserRejection(error)).toBe(false); // Only checks message prop
    });
  });

  describe("edge cases", () => {
    it("handles special characters in event params", () => {
      trackEvent("test_event", {
        message: "Hello <script>alert('xss')</script>",
        address: "0x123'--; DROP TABLE users;",
      });

      expect(mockGtag).toHaveBeenCalledWith("event", "test_event", {
        message: "Hello <script>alert('xss')</script>",
        address: "0x123'--; DROP TABLE users;",
      });
    });

    it("handles very long vault addresses", () => {
      const longAddress = "0x" + "a".repeat(100);
      trackVaultView(longAddress, "TestVault");

      expect(mockGtag).toHaveBeenCalledWith("event", "vault_view", {
        vault_id: longAddress,
        vault_name: "TestVault",
      });
    });

    it("handles empty string params", () => {
      trackEvent("test_event", { empty: "" });

      expect(mockGtag).toHaveBeenCalledWith("event", "test_event", { empty: "" });
    });

    it("handles numeric values in params", () => {
      trackEvent("test_event", { count: 42, amount: 1.5 });

      expect(mockGtag).toHaveBeenCalledWith("event", "test_event", {
        count: 42,
        amount: 1.5
      });
    });
  });
});
