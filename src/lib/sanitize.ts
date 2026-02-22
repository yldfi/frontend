/**
 * Sanitize numeric input: only allow digits and single decimal point
 * @param value - The input string to sanitize
 * @returns Sanitized string containing only digits and at most one decimal point
 */
export function sanitizeAmount(value: string): string {
  return value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
}
