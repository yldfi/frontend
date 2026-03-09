import { describe, it, expect, vi } from "vitest";

// ============================================================================
// Mock setup — only mock external dependencies that enso.ts imports at module
// level.  We do NOT mock @/lib/enso itself: the whole point of this file is
// to exercise the REAL buildHybridZapperActions implementation.
// ============================================================================

// @ensofinance/sdk — EnsoClient is instantiated at module scope
vi.mock("@ensofinance/sdk", () => ({
  EnsoClient: class MockEnsoClient {
    getTokenData = vi.fn();
    getBalances = vi.fn();
    getMultiplePriceData = vi.fn();
    getRouteData = vi.fn();
    getBundleData = vi.fn();
  },
}));

// @/lib/curve — imported by enso.ts for swap helpers
vi.mock("@/lib/curve", () => ({
  getCurveGetDy: vi.fn(),
  getCurveGetDyFactory: vi.fn(),
  getEthToCvxEstimate: vi.fn(),
  getStableSwapParams: vi.fn(),
  estimateCryptoSwapOffchain: vi.fn(),
  previewRedeem: vi.fn(),
  batchRedeemAndEstimateSwap: vi.fn(),
  findPegPoint: vi.fn(),
  calculateMinDy: vi.fn(),
  validateSlippage: vi.fn(),
  cryptoswap: vi.fn(),
  getCryptoSwapParams: vi.fn(),
}));

// @/config/rpc — getAllRpcUrls is called lazily but mock to be safe
vi.mock("@/config/rpc", () => ({
  getAllRpcUrls: vi.fn(() => ["https://eth.llamarpc.com"]),
}));

// ============================================================================
// Import the REAL function under test (after mocks are registered)
// ============================================================================

import {
  buildHybridZapperActions,
  CVX_HYBRID_ZAPPER,
  ENSO_SHORTCUTS,
} from "@/lib/enso";
import { TOKENS, VAULT_ADDRESSES } from "@/config/vaults";

// ============================================================================
// Constants (for readable assertions)
// ============================================================================

const CVX_LOWER = TOKENS.CVX.toLowerCase();
const CVGCVX_LOWER = TOKENS.CVGCVX.toLowerCase();
const PXCVX_LOWER = TOKENS.PXCVX.toLowerCase();
const ZAPPER_ADDR = CVX_HYBRID_ZAPPER;

// ============================================================================
// Shared fixture builder
// ============================================================================

function baseParams(overrides: Partial<Parameters<typeof buildHybridZapperActions>[0]> = {}) {
  return {
    type: "cvgCvx" as const,
    cvxAmountRef: "1000000000000000000",
    swapAmount: 500000000000000000n,
    minSwapDy: "490000000000000000",
    minTotalOut: "980000000000000000",
    vaultAddress: VAULT_ADDRESSES.YSCVGCVX,
    depositReceiver: "0xAbC1230000000000000000000000000000000001",
    actionsOffset: 0,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("buildHybridZapperActions (REAL implementation)", () => {
  // --------------------------------------------------------------------------
  // cvgCvx type
  // --------------------------------------------------------------------------
  describe("cvgCvx type", () => {
    it("returns exactly 5 actions", () => {
      const actions = buildHybridZapperActions(baseParams());
      expect(actions).toHaveLength(5);
    });

    it("action 0: approves CVX to CVX_HYBRID_ZAPPER with cvxAmountRef", () => {
      const ref = "2000000000000000000";
      const actions = buildHybridZapperActions(baseParams({ cvxAmountRef: ref }));
      const a0 = actions[0];

      expect(a0.protocol).toBe("enso");
      expect(a0.action).toBe("call");
      expect(a0.args.address).toBe(CVX_LOWER);
      expect(a0.args.method).toBe("approve");
      expect(a0.args.args).toEqual([ZAPPER_ADDR, ref]);
    });

    it("action 1: calls zapCvxToCvgCvxWithParams on the hybrid zapper", () => {
      const params = baseParams();
      const actions = buildHybridZapperActions(params);
      const a1 = actions[1];

      expect(a1.protocol).toBe("enso");
      expect(a1.action).toBe("call");
      expect(a1.args.address).toBe(ZAPPER_ADDR);
      expect(a1.args.method).toBe("zapCvxToCvgCvxWithParams");
      expect(a1.args.abi).toContain("zapCvxToCvgCvxWithParams");
      expect(a1.args.args).toEqual([
        params.cvxAmountRef,
        params.swapAmount.toString(),
        params.minSwapDy,
        params.minTotalOut,
        ENSO_SHORTCUTS,
        "0",
      ]);
    });

    it("action 2: balanceOf cvgCVX at ENSO_SHORTCUTS", () => {
      const actions = buildHybridZapperActions(baseParams());
      const a2 = actions[2];

      expect(a2.args.address).toBe(CVGCVX_LOWER);
      expect(a2.args.method).toBe("balanceOf");
      expect(a2.args.args).toEqual([ENSO_SHORTCUTS]);
    });

    it("actions 3-4 reference balIdx = actionsOffset + 2 via useOutputOfCallAt", () => {
      const actions = buildHybridZapperActions(baseParams({ actionsOffset: 0 }));
      const balIdx = 0 + 2; // actionsOffset + 2

      // Action 3: approve underlying -> vault
      expect(actions[3].args.args).toContainEqual({ useOutputOfCallAt: balIdx });

      // Action 4: deposit underlying -> vault
      expect(actions[4].args.args).toContainEqual({ useOutputOfCallAt: balIdx });
    });
  });

  // --------------------------------------------------------------------------
  // pxCvx type
  // --------------------------------------------------------------------------
  describe("pxCvx type", () => {
    it("action 1: calls zapCvxToPxCvxWithParams instead", () => {
      const actions = buildHybridZapperActions(
        baseParams({ type: "pxCvx", vaultAddress: VAULT_ADDRESSES.YSPXCVX })
      );
      const a1 = actions[1];

      expect(a1.args.method).toBe("zapCvxToPxCvxWithParams");
      expect(a1.args.abi).toContain("zapCvxToPxCvxWithParams");
    });

    it("actions 2-4 use pxCVX token address instead of cvgCVX", () => {
      const actions = buildHybridZapperActions(
        baseParams({ type: "pxCvx", vaultAddress: VAULT_ADDRESSES.YSPXCVX })
      );

      // action 2: balanceOf pxCVX
      expect(actions[2].args.address).toBe(PXCVX_LOWER);

      // action 3: approve pxCVX -> vault
      expect(actions[3].args.address).toBe(PXCVX_LOWER);

      // action 4: deposit on vault
      expect(actions[4].args.address).toBe(VAULT_ADDRESSES.YSPXCVX.toLowerCase());
    });
  });

  // --------------------------------------------------------------------------
  // Index math (actionsOffset)
  // --------------------------------------------------------------------------
  describe("actionsOffset index math", () => {
    it.each([
      { offset: 0, expectedBalIdx: 2 },
      { offset: 5, expectedBalIdx: 7 },
      { offset: 10, expectedBalIdx: 12 },
    ])(
      "actionsOffset=$offset => balIdx=$expectedBalIdx",
      ({ offset, expectedBalIdx }) => {
        const actions = buildHybridZapperActions(
          baseParams({ actionsOffset: offset })
        );

        // Action 3 (approve): second arg is { useOutputOfCallAt: balIdx }
        const approveArgs = actions[3].args.args as unknown[];
        expect(approveArgs).toContainEqual({ useOutputOfCallAt: expectedBalIdx });

        // Action 4 (deposit): first arg is { useOutputOfCallAt: balIdx }
        const depositArgs = actions[4].args.args as unknown[];
        expect(depositArgs).toContainEqual({ useOutputOfCallAt: expectedBalIdx });
      }
    );
  });

  // --------------------------------------------------------------------------
  // All addresses are lowercased
  // --------------------------------------------------------------------------
  describe("address casing", () => {
    it("token and vault address fields are lowercase", () => {
      const actions = buildHybridZapperActions(baseParams());

      // Action 0: CVX address (token) — lowercased
      expect(actions[0].args.address).toBe(CVX_LOWER);

      // Action 2: cvgCVX address (token) — lowercased
      expect(actions[2].args.address).toBe(CVGCVX_LOWER);

      // Action 3: cvgCVX address (token) — lowercased
      expect(actions[3].args.address).toBe(CVGCVX_LOWER);

      // Action 4: vault address — lowercased
      expect(actions[4].args.address).toBe(VAULT_ADDRESSES.YSCVGCVX.toLowerCase());
    });

    it("CVX_HYBRID_ZAPPER address is used as-is for the zap call", () => {
      // The zapper address comes from env/default and is not lowercased
      // by the function (unlike token addresses). This documents the actual
      // behavior — Enso bundle builder handles address normalization.
      const actions = buildHybridZapperActions(baseParams());
      expect(actions[1].args.address).toBe(ZAPPER_ADDR);
    });

    it("vault address in approve and deposit actions is lowercased", () => {
      // Use a checksummed vault address to confirm the function lowercases it
      const actions = buildHybridZapperActions(
        baseParams({ vaultAddress: VAULT_ADDRESSES.YSCVGCVX })
      );

      // action 3: approve underlying -> vault — spender arg
      const approveArgs = actions[3].args.args as string[];
      const spender = approveArgs[0];
      expect(spender).toBe(VAULT_ADDRESSES.YSCVGCVX.toLowerCase());

      // action 4: deposit address
      expect(actions[4].args.address).toBe(VAULT_ADDRESSES.YSCVGCVX.toLowerCase());
    });
  });

  // --------------------------------------------------------------------------
  // Security: no ENSO_SHORTCUTS as approve spender
  // --------------------------------------------------------------------------
  describe("security", () => {
    it("ENSO_SHORTCUTS is never used as a spender in any approve action", () => {
      for (const type of ["cvgCvx", "pxCvx"] as const) {
        const actions = buildHybridZapperActions(
          baseParams({
            type,
            vaultAddress:
              type === "cvgCvx"
                ? VAULT_ADDRESSES.YSCVGCVX
                : VAULT_ADDRESSES.YSPXCVX,
          })
        );

        const approveActions = actions.filter((a) => a.args.method === "approve");
        for (const approve of approveActions) {
          const args = approve.args.args as unknown[];
          // First arg of approve(spender, amount) is the spender
          const spender = args[0];
          expect(spender).not.toBe(ENSO_SHORTCUTS);
          expect(spender).not.toBe(ENSO_SHORTCUTS.toLowerCase());
        }
      }
    });

    it("ENSO_SHORTCUTS IS used as receiver in zap call and balanceOf (which is safe)", () => {
      const actions = buildHybridZapperActions(baseParams());

      // Zap call (action 1): 5th arg is receiver = ENSO_SHORTCUTS
      const zapArgs = actions[1].args.args as string[];
      expect(zapArgs[4]).toBe(ENSO_SHORTCUTS);

      // balanceOf (action 2): checking balance of ENSO_SHORTCUTS
      const balArgs = actions[2].args.args as string[];
      expect(balArgs[0]).toBe(ENSO_SHORTCUTS);
    });
  });

  // --------------------------------------------------------------------------
  // cvxAmountRef as useOutputOfCallAt (dynamic reference)
  // --------------------------------------------------------------------------
  describe("dynamic cvxAmountRef", () => {
    it("passes useOutputOfCallAt reference through to approve and zap args", () => {
      const dynamicRef = { useOutputOfCallAt: 3 };
      const actions = buildHybridZapperActions(
        baseParams({ cvxAmountRef: dynamicRef })
      );

      // Action 0 approve: amount = dynamicRef
      const approveArgs = actions[0].args.args as unknown[];
      expect(approveArgs[1]).toEqual(dynamicRef);

      // Action 1 zap: amountIn = dynamicRef
      const zapArgs = actions[1].args.args as unknown[];
      expect(zapArgs[0]).toEqual(dynamicRef);
    });
  });

  // --------------------------------------------------------------------------
  // depositReceiver is passed through to the deposit action
  // --------------------------------------------------------------------------
  describe("depositReceiver", () => {
    it("is passed as the second arg of the deposit call", () => {
      const receiver = "0x1111111111111111111111111111111111111111";
      const actions = buildHybridZapperActions(
        baseParams({ depositReceiver: receiver })
      );

      const depositArgs = actions[4].args.args as unknown[];
      expect(depositArgs[1]).toBe(receiver);
    });
  });

  // --------------------------------------------------------------------------
  // Deadline is always "0" in zap call
  // --------------------------------------------------------------------------
  describe("zap deadline", () => {
    it("deadline arg is always '0'", () => {
      const actions = buildHybridZapperActions(baseParams());
      const zapArgs = actions[1].args.args as string[];
      // Last arg (index 5) is deadline
      expect(zapArgs[5]).toBe("0");
    });
  });
});
