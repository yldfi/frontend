import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isAnalyticsAllowed } from "@/components/CookieConsent";
import {
  categorizeError,
  isUserRejection,
  setUserProperty,
  trackApprovalInitiated,
  trackApprovalSuccess,
  trackCtaClick,
  trackDepositInitiated,
  trackDepositSuccess,
  trackEvent,
  trackExternalLinkClick,
  trackRewardsClaimClick,
  trackTransactionCancelled,
  trackTransactionError,
  trackVaultView,
  trackWalletConnect,
  trackWalletDisconnect,
  trackWithdrawInitiated,
  trackWithdrawSuccess,
  trackZapInitiated,
  trackZapSuccess,
} from "@/lib/analytics";

const gtag = () => vi.mocked(window.gtag!);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAnalyticsAllowed).mockReturnValue(true);
});

describe("isUserRejection", () => {
  it.each([
    "User rejected the request",
    "user rejected transaction",
    "User denied transaction signature",
    "rejected the request by user",
    "user cancelled the operation",
    "user canceled the transaction",
    "rejected transaction",
    "transaction cancelled",
    "ACTION_REJECTED",
    "USER REJECTED",
    "action_rejected",
  ])("detects %s", (message) => {
    expect(isUserRejection(new Error(message))).toBe(true);
    expect(isUserRejection(message)).toBe(true);
  });

  it.each([
    "Network error",
    "Insufficient balance",
    "Gas estimation failed",
    "Transaction reverted",
    "Request timed out",
    "",
    "Transaction was reject",
  ])("does not treat %s as a rejection", (message) => {
    expect(isUserRejection(new Error(message))).toBe(false);
  });

  it("handles missing or non-error values", () => {
    expect(isUserRejection(null)).toBe(false);
    expect(isUserRejection(undefined)).toBe(false);
    expect(isUserRejection({ code: 4001 })).toBe(false);
  });
});

describe("categorizeError", () => {
  it.each([
    [new Error("User rejected the request"), "user_rejected"],
    [new Error("execution reverted: ERC20"), "revert"],
    [new Error("call revert exception"), "revert"],
    [new Error("Request timed out"), "timeout"],
    [new Error("timeout"), "timeout"],
    [new Error("Network error"), "network"],
    [new Error("failed to fetch"), "network"],
    [new Error("ECONNREFUSED"), "network"],
    [new Error("something odd happened"), "unknown"],
    [null, "unknown"],
  ])("categorizes %s as %s", (error, expected) => {
    expect(categorizeError(error)).toBe(expected);
  });
});

describe("trackEvent", () => {
  it("sends the event to gtag", () => {
    trackEvent("custom_event", { foo: "bar", count: 2 });

    expect(gtag()).toHaveBeenCalledWith("event", "custom_event", { foo: "bar", count: 2 });
  });

  it("sends nothing when analytics consent is refused", () => {
    vi.mocked(isAnalyticsAllowed).mockReturnValue(false);

    trackEvent("custom_event");
    setUserProperty("has_connected_wallet", true);

    expect(gtag()).not.toHaveBeenCalled();
  });

  it("queues events while gtag is unavailable and flushes them when it appears", () => {
    vi.useFakeTimers();
    const mockGtag = vi.fn();
    const originalGtag = window.gtag;
    try {
      window.gtag = undefined;
      trackEvent("queued_event", { value: 1 });
      expect(mockGtag).not.toHaveBeenCalled();

      window.gtag = mockGtag;
      vi.advanceTimersByTime(100);

      expect(mockGtag).toHaveBeenCalledWith("event", "queued_event", { value: 1 });
    } finally {
      window.gtag = originalGtag;
      vi.useRealTimers();
    }
  });
});

describe("tracked events", () => {
  it("tracks a wallet connection and marks the user as connected", () => {
    trackWalletConnect("injected");

    expect(gtag()).toHaveBeenCalledWith("event", "wallet_connect", { wallet_type: "injected" });
    expect(gtag()).toHaveBeenCalledWith("set", "user_properties", { has_connected_wallet: true });
  });

  it("tracks a wallet disconnection", () => {
    trackWalletDisconnect();

    expect(gtag()).toHaveBeenCalledWith("event", "wallet_disconnect", undefined);
  });

  it("tracks deposits with a bucketed amount and marks the user as deposited", () => {
    trackDepositInitiated("ycvxcrv", "500", "cvxCRV");
    expect(gtag()).toHaveBeenCalledWith("event", "deposit_initiated", {
      vault_id: "ycvxcrv",
      amount_bucket: "100-1K",
      token_symbol: "cvxCRV",
    });

    trackDepositSuccess("ycvxcrv", "500", "cvxCRV");
    expect(gtag()).toHaveBeenCalledWith("event", "deposit_success", {
      vault_id: "ycvxcrv",
      amount_bucket: "100-1K",
      token_symbol: "cvxCRV",
    });
    expect(gtag()).toHaveBeenCalledWith("set", "user_properties", { has_deposited: true });
  });

  it("buckets amounts instead of sending exact values", () => {
    trackWithdrawInitiated("yscvx", "50", "ysCVX");
    expect(gtag()).toHaveBeenCalledWith("event", "withdraw_initiated", expect.objectContaining({ amount_bucket: "<100" }));

    trackWithdrawSuccess("yscvx", "50000", "ysCVX");
    expect(gtag()).toHaveBeenCalledWith("event", "withdraw_success", expect.objectContaining({ amount_bucket: "10K-100K" }));

    trackWithdrawSuccess("yscvx", "500000", "ysCVX");
    expect(gtag()).toHaveBeenCalledWith("event", "withdraw_success", expect.objectContaining({ amount_bucket: "100K+" }));

    trackWithdrawSuccess("yscvx", "not-a-number", "ysCVX");
    expect(gtag()).toHaveBeenCalledWith("event", "withdraw_success", expect.objectContaining({ amount_bucket: "0" }));
  });

  it("tracks approvals", () => {
    trackApprovalInitiated("cvxCRV", "ycvxcrv");
    expect(gtag()).toHaveBeenCalledWith("event", "approval_initiated", {
      token_symbol: "cvxCRV",
      vault_id: "ycvxcrv",
    });

    trackApprovalSuccess("cvxCRV", "ycvxcrv");
    expect(gtag()).toHaveBeenCalledWith("event", "approval_success", {
      token_symbol: "cvxCRV",
      vault_id: "ycvxcrv",
    });
  });

  it("tracks a vault view", () => {
    trackVaultView("ycvxcrv", "ycvxCRV");

    expect(gtag()).toHaveBeenCalledWith("event", "vault_view", {
      vault_id: "ycvxcrv",
      vault_name: "ycvxCRV",
    });
  });

  it("tracks a transaction error with an inferred or explicit type", () => {
    trackTransactionError("deposit", "ycvxcrv", new Error("execution reverted"));
    expect(gtag()).toHaveBeenCalledWith("event", "transaction_error", {
      action: "deposit",
      vault_id: "ycvxcrv",
      error_type: "revert",
    });

    trackTransactionError("zap", "yscvx", new Error("whatever"), "network");
    expect(gtag()).toHaveBeenCalledWith("event", "transaction_error", {
      action: "zap",
      vault_id: "yscvx",
      error_type: "network",
    });
  });

  it("tracks a cancellation", () => {
    trackTransactionCancelled("withdraw", "ycvxcrv");

    expect(gtag()).toHaveBeenCalledWith("event", "transaction_cancelled", {
      action: "withdraw",
      vault_id: "ycvxcrv",
    });
  });

  it("tracks zaps with both amount buckets and marks the user as zapped", () => {
    trackZapInitiated("yscvx", "in", "ETH", "ysCVX", "1.5");
    expect(gtag()).toHaveBeenCalledWith("event", "zap_initiated", {
      vault_id: "yscvx",
      direction: "in",
      input_token: "ETH",
      output_token: "ysCVX",
      amount_bucket: "<100",
    });

    trackZapSuccess("yscvx", "out", "ysCVX", "ETH", "2500", "1.2");
    expect(gtag()).toHaveBeenCalledWith("event", "zap_success", {
      vault_id: "yscvx",
      direction: "out",
      input_token: "ysCVX",
      output_token: "ETH",
      amount_bucket: "1K-10K",
      amount_bucket_out: "<100",
    });
    expect(gtag()).toHaveBeenCalledWith("set", "user_properties", { has_used_zap: true });
  });

  it("tracks rewards and navigation events", () => {
    trackRewardsClaimClick();
    expect(gtag()).toHaveBeenCalledWith("event", "rewards_claim_click", undefined);

    trackCtaClick("deposit", "home");
    expect(gtag()).toHaveBeenCalledWith("event", "cta_click", { cta_name: "deposit", page: "home" });

    trackExternalLinkClick("https://curve.fi", "Curve");
    expect(gtag()).toHaveBeenCalledWith("event", "external_link_click", {
      url: "https://curve.fi",
      link_name: "Curve",
    });
  });
});

describe("setUserProperty", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets the property on gtag", () => {
    setUserProperty("preferred_vault", "ycvxcrv");

    expect(gtag()).toHaveBeenCalledWith("set", "user_properties", { preferred_vault: "ycvxcrv" });
  });
});
