/**
 * Google Analytics 4 Event Tracking for YLD.fi
 *
 * Events tracked:
 * - wallet_connect: When user connects wallet
 * - wallet_disconnect: When user disconnects wallet
 * - deposit_initiated: When user starts a deposit
 * - deposit_success: When deposit transaction succeeds
 * - withdraw_initiated: When user starts a withdrawal
 * - withdraw_success: When withdrawal transaction succeeds
 * - approval_initiated: When user starts token approval
 * - approval_success: When approval transaction succeeds
 * - vault_view: When user views a vault page
 * - network_switch: When user switches networks
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

/**
 * Process queued events once gtag is available
 */
function processEventQueue(): void {
  if (isProcessingQueue || typeof window === "undefined" || !window.gtag) return;

  isProcessingQueue = true;
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
    // Queue the event for later
    eventQueue.push({ eventName, params });

    // Set up a check for when gtag becomes available
    const checkGtag = setInterval(() => {
      if (window.gtag) {
        clearInterval(checkGtag);
        processEventQueue();
      }
    }, 100);

    // Stop checking after 10 seconds
    setTimeout(() => clearInterval(checkGtag), 10000);
  }
}

// Queue for user properties that are set before gtag is ready
const userPropertyQueue: Array<{ name: string; value: string | boolean }> = [];

/**
 * Process queued user properties once gtag is available
 */
function processUserPropertyQueue(): void {
  if (typeof window === "undefined" || !window.gtag) return;

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
    userPropertyQueue.push({ name, value });

    const checkGtag = setInterval(() => {
      if (window.gtag) {
        clearInterval(checkGtag);
        processUserPropertyQueue();
      }
    }, 100);

    setTimeout(() => clearInterval(checkGtag), 10000);
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
    amount,
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
    amount,
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
    shares,
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
    shares,
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

// Network Events
export function trackNetworkSwitch(
  fromChain: string | undefined,
  toChain: string
): void {
  trackEvent("network_switch", {
    from_chain: fromChain || "unknown",
    to_chain: toChain,
  });
}

// Error Events
export function trackTransactionError(
  action: "deposit" | "withdraw" | "approval" | "zap",
  vaultId: string,
  errorMessage: string
): void {
  trackEvent("transaction_error", {
    action,
    vault_id: vaultId,
    error_message: errorMessage.slice(0, 100), // Truncate long errors
  });
}

// Cancelled Events (user rejected in wallet)
export function trackTransactionCancelled(
  action: "deposit" | "withdraw" | "approval" | "zap",
  vaultId: string
): void {
  trackEvent("transaction_cancelled", {
    action,
    vault_id: vaultId,
  });
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
    input_amount: inputAmount,
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
    input_amount: inputAmount,
    output_amount: outputAmount,
  });
  setUserProperty("has_used_zap", true);
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
    "ACTION_REJECTED",
  ];
  return rejectionPhrases.some((phrase) =>
    errorMessage.toLowerCase().includes(phrase.toLowerCase())
  );
}
