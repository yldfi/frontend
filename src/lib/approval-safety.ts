// Mirrors ENSO_SHORTCUTS from src/lib/enso.ts without importing the large Enso module.
export const ENSO_SHORTCUTS_ADDRESS = "0x4Fe93ebC4Ce6Ae4f81601cC7Ce7139023919E003";

export const FORBIDDEN_APPROVAL_SPENDER_ERROR =
  "Refusing to request approval for Enso Shortcuts. User approvals must target Enso Router Executor or an explicit trusted protocol spender.";

export function isForbiddenApprovalSpender(spender: string | null | undefined): boolean {
  return typeof spender === "string" && spender.toLowerCase() === ENSO_SHORTCUTS_ADDRESS.toLowerCase();
}

export function assertSafeApprovalSpender(spender: string | null | undefined): void {
  if (isForbiddenApprovalSpender(spender)) {
    throw new Error(FORBIDDEN_APPROVAL_SPENDER_ERROR);
  }
}

export function findForbiddenApproval<T extends { spender?: string | null }>(
  approvals: readonly T[]
): T | undefined {
  return approvals.find((approval) => isForbiddenApprovalSpender(approval.spender));
}
