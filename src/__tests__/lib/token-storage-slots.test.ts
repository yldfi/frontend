import { describe, expect, it } from "vitest";
import { TOKENS } from "@/config/vaults";
import { USDC_ADDRESS, WETH_ADDRESS } from "@/config/addresses";
import {
  DEFAULT_ALLOWANCE_SLOT,
  getERC20AllowanceSlot,
  TOKEN_ALLOWANCE_SLOTS,
} from "@/lib/token-storage-slots";

const CRV_ADDRESS = "0xD533a949740bb3306d119CC777fa900bA034cd52";

describe("getERC20AllowanceSlot", () => {
  it("defaults to the standard OpenZeppelin slot (1) for unknown tokens", () => {
    expect(getERC20AllowanceSlot("0x1234567890abcdef1234567890abcdef12345678")).toBe(DEFAULT_ALLOWANCE_SLOT);
  });

  it("is case-insensitive", () => {
    const mixed = `0xD533A949740BB3306d119CC777FA900BA034Cd52`;
    expect(TOKEN_ALLOWANCE_SLOTS[CRV_ADDRESS.toLowerCase()]).toBe(1);
    expect(getERC20AllowanceSlot(mixed)).toBe(getERC20AllowanceSlot(CRV_ADDRESS));
  });

  it("treats CRV as a standard OZ ERC20 (allowance @ slot 1)", () => {
    expect(getERC20AllowanceSlot(CRV_ADDRESS)).toBe(1);
  });

  it("treats CVX, cvxCRV, stkcvxCRV and pxCVX as standard (slot 1)", () => {
    expect(getERC20AllowanceSlot(TOKENS.CVX)).toBe(1);
    expect(getERC20AllowanceSlot(TOKENS.CVXCRV)).toBe(1);
    expect(getERC20AllowanceSlot(TOKENS.STKCVXCRV)).toBe(1);
    expect(getERC20AllowanceSlot(TOKENS.PXCVX)).toBe(1);
  });

  it("maps USDC to its proxy allowance slot (10)", () => {
    expect(getERC20AllowanceSlot(USDC_ADDRESS)).toBe(10);
  });

  it("maps WETH to its custom allowance slot (4)", () => {
    expect(getERC20AllowanceSlot(WETH_ADDRESS)).toBe(4);
  });

  it("maps ERC20Upgradeable tokens (cvgCVX / CVX1) to slot 52", () => {
    expect(getERC20AllowanceSlot(TOKENS.CVGCVX)).toBe(52);
    expect(getERC20AllowanceSlot(TOKENS.CVX1)).toBe(52);
  });

  it("assigns distinct slots (not all 1) so non-standard tokens aren't missed", () => {
    const slots = [USDC_ADDRESS, WETH_ADDRESS, TOKENS.CVGCVX].map((a) => getERC20AllowanceSlot(a));
    expect(new Set(slots).size).toBe(3);
    expect(slots.every((s) => s !== 1)).toBe(true);
  });
});
