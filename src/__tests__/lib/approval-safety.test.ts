import { describe, expect, it } from "vitest";
import {
  ENSO_SHORTCUTS_ADDRESS,
  FORBIDDEN_APPROVAL_SPENDER_ERROR,
  assertSafeApprovalSpender,
  findForbiddenApproval,
  isForbiddenApprovalSpender,
} from "@/lib/approval-safety";

const ENSO_ROUTER_V2 = "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf";
const CURVE_CONTROLLER = "0x24174143cCF438f0A1F6dCF93B468C127123A96E";

describe("approval safety", () => {
  it("allows Enso Router V2 approvals", () => {
    expect(isForbiddenApprovalSpender(ENSO_ROUTER_V2)).toBe(false);
    expect(() => assertSafeApprovalSpender(ENSO_ROUTER_V2)).not.toThrow();
  });

  it("allows protocol-specific spenders", () => {
    expect(isForbiddenApprovalSpender(CURVE_CONTROLLER)).toBe(false);
    expect(() => assertSafeApprovalSpender(CURVE_CONTROLLER)).not.toThrow();
  });

  it("blocks Enso Shortcuts approvals case-insensitively", () => {
    expect(isForbiddenApprovalSpender(ENSO_SHORTCUTS_ADDRESS.toLowerCase())).toBe(true);
    expect(() => assertSafeApprovalSpender(ENSO_SHORTCUTS_ADDRESS.toLowerCase()))
      .toThrow(FORBIDDEN_APPROVAL_SPENDER_ERROR);
  });

  it("finds forbidden approvals in a queue", () => {
    const approvals = [
      { spender: ENSO_ROUTER_V2, label: "router" },
      { spender: ENSO_SHORTCUTS_ADDRESS, label: "shortcuts" },
    ];

    expect(findForbiddenApproval(approvals)).toBe(approvals[1]);
  });
});
