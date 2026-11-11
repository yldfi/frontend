import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import {
  requiresZeroFirstApproval,
  shouldResetApprovalToZeroFirst,
} from "@/lib/approval-reset";

const CRV = "0xD533a949740bb3306d119CC777fa900bA034cd52";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const OWNER = "0x1234567890123456789012345678901234567890" as `0x${string}`;
const SPENDER = "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf" as `0x${string}`;

function fakeClient(readContract: ReturnType<typeof vi.fn>): PublicClient {
  return { readContract } as unknown as PublicClient;
}

describe("requiresZeroFirstApproval", () => {
  it("matches CRV and USDT in checksummed and lowercase form", () => {
    expect(requiresZeroFirstApproval(CRV)).toBe(true);
    expect(requiresZeroFirstApproval(CRV.toLowerCase())).toBe(true);
    expect(requiresZeroFirstApproval(USDT)).toBe(true);
    expect(requiresZeroFirstApproval(USDT.toLowerCase())).toBe(true);
  });

  it("does not match undefined or USDC", () => {
    expect(requiresZeroFirstApproval(undefined)).toBe(false);
    expect(requiresZeroFirstApproval(USDC)).toBe(false);
  });
});

describe("shouldResetApprovalToZeroFirst", () => {
  it("returns false for a zero amount without reading the allowance", async () => {
    const readContract = vi.fn();
    const result = await shouldResetApprovalToZeroFirst({
      publicClient: fakeClient(readContract),
      owner: OWNER,
      token: USDT,
      spender: SPENDER,
      amount: 0n,
    });

    expect(result).toBe(false);
    expect(readContract).not.toHaveBeenCalled();
  });

  it("returns false for a token that does not need a zero-first approval", async () => {
    const readContract = vi.fn();
    const result = await shouldResetApprovalToZeroFirst({
      publicClient: fakeClient(readContract),
      owner: OWNER,
      token: USDC,
      spender: SPENDER,
      amount: 1n,
      currentAllowance: 5n,
    });

    expect(result).toBe(false);
  });

  it("returns false for USDT when the current allowance is zero", async () => {
    const readContract = vi.fn();
    const result = await shouldResetApprovalToZeroFirst({
      publicClient: fakeClient(readContract),
      owner: OWNER,
      token: USDT,
      spender: SPENDER,
      amount: 1n,
      currentAllowance: 0n,
    });

    expect(result).toBe(false);
    expect(readContract).not.toHaveBeenCalled();
  });

  it("returns true for USDT when the current allowance is nonzero", async () => {
    const result = await shouldResetApprovalToZeroFirst({
      token: USDT,
      spender: SPENDER,
      amount: 1n,
      currentAllowance: 1n,
    });

    expect(result).toBe(true);
  });

  it("reads a zero allowance from the client and skips the reset", async () => {
    const readContract = vi.fn().mockResolvedValue(0n);
    const result = await shouldResetApprovalToZeroFirst({
      publicClient: fakeClient(readContract),
      owner: OWNER,
      token: USDT,
      spender: SPENDER,
      amount: 1n,
    });

    expect(result).toBe(false);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "allowance",
        args: [OWNER, SPENDER],
      })
    );
  });

  it("reads a nonzero allowance from the client and resets first", async () => {
    const readContract = vi.fn().mockResolvedValue(7n);
    const result = await shouldResetApprovalToZeroFirst({
      publicClient: fakeClient(readContract),
      owner: OWNER,
      token: USDT,
      spender: SPENDER,
      amount: 1n,
    });

    expect(result).toBe(true);
  });

  it("prefers the reset path when the allowance read fails", async () => {
    const readContract = vi.fn().mockRejectedValue(new Error("rpc unavailable"));
    const result = await shouldResetApprovalToZeroFirst({
      publicClient: fakeClient(readContract),
      owner: OWNER,
      token: USDT,
      spender: SPENDER,
      amount: 1n,
    });

    expect(result).toBe(true);
  });

  it("resets first when there is no client to read the allowance from", async () => {
    const result = await shouldResetApprovalToZeroFirst({
      token: USDT,
      spender: SPENDER,
      amount: 1n,
    });

    expect(result).toBe(true);
  });

  it("resets first when the client is given but no owner is", async () => {
    const readContract = vi.fn();
    const result = await shouldResetApprovalToZeroFirst({
      publicClient: fakeClient(readContract),
      token: USDT,
      spender: SPENDER,
      amount: 1n,
    });

    expect(result).toBe(true);
    expect(readContract).not.toHaveBeenCalled();
  });
});
