import { describe, expect, it } from "vitest";

import {
  formatTxAssetAmount,
  getPendingTxCopy,
  isSameTxAssetPair,
  isLendingTxPendingVisible,
  isVaultTxPendingVisible,
  isZapTxPendingVisible,
  TX_REVERTED_VISIBLE_MS,
  TX_SUCCESS_VISIBLE_MS,
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

  it("uses concise wallet confirmation copy before the tx hash exists", () => {
    expect(getPendingTxCopy(false, "Repay")).toEqual({
      title: "Preparing Transaction",
      message: "Confirm in your wallet. Keep this page open while the transaction submits.",
    });
  });

  it("keeps success visible briefly but leaves failures longer", () => {
    expect(TX_SUCCESS_VISIBLE_MS).toBe(10_000);
    expect(TX_REVERTED_VISIBLE_MS).toBeGreaterThan(TX_SUCCESS_VISIBLE_MS);
  });

  it("collapses same-symbol transaction details even when logos differ", () => {
    expect(isSameTxAssetPair({
      fromSymbol: "ycvxCRV",
      toSymbol: "YCVXCRV",
    })).toBe(true);
  });

  it("formats long precision amounts for transaction cards", () => {
    expect(formatTxAssetAmount("41677.287086380694305179")).toBe("41,677.2871");
  });
});
