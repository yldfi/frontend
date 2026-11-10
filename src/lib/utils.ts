import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(
  value: number | string,
  options?: {
    decimals?: number;
    compact?: boolean;
    prefix?: string;
    suffix?: string;
  }
): string {
  const num = typeof value === "string" ? parseFloat(value) : value;

  if (isNaN(num)) return "—";

  const { decimals = 2, compact = false, prefix = "", suffix = "" } = options || {};

  let formatted: string;

  if (compact && Math.abs(num) >= 1_000_000_000) {
    formatted = (num / 1_000_000_000).toFixed(2) + "B";
  } else if (compact && Math.abs(num) >= 1_000_000) {
    formatted = (num / 1_000_000).toFixed(2) + "M";
  } else if (compact && Math.abs(num) >= 1_000) {
    formatted = (num / 1_000).toFixed(2) + "K";
  } else {
    formatted = num.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  return `${prefix}${formatted}${suffix}`;
}

export function formatPercent(value: number | string, decimals = 2): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "—";
  return `${num.toFixed(decimals)}%`;
}

export function shortenAddress(address: string, chars = 4): string {
  if (!address) return "";
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

/**
 * Format a USD value with appropriate suffix (M, K) and decimals
 * >= 1M → $X.XXM
 * >= 1K → $X.XK
 * else → $X.XX
 */
export function formatUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

export function formatTokenAmount(
  amount: bigint,
  decimals: number,
  displayDecimals = 4
): string {
  const divisor = BigInt(10 ** decimals);
  const integerPart = amount / divisor;
  const fractionalPart = amount % divisor;

  const fractionalStr = fractionalPart.toString().padStart(decimals, "0");
  const truncatedFractional = fractionalStr.slice(0, displayDecimals);

  return `${integerPart.toLocaleString()}.${truncatedFractional}`;
}

/**
 * Display a token amount with `minDecimals` places (default 4, the zap page's
 * usual precision), widening for small amounts so at least `sigDigits`
 * significant digits show. Trailing zeros past `minDecimals` are trimmed.
 *   1234.5      → "1234.5000"
 *   0.0265      → "0.0265"
 *   0.00000531  → "0.000005310" → "0.00000531"
 * Without this, dust such as 0.0265 CRV → ETH rendered as "0.0000 ETH".
 */
export function formatDisplayAmount(
  value: number | string,
  minDecimals = 4,
  sigDigits = 4,
): string {
  const num = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(num)) return "—";
  if (num === 0) return (0).toFixed(minDecimals);
  const leadingDigit = Math.floor(Math.log10(Math.abs(num)));
  const decimals = Math.min(18, Math.max(minDecimals, sigDigits - 1 - leadingDigit));
  const fixed = num.toFixed(decimals);
  if (decimals === minDecimals) return fixed;
  const [whole, fraction = ""] = fixed.split(".");
  const trimmed = fraction.replace(/0+$/, "").padEnd(minDecimals, "0");
  return `${whole}.${trimmed}`;
}
