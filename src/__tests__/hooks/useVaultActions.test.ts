import { describe, it, expect } from "vitest";
import { parseUnits, maxUint256 } from "viem";

// Test the needsApproval logic directly
describe("needsApproval logic", () => {
  function needsApproval(amount: string, allowance: bigint | undefined, decimals: number): boolean {
    if (!amount || !allowance) return true;
    try {
      const amountWei = parseUnits(amount, decimals);
      return allowance < amountWei;
    } catch {
      return true;
    }
  }

  describe("returns true when approval needed", () => {
    it("returns true when allowance is undefined", () => {
      expect(needsApproval("100", undefined, 18)).toBe(true);
    });

    it("returns true when amount is empty", () => {
      expect(needsApproval("", BigInt(1000), 18)).toBe(true);
    });

    it("returns true when allowance < amount", () => {
      // Allowance: 50 tokens, Amount: 100 tokens
      const allowance = parseUnits("50", 18);
      expect(needsApproval("100", allowance, 18)).toBe(true);
    });

    it("returns true for zero allowance", () => {
      expect(needsApproval("1", BigInt(0), 18)).toBe(true);
    });
  });

  describe("returns false when approval not needed", () => {
    it("returns false when allowance >= amount", () => {
      // Allowance: 100 tokens, Amount: 50 tokens
      const allowance = parseUnits("100", 18);
      expect(needsApproval("50", allowance, 18)).toBe(false);
    });

    it("returns false when allowance equals amount", () => {
      // Allowance: 100 tokens, Amount: 100 tokens
      const allowance = parseUnits("100", 18);
      expect(needsApproval("100", allowance, 18)).toBe(false);
    });

    it("returns false for max uint256 allowance", () => {
      expect(needsApproval("1000000000", maxUint256, 18)).toBe(false);
    });
  });

  describe("handles different decimals", () => {
    it("works with 6 decimal tokens (USDC)", () => {
      const allowance = parseUnits("100", 6); // 100 USDC
      expect(needsApproval("50", allowance, 6)).toBe(false);
      expect(needsApproval("150", allowance, 6)).toBe(true);
    });

    it("works with 8 decimal tokens (WBTC)", () => {
      const allowance = parseUnits("1", 8); // 1 WBTC
      expect(needsApproval("0.5", allowance, 8)).toBe(false);
      expect(needsApproval("2", allowance, 8)).toBe(true);
    });
  });

  describe("handles edge cases", () => {
    it("returns true for invalid amount string", () => {
      expect(needsApproval("invalid", parseUnits("100", 18), 18)).toBe(true);
    });

    it("handles very small amounts", () => {
      const allowance = parseUnits("0.0001", 18);
      expect(needsApproval("0.00005", allowance, 18)).toBe(false);
      expect(needsApproval("0.0002", allowance, 18)).toBe(true);
    });

    it("handles very large amounts", () => {
      const allowance = parseUnits("1000000", 18);
      expect(needsApproval("500000", allowance, 18)).toBe(false);
    });
  });
});

describe("transaction status derivation logic", () => {
  type TransactionStatus = "idle" | "approving" | "waitingApproval" | "depositing" | "withdrawing" | "waitingTx" | "success" | "error";
  type ActionState = "idle" | "approving" | "depositing" | "withdrawing";

  interface StatusInputs {
    approveError: Error | null;
    depositError: Error | null;
    withdrawError: Error | null;
    isDepositSuccess: boolean;
    isWithdrawSuccess: boolean;
    isApprovalSuccess: boolean;
    isApprovalPending: boolean;
    isDepositPending: boolean;
    isWithdrawPending: boolean;
    actionState: ActionState;
  }

  function deriveStatus(inputs: StatusInputs): TransactionStatus {
    const {
      approveError, depositError, withdrawError,
      isDepositSuccess, isWithdrawSuccess, isApprovalSuccess,
      isApprovalPending, isDepositPending, isWithdrawPending,
      actionState
    } = inputs;

    // Error states take priority
    if (approveError || depositError || withdrawError) return "error";
    // Success states
    if (isDepositSuccess || isWithdrawSuccess) return "success";
    // Approval success means we go back to idle (ready for deposit/withdraw)
    if (isApprovalSuccess) return "idle";
    // Pending transaction states
    if (isApprovalPending) return "waitingApproval";
    if (isDepositPending || isWithdrawPending) return "waitingTx";
    // User-initiated action states
    if (actionState === "approving") return "approving";
    if (actionState === "depositing") return "depositing";
    if (actionState === "withdrawing") return "withdrawing";
    return "idle";
  }

  const defaultInputs: StatusInputs = {
    approveError: null,
    depositError: null,
    withdrawError: null,
    isDepositSuccess: false,
    isWithdrawSuccess: false,
    isApprovalSuccess: false,
    isApprovalPending: false,
    isDepositPending: false,
    isWithdrawPending: false,
    actionState: "idle",
  };

  describe("error states take priority", () => {
    it("returns error for approve error", () => {
      expect(deriveStatus({ ...defaultInputs, approveError: new Error("test") })).toBe("error");
    });

    it("returns error for deposit error", () => {
      expect(deriveStatus({ ...defaultInputs, depositError: new Error("test") })).toBe("error");
    });

    it("returns error for withdraw error", () => {
      expect(deriveStatus({ ...defaultInputs, withdrawError: new Error("test") })).toBe("error");
    });

    it("error takes priority over success", () => {
      expect(deriveStatus({
        ...defaultInputs,
        approveError: new Error("test"),
        isDepositSuccess: true,
      })).toBe("error");
    });

    it("error takes priority over pending", () => {
      expect(deriveStatus({
        ...defaultInputs,
        depositError: new Error("test"),
        isApprovalPending: true,
      })).toBe("error");
    });
  });

  describe("success states", () => {
    it("returns success for deposit success", () => {
      expect(deriveStatus({ ...defaultInputs, isDepositSuccess: true })).toBe("success");
    });

    it("returns success for withdraw success", () => {
      expect(deriveStatus({ ...defaultInputs, isWithdrawSuccess: true })).toBe("success");
    });

    it("returns idle after approval success (ready for next action)", () => {
      expect(deriveStatus({ ...defaultInputs, isApprovalSuccess: true })).toBe("idle");
    });
  });

  describe("pending states", () => {
    it("returns waitingApproval when approval pending", () => {
      expect(deriveStatus({ ...defaultInputs, isApprovalPending: true })).toBe("waitingApproval");
    });

    it("returns waitingTx when deposit pending", () => {
      expect(deriveStatus({ ...defaultInputs, isDepositPending: true })).toBe("waitingTx");
    });

    it("returns waitingTx when withdraw pending", () => {
      expect(deriveStatus({ ...defaultInputs, isWithdrawPending: true })).toBe("waitingTx");
    });
  });

  describe("action states", () => {
    it("returns approving when actionState is approving", () => {
      expect(deriveStatus({ ...defaultInputs, actionState: "approving" })).toBe("approving");
    });

    it("returns depositing when actionState is depositing", () => {
      expect(deriveStatus({ ...defaultInputs, actionState: "depositing" })).toBe("depositing");
    });

    it("returns withdrawing when actionState is withdrawing", () => {
      expect(deriveStatus({ ...defaultInputs, actionState: "withdrawing" })).toBe("withdrawing");
    });

    it("returns idle for idle actionState", () => {
      expect(deriveStatus(defaultInputs)).toBe("idle");
    });
  });

  describe("state priority order", () => {
    it("pending takes priority over action state", () => {
      expect(deriveStatus({
        ...defaultInputs,
        isApprovalPending: true,
        actionState: "approving",
      })).toBe("waitingApproval");
    });

    it("success takes priority over pending", () => {
      expect(deriveStatus({
        ...defaultInputs,
        isDepositSuccess: true,
        isApprovalPending: true,
      })).toBe("success");
    });
  });
});

describe("error message derivation logic", () => {
  function deriveError(
    approveError: Error | null,
    depositError: Error | null,
    withdrawError: Error | null
  ): string | null {
    if (approveError) return approveError.message || "Approval failed";
    if (depositError) return depositError.message || "Deposit failed";
    if (withdrawError) return withdrawError.message || "Withdraw failed";
    return null;
  }

  it("returns null when no errors", () => {
    expect(deriveError(null, null, null)).toBeNull();
  });

  it("returns approve error message", () => {
    expect(deriveError(new Error("User rejected"), null, null)).toBe("User rejected");
  });

  it("returns deposit error message", () => {
    expect(deriveError(null, new Error("Insufficient balance"), null)).toBe("Insufficient balance");
  });

  it("returns withdraw error message", () => {
    expect(deriveError(null, null, new Error("Slippage too high"))).toBe("Slippage too high");
  });

  it("returns default message for error without message", () => {
    const errorWithoutMessage = new Error();
    errorWithoutMessage.message = "";
    expect(deriveError(errorWithoutMessage, null, null)).toBe("Approval failed");
  });

  it("approve error takes priority", () => {
    expect(deriveError(
      new Error("Approve error"),
      new Error("Deposit error"),
      new Error("Withdraw error")
    )).toBe("Approve error");
  });

  it("deposit error takes priority over withdraw", () => {
    expect(deriveError(
      null,
      new Error("Deposit error"),
      new Error("Withdraw error")
    )).toBe("Deposit error");
  });
});

describe("isLoading derivation logic", () => {
  type TransactionStatus = "idle" | "approving" | "waitingApproval" | "depositing" | "withdrawing" | "waitingTx" | "success" | "error";

  function isLoading(status: TransactionStatus): boolean {
    return status !== "idle" && status !== "success" && status !== "error";
  }

  it("returns false for idle", () => {
    expect(isLoading("idle")).toBe(false);
  });

  it("returns false for success", () => {
    expect(isLoading("success")).toBe(false);
  });

  it("returns false for error", () => {
    expect(isLoading("error")).toBe(false);
  });

  it("returns true for approving", () => {
    expect(isLoading("approving")).toBe(true);
  });

  it("returns true for waitingApproval", () => {
    expect(isLoading("waitingApproval")).toBe(true);
  });

  it("returns true for depositing", () => {
    expect(isLoading("depositing")).toBe(true);
  });

  it("returns true for withdrawing", () => {
    expect(isLoading("withdrawing")).toBe(true);
  });

  it("returns true for waitingTx", () => {
    expect(isLoading("waitingTx")).toBe(true);
  });
});
