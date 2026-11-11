import { parseUnits } from "viem";

/**
 * Sanitize numeric input: only allow digits and single decimal point
 * @param value - The input string to sanitize
 * @returns Sanitized string containing only digits and at most one decimal point
 */
export function sanitizeAmount(value: string): string {
  return value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
}

/**
 * True when two amount strings denote the same token amount ("1.5" and "1.50").
 * Unparseable input is only equal to itself.
 */
export function isSameAmount(a: string, b: string, decimals: number): boolean {
  if (a === b) return true;
  try {
    return parseUnits(a, decimals) === parseUnits(b, decimals);
  } catch {
    return false;
  }
}
