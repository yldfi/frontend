import { describe, it, expect } from "vitest";
import { parseUnits, maxUint256 } from "viem";

// Test the useZapActions business logic directly
// Since it uses wagmi hooks, we test the logic patterns without importing the hook

describe("useZapActions logic", () => {
  const ETH_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

  describe("isEth detection", () => {
    function isEth(inputAddress: string | undefined): boolean {
      if (!inputAddress) return false;
      return inputAddress.toLowerCase() === ETH_ADDRESS.toLowerCase();
    }

    it("detects ETH address (lowercase)", () => {
      expect(isEth(ETH_ADDRESS)).toBe(true);
    });

    it("detects ETH address (uppercase)", () => {
      expect(isEth("0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE")).toBe(true);
    });

    it("detects ETH address (mixed case)", () => {
      expect(isEth("0xEeeeEeeeEEeEEEeEeEEEEeeEEEeEeEeEEeeEeEee")).toBe(true);
    });

    it("returns false for USDC address", () => {
      expect(isEth("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isEth(undefined)).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isEth("")).toBe(false);
    });
  });

  describe("needsApproval logic", () => {
    interface QuoteLike {
      inputAmount: string;
      inputToken: { decimals: number; address: string };
    }

    function needsApproval(
      isEth: boolean,
      quote: QuoteLike | null | undefined,
      allowance: bigint | undefined
    ): boolean {
      if (isEth || !quote) return false;
      try {
        const amountWei = parseUnits(quote.inputAmount, quote.inputToken.decimals);
        return !allowance || allowance < amountWei;
      } catch {
        return true;
      }
    }

    const mockQuote = (amount: string, decimals: number = 18): QuoteLike => ({
      inputAmount: amount,
      inputToken: { decimals, address: "0x1234" },
    });

    describe("returns false when approval not needed", () => {
      it("returns false for ETH (never needs approval)", () => {
        expect(needsApproval(true, mockQuote("100"), BigInt(0))).toBe(false);
      });

      it("returns false when quote is null", () => {
        expect(needsApproval(false, null, BigInt(1000))).toBe(false);
      });

      it("returns false when quote is undefined", () => {
        expect(needsApproval(false, undefined, BigInt(1000))).toBe(false);
      });

      it("returns false when allowance >= amount", () => {
        const allowance = parseUnits("100", 18);
        expect(needsApproval(false, mockQuote("50"), allowance)).toBe(false);
      });

      it("returns false when allowance equals amount", () => {
        const allowance = parseUnits("100", 18);
        expect(needsApproval(false, mockQuote("100"), allowance)).toBe(false);
      });

      it("returns false for max uint256 allowance", () => {
        expect(needsApproval(false, mockQuote("1000000000"), maxUint256)).toBe(false);
      });
    });

    describe("returns true when approval needed", () => {
      it("returns true when allowance is undefined", () => {
        expect(needsApproval(false, mockQuote("100"), undefined)).toBe(true);
      });

      it("returns true when allowance < amount", () => {
        const allowance = parseUnits("50", 18);
        expect(needsApproval(false, mockQuote("100"), allowance)).toBe(true);
      });

      it("returns true for zero allowance", () => {
        expect(needsApproval(false, mockQuote("1"), BigInt(0))).toBe(true);
      });

      it("returns true for invalid amount string", () => {
        expect(needsApproval(false, mockQuote("invalid"), parseUnits("100", 18))).toBe(true);
      });

      it("handles negative amount (parses to negative bigint)", () => {
        // viem parseUnits converts "-100" to a negative bigint
        // A negative amount is always less than any positive allowance
        expect(needsApproval(false, mockQuote("-100"), parseUnits("100", 18))).toBe(false);
      });
    });

    describe("handles different decimals", () => {
      it("works with 6 decimal tokens (USDC)", () => {
        const allowance = parseUnits("100", 6);
        expect(needsApproval(false, mockQuote("50", 6), allowance)).toBe(false);
        expect(needsApproval(false, mockQuote("150", 6), allowance)).toBe(true);
      });

      it("works with 8 decimal tokens (WBTC)", () => {
        const allowance = parseUnits("1", 8);
        expect(needsApproval(false, mockQuote("0.5", 8), allowance)).toBe(false);
        expect(needsApproval(false, mockQuote("2", 8), allowance)).toBe(true);
      });
    });
  });

  describe("parseErrorMessage logic", () => {
    function parseErrorMessage(error: Error | null, defaultMsg: string): string | null {
      if (!error) return null;
      const msg = error.message || defaultMsg;
      if (msg.includes("User rejected") || msg.includes("user rejected")) {
        return "Transaction cancelled";
      }
      return msg;
    }

    it("returns null for null error", () => {
      expect(parseErrorMessage(null, "Default")).toBeNull();
    });

    it("returns 'Transaction cancelled' for user rejection (uppercase)", () => {
      expect(parseErrorMessage(new Error("User rejected the request"), "Default")).toBe(
        "Transaction cancelled"
      );
    });

    it("returns 'Transaction cancelled' for user rejection (lowercase)", () => {
      expect(parseErrorMessage(new Error("user rejected transaction"), "Default")).toBe(
        "Transaction cancelled"
      );
    });

    it("returns error message for other errors", () => {
      expect(parseErrorMessage(new Error("Insufficient balance"), "Default")).toBe(
        "Insufficient balance"
      );
    });

    it("returns default message when error has no message", () => {
      const error = new Error();
      error.message = "";
      expect(parseErrorMessage(error, "Approval failed")).toBe("Approval failed");
    });

    it("handles network errors", () => {
      expect(parseErrorMessage(new Error("Network error"), "Default")).toBe("Network error");
    });

    it("handles gas estimation errors", () => {
      expect(parseErrorMessage(new Error("Gas estimation failed"), "Default")).toBe(
        "Gas estimation failed"
      );
    });
  });

  describe("ZapStatus derivation logic", () => {
    type ZapStatus =
      | "idle"
      | "approving"
      | "waitingApproval"
      | "zapping"
      | "waitingTx"
      | "success"
      | "error";
    type ActionState = "idle" | "approving" | "zapping";

    interface StatusInputs {
      approveError: Error | null;
      zapError: Error | null;
      isZapSuccess: boolean;
      isApprovalSuccess: boolean;
      isApprovalPending: boolean;
      isZapPending: boolean;
      actionState: ActionState;
    }

    function deriveStatus(inputs: StatusInputs): ZapStatus {
      const {
        approveError,
        zapError,
        isZapSuccess,
        isApprovalSuccess,
        isApprovalPending,
        isZapPending,
        actionState,
      } = inputs;

      // Error states take priority
      if (approveError || zapError) return "error";
      // Success state
      if (isZapSuccess) return "success";
      // Approval success means we go back to idle (ready for zap)
      if (isApprovalSuccess) return "idle";
      // Pending transaction states
      if (isApprovalPending) return "waitingApproval";
      if (isZapPending) return "waitingTx";
      // User-initiated action states
      if (actionState === "approving") return "approving";
      if (actionState === "zapping") return "zapping";
      return "idle";
    }

    const defaultInputs: StatusInputs = {
      approveError: null,
      zapError: null,
      isZapSuccess: false,
      isApprovalSuccess: false,
      isApprovalPending: false,
      isZapPending: false,
      actionState: "idle",
    };

    describe("error states take priority", () => {
      it("returns error for approve error", () => {
        expect(deriveStatus({ ...defaultInputs, approveError: new Error("test") })).toBe("error");
      });

      it("returns error for zap error", () => {
        expect(deriveStatus({ ...defaultInputs, zapError: new Error("test") })).toBe("error");
      });

      it("error takes priority over success", () => {
        expect(
          deriveStatus({
            ...defaultInputs,
            approveError: new Error("test"),
            isZapSuccess: true,
          })
        ).toBe("error");
      });

      it("error takes priority over pending", () => {
        expect(
          deriveStatus({
            ...defaultInputs,
            zapError: new Error("test"),
            isApprovalPending: true,
          })
        ).toBe("error");
      });
    });

    describe("success states", () => {
      it("returns success for zap success", () => {
        expect(deriveStatus({ ...defaultInputs, isZapSuccess: true })).toBe("success");
      });

      it("returns idle after approval success (ready for zap)", () => {
        expect(deriveStatus({ ...defaultInputs, isApprovalSuccess: true })).toBe("idle");
      });
    });

    describe("pending states", () => {
      it("returns waitingApproval when approval pending", () => {
        expect(deriveStatus({ ...defaultInputs, isApprovalPending: true })).toBe("waitingApproval");
      });

      it("returns waitingTx when zap pending", () => {
        expect(deriveStatus({ ...defaultInputs, isZapPending: true })).toBe("waitingTx");
      });
    });

    describe("action states", () => {
      it("returns approving when actionState is approving", () => {
        expect(deriveStatus({ ...defaultInputs, actionState: "approving" })).toBe("approving");
      });

      it("returns zapping when actionState is zapping", () => {
        expect(deriveStatus({ ...defaultInputs, actionState: "zapping" })).toBe("zapping");
      });

      it("returns idle for idle actionState", () => {
        expect(deriveStatus(defaultInputs)).toBe("idle");
      });
    });

    describe("state priority order", () => {
      it("pending takes priority over action state", () => {
        expect(
          deriveStatus({
            ...defaultInputs,
            isApprovalPending: true,
            actionState: "approving",
          })
        ).toBe("waitingApproval");
      });

      it("success takes priority over pending", () => {
        expect(
          deriveStatus({
            ...defaultInputs,
            isZapSuccess: true,
            isApprovalPending: true,
          })
        ).toBe("success");
      });

      it("approval success goes to idle, not success", () => {
        expect(
          deriveStatus({
            ...defaultInputs,
            isApprovalSuccess: true,
            actionState: "approving",
          })
        ).toBe("idle");
      });
    });
  });

  describe("isLoading derivation logic", () => {
    type ZapStatus =
      | "idle"
      | "approving"
      | "waitingApproval"
      | "zapping"
      | "waitingTx"
      | "success"
      | "error";

    function isLoading(status: ZapStatus): boolean {
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

    it("returns true for zapping", () => {
      expect(isLoading("zapping")).toBe(true);
    });

    it("returns true for waitingTx", () => {
      expect(isLoading("waitingTx")).toBe(true);
    });
  });

  describe("error derivation logic", () => {
    function parseErrorMessage(error: Error | null, defaultMsg: string): string | null {
      if (!error) return null;
      const msg = error.message || defaultMsg;
      if (msg.includes("User rejected") || msg.includes("user rejected")) {
        return "Transaction cancelled";
      }
      return msg;
    }

    function deriveError(
      approveError: Error | null,
      zapError: Error | null
    ): string | null {
      if (approveError) return parseErrorMessage(approveError, "Approval failed");
      if (zapError) return parseErrorMessage(zapError, "Zap transaction failed");
      return null;
    }

    it("returns null when no errors", () => {
      expect(deriveError(null, null)).toBeNull();
    });

    it("returns approve error message", () => {
      expect(deriveError(new Error("Approve failed"), null)).toBe("Approve failed");
    });

    it("returns zap error message", () => {
      expect(deriveError(null, new Error("Zap failed"))).toBe("Zap failed");
    });

    it("approve error takes priority", () => {
      expect(deriveError(new Error("Approve error"), new Error("Zap error"))).toBe("Approve error");
    });

    it("handles user rejection in approve", () => {
      expect(deriveError(new Error("User rejected the request"), null)).toBe(
        "Transaction cancelled"
      );
    });

    it("handles user rejection in zap", () => {
      expect(deriveError(null, new Error("user rejected transaction"))).toBe(
        "Transaction cancelled"
      );
    });

    it("returns default for approve error without message", () => {
      const error = new Error();
      error.message = "";
      expect(deriveError(error, null)).toBe("Approval failed");
    });

    it("returns default for zap error without message", () => {
      const error = new Error();
      error.message = "";
      expect(deriveError(null, error)).toBe("Zap transaction failed");
    });
  });

  describe("transaction value handling", () => {
    interface QuoteTx {
      to: string;
      data: string;
      value?: string;
    }

    function getTxValue(tx: QuoteTx): bigint {
      return BigInt(tx.value || "0");
    }

    it("returns 0 when value is undefined", () => {
      expect(getTxValue({ to: "0x123", data: "0x" })).toBe(BigInt(0));
    });

    it("returns 0 when value is empty string", () => {
      expect(getTxValue({ to: "0x123", data: "0x", value: "" })).toBe(BigInt(0));
    });

    it("returns 0 when value is '0'", () => {
      expect(getTxValue({ to: "0x123", data: "0x", value: "0" })).toBe(BigInt(0));
    });

    it("parses value string correctly", () => {
      expect(getTxValue({ to: "0x123", data: "0x", value: "1000000000000000000" })).toBe(
        BigInt("1000000000000000000")
      );
    });

    it("handles large values", () => {
      const largeValue = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
      expect(getTxValue({ to: "0x123", data: "0x", value: largeValue })).toBe(BigInt(largeValue));
    });
  });
});
