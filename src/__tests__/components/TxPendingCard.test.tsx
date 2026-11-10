import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TxPendingCard } from "@/components/TxPendingCard";
import { getPendingTxCopy } from "@/lib/transaction-ui";

const details = { fromAmount: "14.3672", fromSymbol: "CVX", toAmount: "11.0798", toSymbol: "ysCVX" };

describe("TxPendingCard", () => {
  it("renders the shared copy, step label, asset pill and Etherscan link", () => {
    const copy = getPendingTxCopy(false, "approval");
    render(
      <TxPendingCard
        title={copy.title}
        message={copy.message}
        details={details}
        actionLabel="Deposit"
        stepLabel="Step 1 of 2 · Approve CVX, then deposit"
        hash="0xabc"
      />,
    );
    expect(screen.getByText("Preparing Transaction")).toBeTruthy();
    expect(screen.getByText("Confirm in your wallet. Keep this page open while the transaction submits.")).toBeTruthy();
    expect(screen.getByText("Step 1 of 2 · Approve CVX, then deposit")).toBeTruthy();
    expect(screen.getByText(/14\.3672 CVX/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /View on Etherscan/ }).getAttribute("href")).toBe("https://etherscan.io/tx/0xabc");
  });

  it("omits the step label and link when not given", () => {
    render(<TxPendingCard title="Awaiting Confirmation" message="Deposit confirming on-chain." />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText(/Step/)).toBeNull();
  });
});
