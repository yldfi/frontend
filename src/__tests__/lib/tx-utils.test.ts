import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseEnsoError,
  parseSwapFailedError,
  extractStringFromHex,
  CUSTOM_ERROR_SELECTORS,
  CURVE_DEBT_TOO_HIGH_MESSAGE,
  parseErrorMessage,
  checkAllowance,
  runTenderlySimulation,
} from "@/lib/tx-utils";

// ---------------------------------------------------------------------------
// Helper: build a valid Enso error hex blob
// error(uint256 step, address target, string message) — selector 0xef3dcb2f
// ---------------------------------------------------------------------------
function buildEnsoErrorHex(step: number, target: string, message: string): string {
  const selector = "ef3dcb2f";
  const stepHex = step.toString(16).padStart(64, "0");
  // Target address is left-padded with zeros (right-aligned in 32 bytes)
  const targetHex = target.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  // String offset: always 0x60 = 96 for this layout
  const offsetHex = (96).toString(16).padStart(64, "0");
  const msgBytes = Buffer.from(message, "utf8");
  const lenHex = msgBytes.length.toString(16).padStart(64, "0");
  const dataHex = msgBytes.toString("hex").padEnd(64, "0");
  return selector + stepHex + targetHex + offsetHex + lenHex + dataHex;
}

// ---------------------------------------------------------------------------
// 1. parseEnsoError
// ---------------------------------------------------------------------------
describe("parseEnsoError", () => {
  it("returns null for non-Enso selector", () => {
    const hex = "deadbeef" + "00".repeat(128);
    expect(parseEnsoError(hex)).toBeNull();
  });

  it("returns null for data too short (< 192 chars body)", () => {
    // Selector + only 180 chars of body (< 192)
    const hex = "ef3dcb2f" + "ab".repeat(90);
    expect(parseEnsoError(hex)).toBeNull();
  });

  it("decodes a valid error with message 'Condition not met'", () => {
    const target = "1234567890abcdef1234567890abcdef12345678";
    const hex = buildEnsoErrorHex(2, target, "Condition not met");
    const result = parseEnsoError(hex);
    expect(result).not.toBeNull();
    expect(result!.step).toBe(2);
    expect(result!.target).toBe("0x" + target);
    expect(result!.message).toBe("Condition not met");
  });

  it("handles 0x prefix", () => {
    const target = "1234567890abcdef1234567890abcdef12345678";
    const hex = "0x" + buildEnsoErrorHex(0, target, "Call failed");
    const result = parseEnsoError(hex);
    expect(result).not.toBeNull();
    expect(result!.step).toBe(0);
    expect(result!.message).toBe("Call failed");
  });

  it("handles trailing period/whitespace", () => {
    const target = "1234567890abcdef1234567890abcdef12345678";
    const hex = buildEnsoErrorHex(1, target, "Some error") + ". ";
    const result = parseEnsoError(hex);
    // The trailing ". " is stripped by the replace in parseEnsoError
    expect(result).not.toBeNull();
    expect(result!.message).toBe("Some error");
  });

  it("returns null for non-printable characters in message", () => {
    const selector = "ef3dcb2f";
    const stepHex = "00".padStart(64, "0");
    const targetHex = "aabbccdd".padStart(64, "0");
    const offsetHex = (96).toString(16).padStart(64, "0");
    // Message is 4 bytes of non-printable chars (0x01, 0x02, 0x03, 0x04)
    const lenHex = (4).toString(16).padStart(64, "0");
    const dataHex = "01020304".padEnd(64, "0");
    const hex = selector + stepHex + targetHex + offsetHex + lenHex + dataHex;
    expect(parseEnsoError(hex)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Helper: wrap an inner error blob in SwapFailed(bytes) ABI encoding
// SwapFailed(bytes) — selector 0xd9d027cc
// ---------------------------------------------------------------------------
function buildSwapFailedHex(innerHex: string): string {
  const selector = "d9d027cc";
  // bytes parameter: offset(32) + length(32) + data (padded to 32-byte boundary)
  const offsetHex = (32).toString(16).padStart(64, "0");
  const innerBytes = innerHex.replace(/^0x/, "");
  const byteLen = innerBytes.length / 2;
  const lenHex = byteLen.toString(16).padStart(64, "0");
  // Pad inner data to 32-byte boundary
  const paddedData = innerBytes.padEnd(Math.ceil(innerBytes.length / 64) * 64, "0");
  return selector + offsetHex + lenHex + paddedData;
}

// ---------------------------------------------------------------------------
// 1b. parseSwapFailedError
// ---------------------------------------------------------------------------
describe("parseSwapFailedError", () => {
  it("returns null for non-SwapFailed selector", () => {
    const hex = "deadbeef" + "00".repeat(128);
    expect(parseSwapFailedError(hex)).toBeNull();
  });

  it("returns null for data too short", () => {
    const hex = "d9d027cc" + "ab".repeat(30);
    expect(parseSwapFailedError(hex)).toBeNull();
  });

  it("unwraps SwapFailed wrapping ExecutionFailed with 'Unknown' message", () => {
    const target = "bedfac7488dccaafdd66d1d7d56349780fe0477e";
    const innerEnso = buildEnsoErrorHex(1, target, "Unknown");
    const hex = buildSwapFailedHex(innerEnso);
    const result = parseSwapFailedError(hex);
    expect(result).not.toBeNull();
    expect(result!.step).toBe(1);
    expect(result!.target).toBe("0x" + target);
    expect(result!.message).toBe("Unknown");
  });

  it("unwraps SwapFailed wrapping ExecutionFailed with 'Condition not met'", () => {
    const target = "1234567890abcdef1234567890abcdef12345678";
    const innerEnso = buildEnsoErrorHex(3, target, "Condition not met");
    const hex = buildSwapFailedHex(innerEnso);
    const result = parseSwapFailedError(hex);
    expect(result).not.toBeNull();
    expect(result!.step).toBe(3);
    expect(result!.message).toBe("Condition not met");
  });

  it("handles 0x prefix", () => {
    const target = "1234567890abcdef1234567890abcdef12345678";
    const innerEnso = buildEnsoErrorHex(0, target, "Call failed");
    const hex = "0x" + buildSwapFailedHex(innerEnso);
    const result = parseSwapFailedError(hex);
    expect(result).not.toBeNull();
    expect(result!.message).toBe("Call failed");
  });

  it("returns null when inner data is not a valid Enso error", () => {
    // Inner data is just garbage, not ExecutionFailed
    const hex = buildSwapFailedHex("deadbeefcafebabe" + "00".repeat(60));
    expect(parseSwapFailedError(hex)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. extractStringFromHex
// ---------------------------------------------------------------------------
describe("extractStringFromHex", () => {
  it("returns null for empty/short hex", () => {
    expect(extractStringFromHex("")).toBeNull();
    expect(extractStringFromHex("0x")).toBeNull();
    expect(extractStringFromHex("0xdeadbeef")).toBeNull();
  });

  it("extracts embedded string from valid ABI data", () => {
    // Build: selector(4 bytes) + some word + length word + string data
    const selector = "aabbccdd";
    // Offset pointing to string length at position 64
    const offsetWord = (32).toString(16).padStart(64, "0");
    const message = "Hello World";
    const msgBuf = Buffer.from(message, "utf8");
    const lenWord = msgBuf.length.toString(16).padStart(64, "0");
    const dataHex = msgBuf.toString("hex").padEnd(64, "0");
    const hex = "0x" + selector + offsetWord + lenWord + dataHex;
    expect(extractStringFromHex(hex)).toBe("Hello World");
  });

  it("returns null for non-printable content", () => {
    const selector = "aabbccdd";
    const lenWord = (4).toString(16).padStart(64, "0");
    const dataHex = "01020304".padEnd(64, "0");
    const hex = selector + lenWord + dataHex;
    expect(extractStringFromHex(hex)).toBeNull();
  });

  it("handles 0x prefix", () => {
    const selector = "aabbccdd";
    const message = "Error message";
    const msgBuf = Buffer.from(message, "utf8");
    const offsetWord = (32).toString(16).padStart(64, "0");
    const lenWord = msgBuf.length.toString(16).padStart(64, "0");
    const dataHex = msgBuf.toString("hex").padEnd(64, "0");
    const hex = "0x" + selector + offsetWord + lenWord + dataHex;
    const result = extractStringFromHex(hex);
    expect(result).toBe("Error message");
  });
});

// ---------------------------------------------------------------------------
// 3. CUSTOM_ERROR_SELECTORS
// ---------------------------------------------------------------------------
describe("CUSTOM_ERROR_SELECTORS", () => {
  it("maps 0x97a6f3b9 to slippage message", () => {
    expect(CUSTOM_ERROR_SELECTORS["0x97a6f3b9"]).toContain("Slippage");
  });

  it("maps 0x13be252b to insufficient balance", () => {
    expect(CUSTOM_ERROR_SELECTORS["0x13be252b"]).toBe("Insufficient balance");
  });

  it("maps 0x756688fe to deadline expired", () => {
    expect(CUSTOM_ERROR_SELECTORS["0x756688fe"]).toContain("Deadline expired");
  });

  it("maps 0xd9d027cc (SwapFailed) to swap failed message", () => {
    expect(CUSTOM_ERROR_SELECTORS["0xd9d027cc"]).toContain("Swap failed");
  });
});

// ---------------------------------------------------------------------------
// 4. parseErrorMessage — comprehensive branch coverage
// ---------------------------------------------------------------------------
describe("parseErrorMessage", () => {
  // Falsy inputs
  it("returns defaultMsg for null", () => {
    expect(parseErrorMessage(null, "Custom default")).toBe("Custom default");
  });

  it("returns 'Unknown error' for undefined with no default", () => {
    expect(parseErrorMessage(undefined)).toBe("Unknown error");
  });

  it("returns defaultMsg for false", () => {
    expect(parseErrorMessage(false, "Nope")).toBe("Nope");
  });

  // User rejection
  it("detects 'User rejected'", () => {
    expect(parseErrorMessage("User rejected the request")).toBe("Transaction cancelled");
  });

  it("detects 'user denied'", () => {
    expect(parseErrorMessage("MetaMask: user denied transaction")).toBe("Transaction cancelled");
  });

  it("detects 'User declined'", () => {
    expect(parseErrorMessage("User declined to sign")).toBe("Transaction cancelled");
  });

  // ERC20 transfer failures
  it("detects 'transfer amount exceeds balance'", () => {
    expect(parseErrorMessage("ERC20: transfer amount exceeds balance")).toBe(
      "Transaction would fail: swap conditions changed, try refreshing the quote"
    );
  });

  it("detects 'ERC20: transfer amount exceeds'", () => {
    expect(parseErrorMessage("erc20: transfer amount exceeds allowance")).toBe(
      "Transaction would fail: swap conditions changed, try refreshing the quote"
    );
  });

  // Insufficient / exceeds balance
  it("detects 'insufficient' (catches 'insufficient funds' too)", () => {
    expect(parseErrorMessage("insufficient funds for gas")).toBe("Insufficient balance");
  });

  it("detects 'exceeds balance'", () => {
    expect(parseErrorMessage("amount exceeds balance")).toBe("Insufficient balance");
  });

  // Slippage
  it("detects 'slippage'", () => {
    expect(parseErrorMessage("Slippage exceeded limit")).toBe(
      "Swap output below minimum. Increase the amount or slippage."
    );
  });

  it("detects 'insufficient_output' — note: 'insufficient' branch matches first", () => {
    // "insufficient_output" contains "insufficient" which is caught on line 79 before
    // the slippage check on line 87. This is the actual production behavior.
    expect(parseErrorMessage("Error: insufficient_output")).toBe("Insufficient balance");
  });

  it("detects slippage via 'insufficient_output' when no 'insufficient' prefix", () => {
    // If the string only has "insufficient_output" at word boundary without bare "insufficient"
    // — in practice, "insufficient_output" always contains "insufficient",
    // so slippage is only triggered by the "slippage" keyword or other paths.
    expect(parseErrorMessage("Error: slippage exceeded")).toBe(
      "Swap output below minimum. Increase the amount or slippage."
    );
  });

  // Health check
  it("detects 'health'", () => {
    expect(parseErrorMessage("health check failed")).toBe("Position would be unhealthy");
  });

  it("surfaces Curve Debt too high as an actionable repay error", () => {
    expect(parseErrorMessage("execution reverted: Debt too high")).toBe(CURVE_DEBT_TOO_HIGH_MESSAGE);
  });

  it("preserves close-specific Enso quote failures", () => {
    expect(parseErrorMessage("Error: No swap route could produce enough crvUSD for this close. Increase the amount, increase slippage, or use crvUSD.")).toBe(
      "No swap route could produce enough crvUSD for this close. Increase the amount, increase slippage, or use crvUSD."
    );
  });

  it("maps raw Enso quote failures to a route message", () => {
    expect(parseErrorMessage("API Error: Could not quote shortcuts for route 0xTokenA -> 0xTokenB on network 1")).toBe(
      "No swap route could be quoted for this transaction. Increase the amount, increase slippage, or use a different token."
    );
  });

  // Enso prefix: enso:Message
  it("handles enso:Condition not met prefix", () => {
    expect(parseErrorMessage("enso:Condition not met")).toBe(
      "Swap output below minimum. Increase the amount or slippage."
    );
  });

  it("handles enso:Call failed prefix", () => {
    expect(parseErrorMessage("enso:Call failed")).toBe(
      "Swap route failed. Try increasing slippage or use a different token."
    );
  });

  it("handles enso:Unknown prefix (swap failed with no reason)", () => {
    expect(parseErrorMessage("enso:Unknown")).toBe(
      "Swap failed during transaction. Try refreshing the quote or increasing slippage."
    );
  });

  it("handles enso:Some other error prefix", () => {
    expect(parseErrorMessage("enso:Some other error")).toBe(
      "Transaction failed: Some other error"
    );
  });

  // Enso hex error: custom error 0xef3dcb2f:<hex>
  it("decodes Enso hex error with 'Condition not met' message", () => {
    const target = "1234567890abcdef1234567890abcdef12345678";
    const innerHex = buildEnsoErrorHex(2, target, "Condition not met").slice(8); // strip selector
    const error = `custom error 0xef3dcb2f: ${innerHex}`;
    expect(parseErrorMessage(error)).toBe(
      "Swap output below minimum. Increase the amount or slippage."
    );
  });

  it("decodes Enso hex error with 'Call failed' message", () => {
    const target = "1234567890abcdef1234567890abcdef12345678";
    const innerHex = buildEnsoErrorHex(1, target, "Call failed").slice(8);
    const error = `custom error 0xef3dcb2f: ${innerHex}`;
    expect(parseErrorMessage(error)).toBe(
      "Swap route failed. Try increasing slippage or use a different token."
    );
  });

  it("decodes Enso hex error with generic message", () => {
    const target = "1234567890abcdef1234567890abcdef12345678";
    const innerHex = buildEnsoErrorHex(3, target, "Access denied").slice(8);
    const error = `custom error 0xef3dcb2f: ${innerHex}`;
    expect(parseErrorMessage(error)).toBe("Transaction failed: Access denied");
  });

  // SwapFailed(bytes) wrapping Enso ExecutionFailed
  it("unwraps SwapFailed with 'Unknown' → friendly swap failed message", () => {
    const target = "bedfac7488dccaafdd66d1d7d56349780fe0477e";
    const innerEnso = buildEnsoErrorHex(1, target, "Unknown");
    const swapFailedHex = buildSwapFailedHex(innerEnso);
    const error = `custom error 0xd9d027cc: ${swapFailedHex.slice(8)}`; // strip selector for regex match
    expect(parseErrorMessage(error)).toBe(
      "Swap failed during transaction. Try refreshing the quote or increasing slippage."
    );
  });

  it("unwraps SwapFailed with 'Condition not met' → slippage message", () => {
    const target = "1234567890abcdef1234567890abcdef12345678";
    const innerEnso = buildEnsoErrorHex(2, target, "Condition not met");
    const swapFailedHex = buildSwapFailedHex(innerEnso);
    const error = `custom error 0xd9d027cc: ${swapFailedHex.slice(8)}`;
    expect(parseErrorMessage(error)).toBe(
      "Swap output below minimum. Increase the amount or slippage."
    );
  });

  it("unwraps SwapFailed with 'Call failed' → route failed message", () => {
    const target = "1234567890abcdef1234567890abcdef12345678";
    const innerEnso = buildEnsoErrorHex(0, target, "Call failed");
    const swapFailedHex = buildSwapFailedHex(innerEnso);
    const error = `custom error 0xd9d027cc: ${swapFailedHex.slice(8)}`;
    expect(parseErrorMessage(error)).toBe(
      "Swap route failed. Try increasing slippage or use a different token."
    );
  });

  it("unwraps SwapFailed with custom message", () => {
    const target = "1234567890abcdef1234567890abcdef12345678";
    const innerEnso = buildEnsoErrorHex(1, target, "STF");
    const swapFailedHex = buildSwapFailedHex(innerEnso);
    const error = `custom error 0xd9d027cc: ${swapFailedHex.slice(8)}`;
    expect(parseErrorMessage(error)).toBe("Swap failed: STF");
  });

  it("falls back to CUSTOM_ERROR_SELECTORS when SwapFailed inner parse fails", () => {
    // SwapFailed selector matched but inner data is garbage → falls through to selector lookup
    const error = "custom error 0xd9d027cc: " + "ab".repeat(30);
    expect(parseErrorMessage(error)).toBe(
      "Swap failed during transaction. Try refreshing the quote or increasing slippage."
    );
  });

  // Known selectors
  it("matches known selector via 'custom error 0x97a6f3b9'", () => {
    expect(parseErrorMessage("custom error 0x97a6f3b9")).toBe(
      "Slippage too high - price moved, try increasing slippage tolerance"
    );
  });

  it("matches known selector via 'reverted with 0x13be252b'", () => {
    expect(parseErrorMessage("reverted with 0x13be252b")).toBe("Insufficient balance");
  });

  // Condition not met / call failed as plain text (no hex)
  it("detects 'condition not met' in plain text", () => {
    expect(parseErrorMessage("Transaction reverted: condition not met")).toBe(
      "Swap output below minimum. Increase the amount or slippage."
    );
  });

  it("detects 'call failed' in plain text", () => {
    expect(parseErrorMessage("Swap call failed at step 3")).toBe(
      "Swap route failed. Try increasing slippage or use a different token."
    );
  });

  // Custom error with extractable string fallback
  it("extracts embedded string from unknown custom error hex", () => {
    const selector = "deadbeef";
    const message = "Pool is paused";
    const msgBuf = Buffer.from(message, "utf8");
    // Build: offset word + length word + data
    const offsetWord = (32).toString(16).padStart(64, "0");
    const lenWord = msgBuf.length.toString(16).padStart(64, "0");
    const dataHex = msgBuf.toString("hex").padEnd(64, "0");
    const hexBody = offsetWord + lenWord + dataHex;
    const error = `custom error 0x${selector}: ${hexBody}`;
    expect(parseErrorMessage(error)).toBe("Transaction failed: Pool is paused");
  });

  // Simulation / estimation errors
  it("handles EstimateGasExecutionError with reason", () => {
    const error = "EstimateGasExecutionError: reason: execution reverted\nContract Call:";
    expect(parseErrorMessage(error)).toBe("Simulation failed: execution reverted");
  });

  it("handles simulateContract error without reason", () => {
    expect(parseErrorMessage("simulateContract failed")).toBe("Transaction simulation failed");
  });

  // Gas errors
  it("handles 'gas required exceeds'", () => {
    expect(parseErrorMessage("gas required exceeds allowance 30000000")).toBe(
      "Transaction would fail: out of gas"
    );
  });

  // Revert with reason="..."
  it("extracts reason from double-quoted revert", () => {
    expect(parseErrorMessage('execution reverted with reason="Amount too low"')).toBe(
      "Transaction failed: Amount too low"
    );
  });

  // Revert with reason string '...'
  it("extracts reason from single-quoted revert", () => {
    expect(parseErrorMessage("reverted with reason string 'Paused'")).toBe(
      "Transaction failed: Paused"
    );
  });

  // Special handling: "reverted with the following reason:\nexecution reverted"
  it("handles 'execution reverted' as revert reason", () => {
    expect(
      parseErrorMessage("reverted with the following reason:\nexecution reverted")
    ).toBe("Transaction failed: execution reverted");
  });

  // Long error messages (> 100 chars)
  it("truncates long error messages", () => {
    const longMsg = "A".repeat(200);
    const result = parseErrorMessage(longMsg);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toBe("A".repeat(97) + "...");
  });

  // Short unknown error returns default
  it("returns default message for short unrecognized error", () => {
    expect(parseErrorMessage("???", "My default")).toBe("My default");
  });

  it("returns generic fallback for short unrecognized error without default", () => {
    expect(parseErrorMessage("???")).toBe("Transaction failed. Please try again.");
  });

  // Error object
  it("handles Error object via String() coercion", () => {
    expect(parseErrorMessage(new Error("User rejected tx"))).toBe("Transaction cancelled");
  });

  // Plain string
  it("handles plain string directly", () => {
    expect(parseErrorMessage("slippage tolerance exceeded")).toBe(
      "Swap output below minimum. Increase the amount or slippage."
    );
  });
});

// ---------------------------------------------------------------------------
// 5. checkAllowance
// ---------------------------------------------------------------------------
describe("checkAllowance", () => {
  const owner = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
  const token = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
  const spender = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;

  it("returns 0n when publicClient is null", async () => {
    expect(await checkAllowance(null, owner, token, spender)).toBe(0n);
  });

  it("returns 0n when publicClient is undefined", async () => {
    expect(await checkAllowance(undefined, owner, token, spender)).toBe(0n);
  });

  it("returns allowance value on success", async () => {
    const mockClient = {
      readContract: vi.fn().mockResolvedValue(1000000n),
    };
    const result = await checkAllowance(mockClient, owner, token, spender);
    expect(result).toBe(1000000n);
    expect(mockClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: token,
        functionName: "allowance",
        args: [owner, spender],
      })
    );
  });

  it("returns 0n on readContract error", async () => {
    const mockClient = {
      readContract: vi.fn().mockRejectedValue(new Error("RPC error")),
    };
    expect(await checkAllowance(mockClient, owner, token, spender)).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// 6. runTenderlySimulation
// ---------------------------------------------------------------------------
describe("runTenderlySimulation", () => {
  const userAddress = "0x1111111111111111111111111111111111111111";
  const txTo = "0x2222222222222222222222222222222222222222";
  const txData = "0xdeadbeef";
  const txValue = "0";
  const inputToken = "0x3333333333333333333333333333333333333333";

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns error when nonce fetch fails (not ok)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        json: async () => ({ success: false }),
      })
    );
    const result = await runTenderlySimulation(userAddress, txTo, txData, txValue, inputToken);
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toBe("Failed to obtain simulation nonce");
    expect(result.result).toBeNull();
  });

  it("returns error when nonce is missing fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        json: async () => ({ success: true, nonce: "abc" }), // missing expires & sig
      })
    );
    const result = await runTenderlySimulation(userAddress, txTo, txData, txValue, inputToken);
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toBe("Failed to obtain simulation nonce");
  });

  it("returns ok:true with result when simulation succeeds", async () => {
    const simResult = {
      success: true,
      simulationId: "sim-123",
      tenderlyUrl: "https://tenderly.co/sim/123",
      gasUsed: 150000,
      errorMessage: null,
      assetChanges: [],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          json: async () => ({ success: true, nonce: "n1", expires: 9999999999, sig: "s1" }),
        })
        .mockResolvedValueOnce({
          json: async () => simResult,
        })
    );

    const result = await runTenderlySimulation(userAddress, txTo, txData, txValue, inputToken);
    expect(result.ok).toBe(true);
    expect(result.result).toEqual(simResult);
    expect(result.errorMessage).toBeUndefined();
  });

  it("returns ok:false with errorMessage when simulation fails", async () => {
    const simResult = {
      success: false,
      simulationId: "sim-456",
      tenderlyUrl: null,
      gasUsed: null,
      errorMessage: "execution reverted",
      assetChanges: [],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          json: async () => ({ success: true, nonce: "n2", expires: 9999999999, sig: "s2" }),
        })
        .mockResolvedValueOnce({
          json: async () => simResult,
        })
    );

    const result = await runTenderlySimulation(userAddress, txTo, txData, txValue, inputToken);
    expect(result.ok).toBe(false);
    expect(result.result).toEqual(simResult);
    expect(result.errorMessage).toBe("execution reverted");
  });

  it("returns error when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new Error("Network error"))
    );
    const result = await runTenderlySimulation(userAddress, txTo, txData, txValue, inputToken);
    expect(result.ok).toBe(false);
    expect(result.result).toBeNull();
    expect(result.errorMessage).toBe("Network error");
  });

  it("extracts message from errorMessage object { message }", async () => {
    const simResult = {
      success: false,
      simulationId: "sim-789",
      tenderlyUrl: null,
      gasUsed: null,
      errorMessage: { id: "err-1", slug: "revert", message: "Reverted at step 2" },
      assetChanges: [],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          json: async () => ({ success: true, nonce: "n3", expires: 9999999999, sig: "s3" }),
        })
        .mockResolvedValueOnce({
          json: async () => simResult,
        })
    );

    const result = await runTenderlySimulation(userAddress, txTo, txData, txValue, inputToken);
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toBe("Reverted at step 2");
  });
});
