import { describe, expect, it } from "vitest";

import {
  getPendingTxCopy,
  isLendingTxPendingVisible,
  isVaultTxPendingVisible,
  isZapTxPendingVisible,
} from "@/lib/transaction-ui";

describe("transaction-ui", () => {
  it("shows vault pending UI before and after a tx hash exists", () => {
    expect(isVaultTxPendingVisible("depositing")).toBe(true);
    expect(isVaultTxPendingVisible("withdrawing")).toBe(true);
    expect(isVaultTxPendingVisible("waitingTx")).toBe(true);
    expect(isVaultTxPendingVisible("idle")).toBe(false);
  });

  it("shows zap pending UI before and after a tx hash exists", () => {
    expect(isZapTxPendingVisible("zapping")).toBe(true);
    expect(isZapTxPendingVisible("waitingTx")).toBe(true);
    expect(isZapTxPendingVisible("idle")).toBe(false);
  });

  it("shows lending pending UI while the wallet is returning the tx hash", () => {
    expect(isLendingTxPendingVisible("executing")).toBe(true);
    expect(isLendingTxPendingVisible("waitingTx")).toBe(true);
    expect(isLendingTxPendingVisible("simulating")).toBe(false);
  });

  it("uses action-specific mobile handoff copy before the tx hash exists", () => {
    expect(getPendingTxCopy(false, "Repay")).toEqual({
      title: "Preparing Transaction",
      message:
        "Confirm the repay transaction in your wallet. If you already confirmed on mobile, keep this page open while the wallet returns the transaction hash.",
    });
  });
});
