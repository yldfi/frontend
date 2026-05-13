export type TxActionKind = "deposit" | "withdraw" | "zap";

export const TX_SUCCESS_VISIBLE_MS = 30_000;
export const TX_REVERTED_VISIBLE_MS = 45_000;

export function isVaultTxPendingVisible(status: string): boolean {
  return status === "depositing" || status === "withdrawing" || status === "waitingTx";
}

export function isZapTxPendingVisible(status: string): boolean {
  return status === "zapping" || status === "waitingTx";
}

export function isLendingTxPendingVisible(status: string): boolean {
  return status === "executing" || status === "waitingTx";
}

export function getPendingTxCopy(hasHash: boolean, actionLabel = "transaction"): { title: string; message: string } {
  const action = actionLabel.toLowerCase();
  if (hasHash) {
    return {
      title: "Awaiting Confirmation",
      message: `Your ${action} transaction is being confirmed on-chain.`,
    };
  }

  return {
    title: "Preparing Transaction",
    message:
      `Confirm the ${action} transaction in your wallet. If you already confirmed on mobile, keep this page open while the wallet returns the transaction hash.`,
  };
}

export function getTxActionLabel(kind: TxActionKind): string {
  if (kind === "withdraw") return "Withdrawal";
  if (kind === "zap") return "Zap";
  return "Deposit";
}

export function getSuccessTxCopy(kind: TxActionKind): { title: string; message: string } {
  return {
    title: `${getTxActionLabel(kind)} Successful`,
    message: "Your transaction has been confirmed.",
  };
}

export function getRevertedTxCopy(kind: TxActionKind): { title: string; message: string } {
  return {
    title: `${getTxActionLabel(kind)} Failed`,
    message: "Transaction reverted on-chain.",
  };
}
