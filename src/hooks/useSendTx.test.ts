import { describe, expect, it } from "vitest";
import { isRecoverableFlashbotsSigningError } from "./useSendTx";

describe("isRecoverableFlashbotsSigningError", () => {
  it("recovers when a wallet does not support eth_signTransaction", () => {
    expect(isRecoverableFlashbotsSigningError(
      new Error("Method eth_signTransaction is not supported")
    )).toBe(true);
  });

  it("recovers from missing fee field signing errors", () => {
    expect(isRecoverableFlashbotsSigningError(
      new Error("missing gasPrice or maxFeePerGas/maxPriorityFeePerGas")
    )).toBe(true);
  });

  it("does not recover unrelated transaction failures", () => {
    expect(isRecoverableFlashbotsSigningError(new Error("execution reverted"))).toBe(false);
  });
});
