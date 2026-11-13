// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

// conversions.ts is part of an import cycle with external-vault-zap-in.ts and
// external-vault-routes.ts (see the note at the top of conversions.ts). Mocking
// the modules it reaches through, then importing conversions after the mocks,
// keeps the cycle resolvable in the unit project, same as
// enso-conversions-usdc-cvx.test.ts.
const {
  mockPreviewRedeem,
  mockGetCurveGetDy,
  mockGetCurveGetDyFactory,
  mockPreviewBeefyWithdraw,
  mockPreviewUCrvWithdraw,
  mockRpcWithFallback,
  mockFetchQuote,
  mockGetDynamicInputAggregatorPolicy,
} = vi.hoisted(() => ({
  mockPreviewRedeem: vi.fn(),
  mockGetCurveGetDy: vi.fn(),
  mockGetCurveGetDyFactory: vi.fn(),
  mockPreviewBeefyWithdraw: vi.fn(),
  mockPreviewUCrvWithdraw: vi.fn(),
  mockRpcWithFallback: vi.fn(),
  mockFetchQuote: vi.fn(),
  mockGetDynamicInputAggregatorPolicy: vi.fn(),
}));

vi.mock("@/lib/curve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/curve")>()),
  previewRedeem: mockPreviewRedeem,
  getCurveGetDy: mockGetCurveGetDy,
  getCurveGetDyFactory: mockGetCurveGetDyFactory,
}));

vi.mock("@/lib/enso/external-vault-zap-in", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/enso/external-vault-zap-in")>()),
  previewBeefyWithdraw: mockPreviewBeefyWithdraw,
  previewUCrvWithdraw: mockPreviewUCrvWithdraw,
}));

vi.mock("@/lib/enso/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/enso/api")>()),
  rpcWithFallback: mockRpcWithFallback,
  fetchQuote: mockFetchQuote,
  getDynamicInputAggregatorPolicy: mockGetDynamicInputAggregatorPolicy,
}));

import { CURVE_CVX_ETH_POOL, YVUSDC1_ADDRESS } from "@/config/addresses";
import {
  BEEFY,
  CONCENTRATOR,
  LLAMA_AIRFORCE,
  TOKENS,
  YEARN,
  getExternalVaultConfig,
  type ExternalVaultConfig,
} from "@/config/vaults";
import {
  CURVE_TRICRV_POOL,
  rawCallConsumingInput,
} from "@/lib/enso/bundle-helpers";
import { ENSO_SHORTCUTS } from "@/lib/enso/constants";
import {
  buildInitialConversionState,
  estimateExternalVaultShares,
  type ConversionContext,
  type ConversionState,
} from "@/lib/enso/conversions";
import type { EnsoBundleAction } from "@/types/enso";

const ctx: ConversionContext = {
  fromAddress: "0x1234567890123456789012345678901234567890",
  slippage: "100",
  slippageBps: 100,
  totalSlippageBps: 150,
};

// 1 USDC / 1 share-ish raw amount.
const AMOUNT_IN = "1000000";

function externalVault(address: string): ExternalVaultConfig {
  const config = getExternalVaultConfig(address);
  if (!config) throw new Error(`missing external vault config for ${address}`);
  return config;
}

// Every non-throwing result must spend either the input amount itself or the
// output of an action that exists in the bundle.
function expectAmountRefIntoActions(state: ConversionState, actions: EnsoBundleAction[]) {
  const ref = state.amountRef;
  if (typeof ref === "string") {
    expect(ref).toBe(AMOUNT_IN);
    return;
  }
  expect(ref.useOutputOfCallAt).toBeGreaterThanOrEqual(0);
  expect(ref.useOutputOfCallAt).toBeLessThan(actions.length);
}

// The yvUSDC-1 -> CVX path also quotes the USDC->crvUSD->WETH->CVX pool chain
// and asks whether a router quote is allowed. Return no safe aggregators and
// three plausible pool reads so the deterministic Curve path is taken.
function useUsdcToCvxCurvePath() {
  mockGetCurveGetDy.mockResolvedValue(2_000_000n);
  mockGetCurveGetDyFactory.mockImplementation(async (pool: string) => {
    if (pool === CURVE_TRICRV_POOL) return 3_000n;
    if (pool === CURVE_CVX_ETH_POOL) return 4_000n;
    throw new Error(`unexpected pool ${pool}`);
  });
  mockGetDynamicInputAggregatorPolicy.mockResolvedValue({
    availableSafeAggregators: [],
    ignoreAggregators: ["0x"],
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("buildInitialConversionState: not an external vault", () => {
  it("returns the input amount unchanged and calls no preview", async () => {
    const result = await buildInitialConversionState({
      inputToken: TOKENS.CVX,
      amountIn: AMOUNT_IN,
      targetToken: TOKENS.CVXCRV,
      ctx,
    });

    expect(result.actions).toEqual([]);
    expect(result.steps).toEqual([]);
    expect(result.state).toEqual({
      token: TOKENS.CVX,
      amountRef: AMOUNT_IN,
      expectedAmount: BigInt(AMOUNT_IN),
    });
    expect(result.actions).toHaveLength(0);
    expect(mockPreviewRedeem).not.toHaveBeenCalled();
    expect(mockPreviewBeefyWithdraw).not.toHaveBeenCalled();
    expect(mockPreviewUCrvWithdraw).not.toHaveBeenCalled();
  });
});

describe("buildInitialConversionState: ucrv vault", () => {
  const config = externalVault(LLAMA_AIRFORCE.UCRV);

  it("withdraws with the (address, uint256) interface into ENSO_SHORTCUTS", async () => {
    mockPreviewUCrvWithdraw.mockResolvedValue("900000");

    const result = await buildInitialConversionState({
      inputToken: config.address,
      amountIn: AMOUNT_IN,
      targetToken: TOKENS.CVXCRV,
      ctx,
    });

    expect(mockPreviewUCrvWithdraw).toHaveBeenCalledTimes(1);
    expect(mockPreviewUCrvWithdraw).toHaveBeenCalledWith(AMOUNT_IN);

    const expectedWithdraw = rawCallConsumingInput(AMOUNT_IN, config.address, {
      address: config.address,
      method: "withdraw",
      abi: "function withdraw(address _to, uint256 _shares) returns (uint256)",
      args: [ENSO_SHORTCUTS, AMOUNT_IN],
    });
    // ENSO_SHORTCUTS is the receiver, not the vault or the caller.
    const [action] = result.actions;
    expect(action).toEqual(expectedWithdraw);
    expect(action.args.address).toBe(config.address);
    expect(action.args.method).toBe("withdraw");
    expect((action.args.args as unknown[])[0]).toBe(ENSO_SHORTCUTS);
    expect((action.args.args as unknown[])[0]).not.toBe(ctx.fromAddress);
    expect((action.args.args as unknown[])[1]).toBe(AMOUNT_IN);
    expect(action.args.tokenIn).toBe(config.address);
    expect(action.args.amountIn).toBe(AMOUNT_IN);

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].action).toBe("Withdraw");
    expect(result.steps[0].tokenAddress).toBe(config.address);
    expect(result.steps[0].rawAmount).toBe(AMOUNT_IN);

    expect(result.state.token).toBe(LLAMA_AIRFORCE.UCRV_UNDERLYING);
    expect(result.state.amountRef).toEqual({ useOutputOfCallAt: 0 });
    expect(result.state.expectedAmount).toBe(900_000n);

    expectAmountRefIntoActions(result.state, result.actions);
  });
});

describe("buildInitialConversionState: beefy vault", () => {
  const config = externalVault(BEEFY.MOO_CVX_CRV);

  it("withdraws then reads the underlying balance, pointing at the balance", async () => {
    mockPreviewBeefyWithdraw.mockResolvedValue("1500000");

    const result = await buildInitialConversionState({
      inputToken: config.address,
      amountIn: AMOUNT_IN,
      targetToken: TOKENS.CVX,
      ctx,
    });

    expect(mockPreviewBeefyWithdraw).toHaveBeenCalledTimes(1);
    expect(mockPreviewBeefyWithdraw).toHaveBeenCalledWith(config.address, AMOUNT_IN);

    expect(result.actions).toHaveLength(2);
    expect(result.actions[0]).toEqual(
      rawCallConsumingInput(AMOUNT_IN, config.address, {
        address: config.address,
        method: "withdraw",
        abi: "function withdraw(uint256 _shares)",
        args: [AMOUNT_IN],
      }),
    );
    expect(result.actions[0].args.tokenIn).toBe(config.address);
    expect(result.actions[0].args.amountIn).toBe(AMOUNT_IN);
    expect(result.actions[1]).toEqual({
      protocol: "enso",
      action: "balance",
      args: { token: config.underlying },
    });

    // withdraw() returns nothing, so the amount must come from the balance read.
    expect(result.state.amountRef).toEqual({ useOutputOfCallAt: 1 });
    expect(result.state.amountRef).not.toEqual({ useOutputOfCallAt: 0 });
    expect(result.state.token).toBe(config.underlying);
    expect(result.state.expectedAmount).toBe(1_500_000n);

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].action).toBe("Withdraw");
    expect(result.steps[0].rawAmount).toBe(AMOUNT_IN);

    expectAmountRefIntoActions(result.state, result.actions);
  });
});

describe("buildInitialConversionState: erc4626 vault", () => {
  const config = externalVault(CONCENTRATOR.ACVX);

  it("redeems once and spends the redeem output", async () => {
    mockPreviewRedeem.mockResolvedValue("700000");

    const result = await buildInitialConversionState({
      inputToken: config.address,
      amountIn: AMOUNT_IN,
      targetToken: TOKENS.CVXCRV,
      ctx,
    });

    expect(mockPreviewRedeem).toHaveBeenCalledTimes(1);
    expect(mockPreviewRedeem).toHaveBeenCalledWith(config.address, AMOUNT_IN);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toEqual({
      protocol: "erc4626",
      action: "redeem",
      args: {
        tokenIn: config.address,
        tokenOut: config.underlying,
        amountIn: AMOUNT_IN,
        primaryAddress: config.address,
      },
    });

    expect(result.state.token).toBe(config.underlying);
    expect(result.state.amountRef).toEqual({ useOutputOfCallAt: 0 });
    expect(result.state.expectedAmount).toBe(700_000n);

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].action).toBe("Redeem");
    expect(result.steps[0].rawAmount).toBe(AMOUNT_IN);

    expectAmountRefIntoActions(result.state, result.actions);
  });

  it("keeps the plain redeem for an erc4626 vault other than yvUSDC-1 with target CVX", async () => {
    mockPreviewRedeem.mockResolvedValue("700000");

    const result = await buildInitialConversionState({
      inputToken: config.address,
      amountIn: AMOUNT_IN,
      targetToken: TOKENS.CVX,
      ctx,
    });

    expect(config.address.toLowerCase()).not.toBe(YVUSDC1_ADDRESS.toLowerCase());
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].action).toBe("redeem");
    expect(result.actions[0].protocol).toBe("erc4626");
    expect(mockGetCurveGetDy).not.toHaveBeenCalled();
    expect(mockGetCurveGetDyFactory).not.toHaveBeenCalled();

    expect(result.state.token).toBe(config.underlying);
    expect(result.state.amountRef).toEqual({ useOutputOfCallAt: 0 });
    expect(result.state.expectedAmount).toBe(700_000n);

    expectAmountRefIntoActions(result.state, result.actions);
  });
});

describe("buildInitialConversionState: yvUSDC-1 into CVX", () => {
  const config = externalVault(YEARN.YVUSDC1);

  it("is the vault the special path is keyed on", () => {
    expect(config.address.toLowerCase()).toBe(YVUSDC1_ADDRESS.toLowerCase());
    expect(config.interface).toBe("erc4626");
  });

  it.each([
    { label: "CVX", target: TOKENS.CVX },
    { label: "pxCVX", target: TOKENS.PXCVX },
    { label: "lpxCVX", target: TOKENS.LPXCVX },
  ])("redeems then converts the USDC to CVX (target $label)", async ({ target }) => {
    mockPreviewRedeem.mockResolvedValue("1000000");
    useUsdcToCvxCurvePath();

    const result = await buildInitialConversionState({
      inputToken: config.address,
      amountIn: AMOUNT_IN,
      targetToken: target,
      ctx,
    });

    expect(result.actions[0]).toEqual({
      protocol: "erc4626",
      action: "redeem",
      args: {
        tokenIn: config.address,
        tokenOut: config.underlying,
        amountIn: AMOUNT_IN,
        primaryAddress: config.address,
      },
    });
    expect(result.actions.length).toBeGreaterThan(1);

    expect(result.state.token).toBe(TOKENS.CVX);
    expect(result.state.amountRef).toEqual({ useOutputOfCallAt: 2 });
    const ref = result.state.amountRef as { useOutputOfCallAt: number };
    expect(ref.useOutputOfCallAt).toBeGreaterThan(0);
    expect(ref.useOutputOfCallAt).toBeLessThan(result.actions.length);
    expect(result.state.expectedAmount).toBe(4_000n);

    // Redeem step first, then the swap that turns its USDC output into CVX.
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].action).toBe("Redeem");
    expect(result.steps[0].rawAmount).toBe(AMOUNT_IN);
    expect(result.steps[1].protocol).toBe("Curve");

    expectAmountRefIntoActions(result.state, result.actions);
  });

  it("keeps only the redeem for another target", async () => {
    mockPreviewRedeem.mockResolvedValue("1000000");

    const result = await buildInitialConversionState({
      inputToken: config.address,
      amountIn: AMOUNT_IN,
      targetToken: TOKENS.CVXCRV,
      ctx,
    });

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].action).toBe("redeem");
    expect(mockGetCurveGetDy).not.toHaveBeenCalled();
    expect(mockGetCurveGetDyFactory).not.toHaveBeenCalled();

    expect(result.state.token).toBe(config.underlying);
    expect(result.state.amountRef).toEqual({ useOutputOfCallAt: 0 });
    expect(result.state.expectedAmount).toBe(1_000_000n);

    expectAmountRefIntoActions(result.state, result.actions);
  });
});

describe("buildInitialConversionState: preview failures", () => {
  it("propagates the erc4626 preview error unchanged", async () => {
    const config = externalVault(CONCENTRATOR.ACVX);
    mockPreviewRedeem.mockRejectedValue(new Error("preview failed"));

    await expect(
      buildInitialConversionState({
        inputToken: config.address,
        amountIn: AMOUNT_IN,
        targetToken: TOKENS.CVXCRV,
        ctx,
      }),
    ).rejects.toThrow("preview failed");
  });
});

// --- estimateExternalVaultShares -------------------------------------------

interface RpcPayload {
  jsonrpc: string;
  id: number;
  method: string;
  params: [{ to: string; data: string }, string];
}

const VAULT = "0x1111111111111111111111111111111111111111";
const ERC4626_SELECTOR = "0xef8b30f7";
const BEEFY_SELECTOR = "0x77c7b8fc";
const TOTAL_UNDERLYING_SELECTOR = "0xc70920bc";
const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function rpcPayloads(): RpcPayload[] {
  return mockRpcWithFallback.mock.calls.map(([payload]) => payload as RpcPayload);
}

describe("estimateExternalVaultShares: zero amount", () => {
  it.each(["erc4626", "beefy", "ucrv"] as const)(
    "returns zero without an RPC call (%s)",
    async (vaultInterface) => {
      await expect(
        estimateExternalVaultShares({
          vaultAddress: VAULT,
          vaultInterface,
          underlyingAmount: 0n,
        }),
      ).resolves.toBe("0");

      expect(mockRpcWithFallback).not.toHaveBeenCalled();
    },
  );
});

describe("estimateExternalVaultShares: erc4626", () => {
  it("calls previewDeposit with the amount and returns its result as a decimal string", async () => {
    mockRpcWithFallback.mockResolvedValue({ result: "0x0de0b6b3a7640000" });

    await expect(
      estimateExternalVaultShares({
        vaultAddress: VAULT,
        vaultInterface: "erc4626",
        underlyingAmount: 1_000_000n,
      }),
    ).resolves.toBe("1000000000000000000");

    const payloads = rpcPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].method).toBe("eth_call");
    expect(payloads[0].params[0].to).toBe(VAULT);
    expect(payloads[0].params[0].data).toBe(
      `${ERC4626_SELECTOR}${"0".repeat(59)}f4240`,
    );
    expect(payloads[0].params[0].data.endsWith("0f4240")).toBe(true);
    expect(payloads[0].params[0].data.slice(ERC4626_SELECTOR.length)).toHaveLength(64);
    expect(payloads[0].params[1]).toBe("latest");
  });

  it.each([
    { label: "an empty result", reply: { result: "0x" } },
    { label: "a missing result", reply: {} },
  ])("throws on $label", async ({ reply }) => {
    mockRpcWithFallback.mockResolvedValue(reply);

    await expect(
      estimateExternalVaultShares({
        vaultAddress: VAULT,
        vaultInterface: "erc4626",
        underlyingAmount: 1_000_000n,
      }),
    ).rejects.toThrow(
      "Failed to estimate external vault shares: previewDeposit returned no result",
    );
  });
});

describe("estimateExternalVaultShares: beefy", () => {
  it("divides by pricePerFullShare scaled to 1e18", async () => {
    mockRpcWithFallback.mockResolvedValue({ result: `0x${word(2n * 10n ** 18n)}` });

    await expect(
      estimateExternalVaultShares({
        vaultAddress: VAULT,
        vaultInterface: "beefy",
        underlyingAmount: 10n ** 18n,
      }),
    ).resolves.toBe("500000000000000000");

    const payloads = rpcPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].params[0].to).toBe(VAULT);
    expect(payloads[0].params[0].data).toBe(BEEFY_SELECTOR);
  });

  it("rounds down", async () => {
    mockRpcWithFallback.mockResolvedValue({ result: `0x${word(3n * 10n ** 18n)}` });

    await expect(
      estimateExternalVaultShares({
        vaultAddress: VAULT,
        vaultInterface: "beefy",
        underlyingAmount: 1n,
      }),
    ).resolves.toBe("0");
  });

  it.each([
    { label: "a zero pricePerFullShare", reply: { result: `0x${word(0n)}` } },
    { label: "an empty result", reply: { result: "0x" } },
    { label: "a missing result", reply: {} },
  ])("throws on $label", async ({ reply }) => {
    mockRpcWithFallback.mockResolvedValue(reply);

    await expect(
      estimateExternalVaultShares({
        vaultAddress: VAULT,
        vaultInterface: "beefy",
        underlyingAmount: 10n ** 18n,
      }),
    ).rejects.toThrow(
      "Failed to estimate external vault shares: pricePerFullShare is zero",
    );
  });
});

describe("estimateExternalVaultShares: ucrv", () => {
  it("reads totalUnderlying and totalSupply and scales the amount", async () => {
    mockRpcWithFallback
      .mockResolvedValueOnce({ result: `0x${word(2000n)}` })
      .mockResolvedValueOnce({ result: `0x${word(1000n)}` });

    await expect(
      estimateExternalVaultShares({
        vaultAddress: VAULT,
        vaultInterface: "ucrv",
        underlyingAmount: 500n,
      }),
    ).resolves.toBe("250");

    const payloads = rpcPayloads();
    expect(payloads).toHaveLength(2);
    expect(payloads[0].params[0].to).toBe(VAULT);
    expect(payloads[0].params[0].data).toBe(TOTAL_UNDERLYING_SELECTOR);
    expect(payloads[1].params[0].to).toBe(VAULT);
    expect(payloads[1].params[0].data).toBe(TOTAL_SUPPLY_SELECTOR);
  });

  it.each([
    {
      label: "a zero totalUnderlying",
      replies: [{ result: `0x${word(0n)}` }, { result: `0x${word(1000n)}` }],
    },
    {
      label: "a zero totalSupply",
      replies: [{ result: `0x${word(2000n)}` }, { result: `0x${word(0n)}` }],
    },
    {
      label: "an empty totalUnderlying",
      replies: [{ result: "0x" }, { result: `0x${word(1000n)}` }],
    },
    {
      label: "a missing totalSupply",
      replies: [{ result: `0x${word(2000n)}` }, {}],
    },
  ])("throws on $label", async ({ replies }) => {
    for (const reply of replies) {
      mockRpcWithFallback.mockResolvedValueOnce(reply);
    }

    await expect(
      estimateExternalVaultShares({
        vaultAddress: VAULT,
        vaultInterface: "ucrv",
        underlyingAmount: 500n,
      }),
    ).rejects.toThrow(
      "Failed to estimate external vault shares: totalUnderlying/totalSupply unavailable",
    );
  });
});

describe("estimateExternalVaultShares: RPC failure", () => {
  it.each(["erc4626", "beefy", "ucrv"] as const)(
    "propagates the RPC error (%s)",
    async (vaultInterface) => {
      mockRpcWithFallback.mockRejectedValue(new Error("rpc down"));

      await expect(
        estimateExternalVaultShares({
          vaultAddress: VAULT,
          vaultInterface,
          underlyingAmount: 1_000_000n,
        }),
      ).rejects.toThrow("rpc down");
    },
  );
});
