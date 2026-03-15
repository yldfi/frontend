/**
 * Google Analytics 4 Event Tracking for yld
 *
 * Events tracked:
 * - wallet_connect: When user connects wallet
 * - wallet_disconnect: When user disconnects wallet
 * - deposit_initiated / deposit_success: Vault deposits
 * - withdraw_initiated / withdraw_success: Vault withdrawals
 * - approval_initiated / approval_success: Token approvals
 * - vault_view: When user views a vault page
 * - zap_initiated / zap_success: Zap operations
 * - lending_borrow_initiated / lending_borrow_success: Borrow operations
 * - lending_repay_initiated / lending_repay_success: Repay operations
 * - lending_collateral_add_initiated / lending_collateral_add_success: Add collateral
 * - lending_leverage_initiated / lending_leverage_success: Leverage/deleverage
 * - lending_self_liquidate_initiated / lending_self_liquidate_success: Self-liquidation
 * - rewards_page_view: Rewards page viewed
 * - rewards_claim_click: Claim button clicked
 * - rewards_eligibility_check: Eligibility state tracked
 * - cta_click: CTA buttons clicked
 * - external_link_click: External links clicked
 * - lending_tab_switch: Lending tab changed
 * - transaction_error: Transaction errors with categorized error_type
 * - transaction_cancelled: User rejected in wallet
 */

import { isAnalyticsAllowed } from "@/components/CookieConsent";

declare global {
  interface Window {
    gtag?: (
      command: "event" | "config" | "set",
      action: string,
      params?: Record<string, unknown>
    ) => void;
  }
}

type EventParams = Record<string, string | number | boolean | undefined>;

// Queue for events that fire before gtag is ready
const eventQueue: Array<{ eventName: string; params?: EventParams }> = [];
let isProcessingQueue = false;
let eventQueueIntervalId: ReturnType<typeof setInterval> | null = null;

// Maximum queue size to prevent memory leaks
const MAX_QUEUE_SIZE = 100;

/**
 * Process queued events once gtag is available
 */
function processEventQueue(): void {
  if (isProcessingQueue || typeof window === "undefined" || !window.gtag) return;

  isProcessingQueue = true;

  // Clear the interval since gtag is now available
  if (eventQueueIntervalId) {
    clearInterval(eventQueueIntervalId);
    eventQueueIntervalId = null;
  }

  while (eventQueue.length > 0) {
    const event = eventQueue.shift();
    if (event) {
      try {
        window.gtag("event", event.eventName, event.params);
      } catch (error) {
        console.error("Analytics error processing queued event:", error);
      }
    }
  }
  isProcessingQueue = false;
}

/**
 * Track a custom event in Google Analytics
 * Events are queued if gtag isn't ready yet
 * Respects user consent for EEA visitors
 */
export function trackEvent(eventName: string, params?: EventParams): void {
  if (typeof window === "undefined") return;

  // Check if analytics is allowed (respects EEA consent)
  if (!isAnalyticsAllowed()) return;

  // If gtag is ready, send immediately
  if (window.gtag) {
    try {
      window.gtag("event", eventName, params);
    } catch (error) {
      console.error("Analytics error:", error);
    }
    // Also process any queued events
    processEventQueue();
  } else {
    // Queue the event for later (with size limit to prevent memory leaks)
    if (eventQueue.length < MAX_QUEUE_SIZE) {
      eventQueue.push({ eventName, params });
    }

    // Set up a single interval to check for gtag (avoid race condition)
    if (!eventQueueIntervalId) {
      eventQueueIntervalId = setInterval(() => {
        if (window.gtag) {
          processEventQueue();
        }
      }, 100);

      // Stop checking after 10 seconds
      setTimeout(() => {
        if (eventQueueIntervalId) {
          clearInterval(eventQueueIntervalId);
          eventQueueIntervalId = null;
        }
      }, 10000);
    }
  }
}

// Queue for user properties that are set before gtag is ready
const userPropertyQueue: Array<{ name: string; value: string | boolean }> = [];
let userPropertyQueueIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Process queued user properties once gtag is available
 */
function processUserPropertyQueue(): void {
  if (typeof window === "undefined" || !window.gtag) return;

  // Clear the interval since gtag is now available
  if (userPropertyQueueIntervalId) {
    clearInterval(userPropertyQueueIntervalId);
    userPropertyQueueIntervalId = null;
  }

  while (userPropertyQueue.length > 0) {
    const prop = userPropertyQueue.shift();
    if (prop) {
      try {
        window.gtag("set", "user_properties", { [prop.name]: prop.value });
      } catch (error) {
        console.error("Analytics error processing queued user property:", error);
      }
    }
  }
}

/**
 * Set a user property in Google Analytics
 * Properties are queued if gtag isn't ready yet
 * Respects user consent for EEA visitors
 */
export function setUserProperty(name: string, value: string | boolean): void {
  if (typeof window === "undefined") return;

  // Check if analytics is allowed (respects EEA consent)
  if (!isAnalyticsAllowed()) return;

  if (window.gtag) {
    try {
      window.gtag("set", "user_properties", { [name]: value });
    } catch (error) {
      console.error("Analytics error:", error);
    }
    processUserPropertyQueue();
  } else {
    // Queue the property (with size limit to prevent memory leaks)
    if (userPropertyQueue.length < MAX_QUEUE_SIZE) {
      userPropertyQueue.push({ name, value });
    }

    // Set up a single interval to check for gtag (avoid race condition)
    if (!userPropertyQueueIntervalId) {
      userPropertyQueueIntervalId = setInterval(() => {
        if (window.gtag) {
          processUserPropertyQueue();
        }
      }, 100);

      setTimeout(() => {
        if (userPropertyQueueIntervalId) {
          clearInterval(userPropertyQueueIntervalId);
          userPropertyQueueIntervalId = null;
        }
      }, 10000);
    }
  }
}

// Wallet Events
export function trackWalletConnect(walletType: string): void {
  trackEvent("wallet_connect", {
    wallet_type: walletType,
  });
  setUserProperty("has_connected_wallet", true);
}

export function trackWalletDisconnect(): void {
  trackEvent("wallet_disconnect");
}

// Transaction Events
export function trackDepositInitiated(
  vaultId: string,
  amount: string,
  tokenSymbol: string
): void {
  trackEvent("deposit_initiated", {
    vault_id: vaultId,
    amount_bucket: bucketAmount(amount),
    token_symbol: tokenSymbol,
  });
}

export function trackDepositSuccess(
  vaultId: string,
  amount: string,
  tokenSymbol: string
): void {
  trackEvent("deposit_success", {
    vault_id: vaultId,
    amount_bucket: bucketAmount(amount),
    token_symbol: tokenSymbol,
  });
  setUserProperty("has_deposited", true);
}

export function trackWithdrawInitiated(
  vaultId: string,
  shares: string,
  tokenSymbol: string
): void {
  trackEvent("withdraw_initiated", {
    vault_id: vaultId,
    amount_bucket: bucketAmount(shares),
    token_symbol: tokenSymbol,
  });
}

export function trackWithdrawSuccess(
  vaultId: string,
  shares: string,
  tokenSymbol: string
): void {
  trackEvent("withdraw_success", {
    vault_id: vaultId,
    amount_bucket: bucketAmount(shares),
    token_symbol: tokenSymbol,
  });
}

export function trackApprovalInitiated(
  tokenSymbol: string,
  vaultId: string
): void {
  trackEvent("approval_initiated", {
    token_symbol: tokenSymbol,
    vault_id: vaultId,
  });
}

export function trackApprovalSuccess(
  tokenSymbol: string,
  vaultId: string
): void {
  trackEvent("approval_success", {
    token_symbol: tokenSymbol,
    vault_id: vaultId,
  });
}

// Page/View Events
export function trackVaultView(vaultId: string, vaultName: string): void {
  trackEvent("vault_view", {
    vault_id: vaultId,
    vault_name: vaultName,
  });
}

// Error categorization
export type TransactionErrorType = "user_rejected" | "revert" | "timeout" | "network" | "unknown";

/**
 * Categorize an error into a known error type for analytics
 */
export function categorizeError(error: Error | string | unknown): TransactionErrorType {
  if (isUserRejection(error)) return "user_rejected";
  const msg = typeof error === "string" ? error : (error as Error)?.message || "";
  const lower = msg.toLowerCase();
  if (lower.includes("revert") || lower.includes("execution reverted") || lower.includes("call revert")) return "revert";
  if (lower.includes("timeout") || lower.includes("timed out")) return "timeout";
  if (lower.includes("network") || lower.includes("fetch") || lower.includes("econnrefused") || lower.includes("failed to fetch")) return "network";
  return "unknown";
}

// Error Events
export function trackTransactionError(
  action: "deposit" | "withdraw" | "approval" | "zap" | "borrow" | "repay" | "collateral" | "leverage" | "self_liquidate",
  vaultId: string,
  errorOrMessage: Error | string | unknown,
  errorType?: TransactionErrorType
): void {
  trackEvent("transaction_error", {
    action,
    vault_id: vaultId,
    error_type: errorType || categorizeError(errorOrMessage),
  });
}

// Cancelled Events (user rejected in wallet)
export function trackTransactionCancelled(
  action: "deposit" | "withdraw" | "approval" | "zap" | "borrow" | "repay" | "collateral" | "leverage" | "self_liquidate",
  vaultId: string
): void {
  trackEvent("transaction_cancelled", {
    action,
    vault_id: vaultId,
  });
}

/**
 * Bucket an amount into a range to prevent on-chain deanonymization.
 * Exact amounts + vault_id + timestamp could correlate users to chain activity.
 */
function bucketAmount(amount: string): string {
  const n = parseFloat(amount);
  if (isNaN(n) || n <= 0) return "0";
  if (n < 100) return "<100";
  if (n < 1000) return "100-1K";
  if (n < 10000) return "1K-10K";
  if (n < 100000) return "10K-100K";
  return "100K+";
}

// Zap Events
export function trackZapInitiated(
  vaultId: string,
  direction: "in" | "out",
  inputToken: string,
  outputToken: string,
  inputAmount: string
): void {
  trackEvent("zap_initiated", {
    vault_id: vaultId,
    direction,
    input_token: inputToken,
    output_token: outputToken,
    amount_bucket: bucketAmount(inputAmount),
  });
}

export function trackZapSuccess(
  vaultId: string,
  direction: "in" | "out",
  inputToken: string,
  outputToken: string,
  inputAmount: string,
  outputAmount: string
): void {
  trackEvent("zap_success", {
    vault_id: vaultId,
    direction,
    input_token: inputToken,
    output_token: outputToken,
    amount_bucket: bucketAmount(inputAmount),
    amount_bucket_out: bucketAmount(outputAmount),
  });
  setUserProperty("has_used_zap", true);
}

// Lending Events — Borrow
export function trackLendingBorrowInitiated(
  vaultId: string,
  amount: string,
  tokenSymbol: string
): void {
  trackEvent("lending_borrow_initiated", {
    vault_id: vaultId,
    amount_bucket: bucketAmount(amount),
    token_symbol: tokenSymbol,
  });
}

export function trackLendingBorrowSuccess(
  vaultId: string,
  amount: string,
  tokenSymbol: string
): void {
  trackEvent("lending_borrow_success", {
    vault_id: vaultId,
    amount_bucket: bucketAmount(amount),
    token_symbol: tokenSymbol,
  });
  setUserProperty("has_borrowed", true);
}

// Lending Events — Repay
export function trackLendingRepayInitiated(
  vaultId: string,
  amount: string
): void {
  trackEvent("lending_repay_initiated", {
    vault_id: vaultId,
    amount_bucket: bucketAmount(amount),
  });
}

export function trackLendingRepaySuccess(
  vaultId: string,
  amount: string
): void {
  trackEvent("lending_repay_success", {
    vault_id: vaultId,
    amount_bucket: bucketAmount(amount),
  });
}

// Lending Events — Collateral
export function trackLendingCollateralAddInitiated(
  vaultId: string,
  amount: string,
  tokenSymbol: string
): void {
  trackEvent("lending_collateral_add_initiated", {
    vault_id: vaultId,
    amount_bucket: bucketAmount(amount),
    token_symbol: tokenSymbol,
  });
}

export function trackLendingCollateralAddSuccess(
  vaultId: string,
  amount: string,
  tokenSymbol: string
): void {
  trackEvent("lending_collateral_add_success", {
    vault_id: vaultId,
    amount_bucket: bucketAmount(amount),
    token_symbol: tokenSymbol,
  });
}

// Lending Events — Leverage
export function trackLendingLeverageInitiated(
  vaultId: string,
  amount: string,
  leverageMultiplier: string
): void {
  trackEvent("lending_leverage_initiated", {
    vault_id: vaultId,
    amount_bucket: bucketAmount(amount),
    leverage_multiplier: leverageMultiplier,
  });
}

export function trackLendingLeverageSuccess(
  vaultId: string,
  amount: string,
  leverageMultiplier: string
): void {
  trackEvent("lending_leverage_success", {
    vault_id: vaultId,
    amount_bucket: bucketAmount(amount),
    leverage_multiplier: leverageMultiplier,
  });
  setUserProperty("has_used_leverage", true);
}

// Lending Events — Self-Liquidate
export function trackLendingSelfLiquidateInitiated(
  vaultId: string
): void {
  trackEvent("lending_self_liquidate_initiated", {
    vault_id: vaultId,
  });
}

export function trackLendingSelfLiquidateSuccess(
  vaultId: string
): void {
  trackEvent("lending_self_liquidate_success", {
    vault_id: vaultId,
  });
}

// Rewards Events
export function trackRewardsPageView(): void {
  trackEvent("rewards_page_view");
}

export function trackRewardsClaimClick(): void {
  trackEvent("rewards_claim_click");
}

export function trackRewardsEligibilityCheck(
  hasYcvxcrv: boolean,
  hasBorrowPosition: boolean
): void {
  trackEvent("rewards_eligibility_check", {
    has_ycvxcrv: hasYcvxcrv,
    has_borrow_position: hasBorrowPosition,
  });
}

// CTA and Navigation Events
export function trackCtaClick(ctaName: string, page: string): void {
  trackEvent("cta_click", {
    cta_name: ctaName,
    page,
  });
}

export function trackExternalLinkClick(url: string, linkName: string): void {
  trackEvent("external_link_click", {
    url,
    link_name: linkName,
  });
}

export function trackLendingTabSwitch(tabName: string): void {
  trackEvent("lending_tab_switch", {
    tab_name: tabName,
  });
}

/**
 * Check if an error is a user rejection (cancelled in wallet)
 */
export function isUserRejection(error: Error | string | unknown): boolean {
  const errorMessage = typeof error === "string" ? error : (error as Error)?.message || "";
  const rejectionPhrases = [
    "user rejected",
    "user denied",
    "rejected the request",
    "user cancelled",
    "user canceled",
    "rejected transaction",
    "transaction cancelled",
    "ACTION_REJECTED",
  ];
  return rejectionPhrases.some((phrase) =>
    errorMessage.toLowerCase().includes(phrase.toLowerCase())
  );
}
