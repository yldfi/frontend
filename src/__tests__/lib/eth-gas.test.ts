import { describe, it, expect } from "vitest";
import { getMaxEthAmount } from "@/lib/eth-gas";
import { parseEther, parseGwei } from "viem";

describe("getMaxEthAmount", () => {
  // ── No gas price (undefined) → flat 0.01 ETH reserve ──

  it("subtracts 0.01 ETH reserve when gasPrice is undefined", () => {
    const balance = parseEther("1"); // 1 ETH
    const result = getMaxEthAmount(balance, undefined);
    expect(result).toBe("0.99");
  });

  it("returns '0' when balance is below the 0.01 ETH reserve", () => {
    const balance = parseEther("0.005");
    const result = getMaxEthAmount(balance, undefined);
    expect(result).toBe("0");
  });

  it("returns '0' when balance equals the 0.01 ETH reserve exactly", () => {
    const balance = parseEther("0.01");
    const result = getMaxEthAmount(balance, undefined);
    expect(result).toBe("0");
  });

  // ── With gas price, default gas estimate (300_000) ──

  it("subtracts buffered gas cost with default gas estimate", () => {
    // gasCost = 300_000 * 30 gwei * 1.5 = 13,500,000,000,000,000 = 0.0135 ETH
    const balance = parseEther("1");
    const gasPrice = parseGwei("30");
    const result = getMaxEthAmount(balance, gasPrice);
    expect(result).toBe("0.9865");
  });

  // ── With gas price and custom gas estimate ──

  it("uses custom gas estimate when provided", () => {
    // gasCost = 500_000 * 50 gwei * 1.5 = 37,500,000,000,000,000 = 0.0375 ETH
    const balance = parseEther("1");
    const gasPrice = parseGwei("50");
    const gasEstimate = 500_000n;
    const result = getMaxEthAmount(balance, gasPrice, gasEstimate);
    expect(result).toBe("0.9625");
  });

  // ── Edge cases ──

  it("returns '0' when balance is less than gas cost", () => {
    const balance = parseEther("0.001");
    const gasPrice = parseGwei("30"); // gasCost = 0.0135 ETH
    const result = getMaxEthAmount(balance, gasPrice);
    expect(result).toBe("0");
  });

  it("returns '0' when balance equals gas cost exactly", () => {
    // gasCost = 300_000 * 30 gwei * 1.5 = 13,500,000,000,000,000
    const balance = 13_500_000_000_000_000n;
    const gasPrice = parseGwei("30");
    const result = getMaxEthAmount(balance, gasPrice);
    expect(result).toBe("0");
  });

  it("handles very large balance correctly", () => {
    // gasCost = 300_000 * 30 gwei * 1.5 = 0.0135 ETH
    const balance = parseEther("100");
    const gasPrice = parseGwei("30");
    const result = getMaxEthAmount(balance, gasPrice);
    expect(result).toBe("99.9865");
  });

  it("returns '0' for zero balance", () => {
    const result = getMaxEthAmount(0n, parseGwei("30"));
    expect(result).toBe("0");
  });

  it("treats gasPrice 0n as falsy and falls back to flat reserve", () => {
    // 0n is falsy in JS, so !gasPrice is true — uses 0.01 ETH reserve path
    const balance = parseEther("1");
    const result = getMaxEthAmount(balance, 0n);
    expect(result).toBe("0.99");
  });
});
