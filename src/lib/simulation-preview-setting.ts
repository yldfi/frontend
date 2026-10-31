export const SIMULATION_PREVIEW_KEY = "yldfi-show-simulation";

/** The user's explicit choice, or null when they never set one. */
export function readStoredSimulationPreview(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const value = localStorage.getItem(SIMULATION_PREVIEW_KEY);
    return value == null ? null : value === "true";
  } catch {
    return null;
  }
}

export function writeStoredSimulationPreview(value: boolean): void {
  try {
    localStorage.setItem(SIMULATION_PREVIEW_KEY, String(value));
  } catch { /* ignore */ }
}

/**
 * An explicit choice always wins. Without one, Safe accounts get the preview:
 * a multisig transaction is slow to collect signatures and costly to redo, and
 * inside the Safe App frame the site has its own (empty) storage, so the
 * choice made on the normal site doesn't carry over.
 */
export function resolveSimulationPreview(stored: boolean | null, isSafe: boolean): boolean {
  return stored ?? isSafe;
}
