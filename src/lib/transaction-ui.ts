export type TxActionKind = "deposit" | "withdraw" | "zap";

export const TX_SUCCESS_VISIBLE_MS = 10_000;
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
  const action = (actionLabel || "transaction").toLowerCase();
  const actionSentence = `${action.charAt(0).toUpperCase()}${action.slice(1)}`;
  if (hasHash) {
    return {
      title: "Awaiting Confirmation",
      message: `${actionSentence} confirming on-chain.`,
    };
  }

  return {
    title: "Preparing Transaction",
    message: "Confirm in your wallet. Keep this page open while the transaction submits.",
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
    message: "Transaction confirmed.",
  };
}

export function getRevertedTxCopy(kind: TxActionKind): { title: string; message: string } {
  return {
    title: `${getTxActionLabel(kind)} Failed`,
    message: "Transaction reverted.",
  };
}
