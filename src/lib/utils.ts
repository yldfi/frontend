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
