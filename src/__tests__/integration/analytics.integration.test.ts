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
  trackTransactionError,
  trackTransactionCancelled,
  trackZapInitiated,
  trackZapSuccess,
  trackLendingBorrowInitiated,
  trackLendingBorrowSuccess,
  trackLendingRepayInitiated,
  trackLendingRepaySuccess,
  trackLendingCollateralAddInitiated,
  trackLendingCollateralAddSuccess,
  trackLendingLeverageInitiated,
  trackLendingLeverageSuccess,
  trackLendingSelfLiquidateInitiated,
  trackLendingSelfLiquidateSuccess,
  trackRewardsPageView,
  trackRewardsClaimClick,
  trackRewardsEligibilityCheck,
  trackCtaClick,
  trackExternalLinkClick,
  trackLendingTabSwitch,
  categorizeError,
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
        amount_bucket: "1K-10K",
        token_symbol: "cvxCRV",
      });
    });

    it("tracks deposit success and sets user property", () => {
      trackDepositSuccess(VAULT_ID, "1000", "cvxCRV");

      expect(mockGtag).toHaveBeenCalledWith("event", "deposit_success", {
        vault_id: VAULT_ID,
        amount_bucket: "1K-10K",
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
        amount_bucket: "100-1K",
        token_symbol: "ycvxCRV",
      });
    });

    it("tracks withdraw success", () => {
      trackWithdrawSuccess(VAULT_ID, "500", "ycvxCRV");

      expect(mockGtag).toHaveBeenCalledWith("event", "withdraw_success", {
        vault_id: VAULT_ID,
        amount_bucket: "100-1K",
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

  describe("error events", () => {
    it("tracks transaction error with categorized error_type", () => {
      trackTransactionError("deposit", "0x123", "execution reverted", "revert");

      expect(mockGtag).toHaveBeenCalledWith("event", "transaction_error", {
        action: "deposit",
        vault_id: "0x123",
        error_type: "revert",
      });
    });

    it("auto-categorizes error when type not provided", () => {
      trackTransactionError("deposit", "0x123", "Something went wrong");

      expect(mockGtag).toHaveBeenCalledWith("event", "transaction_error", {
        action: "deposit",
        vault_id: "0x123",
        error_type: "unknown",
      });
    });

    it("does not send error_message to GA", () => {
      trackTransactionError("deposit", "0x123", "execution reverted: sensitive RPC URL here");

      const call = mockGtag.mock.calls.find(
        (c: unknown[]) => c[1] === "transaction_error"
      );
      expect(call?.[2]).not.toHaveProperty("error_message");
    });

    it("tracks transaction cancelled", () => {
      trackTransactionCancelled("withdraw", "0x123");

      expect(mockGtag).toHaveBeenCalledWith("event", "transaction_cancelled", {
        action: "withdraw",
        vault_id: "0x123",
      });
    });

    it("accepts lending action types", () => {
      trackTransactionError("borrow", "0x123", new Error("execution reverted"), "revert");
      expect(mockGtag).toHaveBeenCalledWith("event", "transaction_error", {
        action: "borrow",
        vault_id: "0x123",
        error_type: "revert",
      });

      trackTransactionCancelled("self_liquidate", "0x456");
      expect(mockGtag).toHaveBeenCalledWith("event", "transaction_cancelled", {
        action: "self_liquidate",
        vault_id: "0x456",
      });
    });
  });

  describe("categorizeError", () => {
    it("categorizes user rejection errors", () => {
      expect(categorizeError("user rejected transaction")).toBe("user_rejected");
      expect(categorizeError(new Error("ACTION_REJECTED"))).toBe("user_rejected");
    });

    it("categorizes revert errors", () => {
      expect(categorizeError("execution reverted")).toBe("revert");
      expect(categorizeError(new Error("call revert exception"))).toBe("revert");
    });

    it("categorizes timeout errors", () => {
      expect(categorizeError("request timed out")).toBe("timeout");
      expect(categorizeError(new Error("timeout"))).toBe("timeout");
    });

    it("categorizes network errors", () => {
      expect(categorizeError("network error")).toBe("network");
      expect(categorizeError(new Error("failed to fetch"))).toBe("network");
    });

    it("defaults to unknown for unrecognized errors", () => {
      expect(categorizeError("something happened")).toBe("unknown");
      expect(categorizeError(42)).toBe("unknown");
    });
  });

  describe("lending events", () => {
    const VAULT_ID = "ycvxcrv";

    it("tracks borrow initiated", () => {
      trackLendingBorrowInitiated(VAULT_ID, "1000", "crvUSD");
      expect(mockGtag).toHaveBeenCalledWith("event", "lending_borrow_initiated", {
        vault_id: VAULT_ID,
        amount_bucket: "1K-10K",
        token_symbol: "crvUSD",
      });
    });

    it("tracks borrow success and sets user property", () => {
      trackLendingBorrowSuccess(VAULT_ID, "1000", "crvUSD");
      expect(mockGtag).toHaveBeenCalledWith("event", "lending_borrow_success", {
        vault_id: VAULT_ID,
        amount_bucket: "1K-10K",
        token_symbol: "crvUSD",
      });
      expect(mockGtag).toHaveBeenCalledWith("set", "user_properties", {
        has_borrowed: true,
      });
    });

    it("tracks repay initiated and success", () => {
      trackLendingRepayInitiated(VAULT_ID, "500");
      expect(mockGtag).toHaveBeenCalledWith("event", "lending_repay_initiated", {
        vault_id: VAULT_ID,
        amount_bucket: "100-1K",
      });

      trackLendingRepaySuccess(VAULT_ID, "500");
      expect(mockGtag).toHaveBeenCalledWith("event", "lending_repay_success", {
        vault_id: VAULT_ID,
        amount_bucket: "100-1K",
      });
    });

    it("tracks collateral add initiated and success", () => {
      trackLendingCollateralAddInitiated(VAULT_ID, "100", "ycvxCRV");
      expect(mockGtag).toHaveBeenCalledWith("event", "lending_collateral_add_initiated", {
        vault_id: VAULT_ID,
        amount_bucket: "100-1K",
        token_symbol: "ycvxCRV",
      });

      trackLendingCollateralAddSuccess(VAULT_ID, "100", "ycvxCRV");
      expect(mockGtag).toHaveBeenCalledWith("event", "lending_collateral_add_success", {
        vault_id: VAULT_ID,
        amount_bucket: "100-1K",
        token_symbol: "ycvxCRV",
      });
    });

    it("tracks leverage initiated and success", () => {
      trackLendingLeverageInitiated(VAULT_ID, "1000", "2.50");
      expect(mockGtag).toHaveBeenCalledWith("event", "lending_leverage_initiated", {
        vault_id: VAULT_ID,
        amount_bucket: "1K-10K",
        leverage_multiplier: "2.50",
      });

      trackLendingLeverageSuccess(VAULT_ID, "1000", "2.50");
      expect(mockGtag).toHaveBeenCalledWith("event", "lending_leverage_success", {
        vault_id: VAULT_ID,
        amount_bucket: "1K-10K",
        leverage_multiplier: "2.50",
      });
      expect(mockGtag).toHaveBeenCalledWith("set", "user_properties", {
        has_used_leverage: true,
      });
    });

    it("tracks self-liquidate initiated and success", () => {
      trackLendingSelfLiquidateInitiated(VAULT_ID);
      expect(mockGtag).toHaveBeenCalledWith("event", "lending_self_liquidate_initiated", {
        vault_id: VAULT_ID,
      });

      trackLendingSelfLiquidateSuccess(VAULT_ID);
      expect(mockGtag).toHaveBeenCalledWith("event", "lending_self_liquidate_success", {
        vault_id: VAULT_ID,
      });
    });
  });

  describe("rewards events", () => {
    it("tracks rewards page view", () => {
      trackRewardsPageView();
      expect(mockGtag).toHaveBeenCalledWith("event", "rewards_page_view", undefined);
    });

    it("tracks rewards claim click", () => {
      trackRewardsClaimClick();
      expect(mockGtag).toHaveBeenCalledWith("event", "rewards_claim_click", undefined);
    });

    it("tracks rewards eligibility check", () => {
      trackRewardsEligibilityCheck(true, false);
      expect(mockGtag).toHaveBeenCalledWith("event", "rewards_eligibility_check", {
        has_ycvxcrv: true,
        has_borrow_position: false,
      });
    });
  });

  describe("cta and navigation events", () => {
    it("tracks cta click", () => {
      trackCtaClick("view_vaults", "home");
      expect(mockGtag).toHaveBeenCalledWith("event", "cta_click", {
        cta_name: "view_vaults",
        page: "home",
      });
    });

    it("tracks external link click", () => {
      trackExternalLinkClick("https://yldfi.gitbook.io/docs", "docs");
      expect(mockGtag).toHaveBeenCalledWith("event", "external_link_click", {
        url: "https://yldfi.gitbook.io/docs",
        link_name: "docs",
      });
    });

    it("tracks lending tab switch", () => {
      trackLendingTabSwitch("borrow");
      expect(mockGtag).toHaveBeenCalledWith("event", "lending_tab_switch", {
        tab_name: "borrow",
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
        amount_bucket: "<100",
      });
    });

    it("tracks zap success and sets user property", () => {
      trackZapSuccess("0x123", "out", "ycvxCRV", "USDC", "100", "95");

      expect(mockGtag).toHaveBeenCalledWith("event", "zap_success", {
        vault_id: "0x123",
        direction: "out",
        input_token: "ycvxCRV",
        output_token: "USDC",
        amount_bucket: "100-1K",
        amount_bucket_out: "<100",
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
