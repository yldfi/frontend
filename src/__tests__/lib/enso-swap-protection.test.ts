import { describe, expect, it } from "vitest";
import type { EnsoBundleAction } from "@/types/enso";
import {
  assertProtectedEnsoBundleActions,
  assertSafeSlippageBps,
} from "@/lib/enso-swap-protection";

function route(args: Record<string, unknown>): EnsoBundleAction {
  return {
    protocol: "enso",
    action: "route",
    args,
  };
}

function call(method: string, args: unknown[]): EnsoBundleAction {
  return {
    protocol: "enso",
    action: "call",
    args: { method, args },
  };
}

describe("Enso swap protection", () => {
  it("accepts route actions with exactly one effective output bound", () => {
    expect(() => assertProtectedEnsoBundleActions([
      route({ slippage: "50" }),
      route({ minAmountOut: "1" }),
    ])).not.toThrow();
  });

  it("rejects route actions without an explicit output bound", () => {
    expect(() => assertProtectedEnsoBundleActions([
      route({ tokenIn: "0x1", tokenOut: "0x2", amountIn: "1" }),
    ])).toThrow("must specify exactly one of slippage or minAmountOut");
  });

  it("rejects conflicting route output bounds", () => {
    expect(() => assertProtectedEnsoBundleActions([
      route({ slippage: "50", minAmountOut: "1" }),
    ])).toThrow("must specify exactly one of slippage or minAmountOut");
  });

  it("rejects ineffective or excessive protection", () => {
    expect(() => assertProtectedEnsoBundleActions([
      route({ minAmountOut: "0" }),
    ])).toThrow("must be greater than zero");

    expect(() => assertSafeSlippageBps("5001")).toThrow(
      "must be between 0 and 5000 basis points",
    );
  });

  it("requires positive minima on raw Curve and Pirex swaps", () => {
    expect(() => assertProtectedEnsoBundleActions([
      call("exchange", ["0", "1", "100", 90n]),
      call("exchange_multiple", [[], [], "100", "90"]),
      call("swap", ["0", "100", "90", "0", "1"]),
    ])).not.toThrow();

    expect(() => assertProtectedEnsoBundleActions([
      call("exchange", ["0", "1", "100", "0"]),
    ])).toThrow("exchange minimum output must be greater than zero");
  });

  it("requires positive explicit minamountout guards", () => {
    expect(() => assertProtectedEnsoBundleActions([{
      protocol: "enso",
      action: "minamountout",
      args: { minAmountOut: "0" },
    }])).toThrow("must be greater than zero");
  });

  it("does not classify fixed-ratio calls as market swaps", () => {
    expect(() => assertProtectedEnsoBundleActions([
      call("wrap", ["100"]),
      call("withdraw", ["100"]),
    ])).not.toThrow();
  });
});
