import type { EnsoBundleAction } from "@/types/enso";

export const MAX_SAFE_SLIPPAGE_BPS = 5_000;

const INTEGER_RE = /^\d+$/;
const RAW_SWAP_MIN_AMOUNT_INDEX: Readonly<Record<string, number>> = {
  exchange: 3,
  exchange_underlying: 3,
  exchange_multiple: 3,
  swap: 2,
};

function fail(message: string): never {
  throw new Error(`Unsafe Enso action: ${message}`);
}

export function assertSafeSlippageBps(
  value: unknown,
  field = "slippage",
): asserts value is string | number {
  const isIntegerString = typeof value === "string" && INTEGER_RE.test(value);
  const isIntegerNumber = typeof value === "number" && Number.isSafeInteger(value);

  if (!isIntegerString && !isIntegerNumber) {
    fail(`${field} must be an integer number of basis points`);
  }

  const bps = Number(value);
  if (bps < 0 || bps > MAX_SAFE_SLIPPAGE_BPS) {
    fail(`${field} must be between 0 and ${MAX_SAFE_SLIPPAGE_BPS} basis points`);
  }
}

function assertPositiveLiteralAmount(value: unknown, field: string): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      fail(`${field} must contain at least one positive amount`);
    }
    value.forEach((amount, index) => {
      assertPositiveLiteralAmount(amount, `${field}[${index}]`);
    });
    return;
  }

  try {
    const isIntegerString = typeof value === "string" && INTEGER_RE.test(value);
    const isIntegerNumber = typeof value === "number" && Number.isSafeInteger(value);
    if (
      typeof value !== "bigint" &&
      !isIntegerString &&
      !isIntegerNumber
    ) {
      fail(`${field} must be a positive literal amount`);
    }
    if (BigInt(value) <= 0n) {
      fail(`${field} must be greater than zero`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unsafe Enso action:")) {
      throw error;
    }
    fail(`${field} must be a positive literal amount`);
  }
}

function assertRouteProtection(action: EnsoBundleAction, index: number): void {
  const hasSlippage = action.args.slippage !== undefined;
  const hasMinAmountOut = action.args.minAmountOut !== undefined;

  if (hasSlippage === hasMinAmountOut) {
    fail(
      `actions[${index}] ${action.action} must specify exactly one of slippage or minAmountOut`,
    );
  }

  if (hasSlippage) {
    assertSafeSlippageBps(action.args.slippage, `actions[${index}].args.slippage`);
    return;
  }

  assertPositiveLiteralAmount(
    action.args.minAmountOut,
    `actions[${index}].args.minAmountOut`,
  );
}

function assertRawSwapProtection(action: EnsoBundleAction, index: number): void {
  const method = action.args.method;
  if (typeof method !== "string") return;

  const minAmountIndex = RAW_SWAP_MIN_AMOUNT_INDEX[method];
  if (minAmountIndex === undefined) return;

  const callArgs = action.args.args;
  if (!Array.isArray(callArgs)) {
    fail(`actions[${index}] ${method} call is missing its argument list`);
  }

  assertPositiveLiteralAmount(
    callArgs[minAmountIndex],
    `actions[${index}] ${method} minimum output`,
  );
}

/**
 * Reject executable market conversions that do not contain an effective,
 * explicit output bound. This is deliberately enforced at the shared bundle
 * boundary so new recipes fail closed if a route author omits protection.
 */
export function assertProtectedEnsoBundleActions(actions: EnsoBundleAction[]): void {
  actions.forEach((action, index) => {
    if (action.protocol !== "enso") return;

    if (action.action === "route" || action.action === "swap") {
      assertRouteProtection(action, index);
      return;
    }

    if (action.action === "minamountout") {
      assertPositiveLiteralAmount(
        action.args.minAmountOut,
        `actions[${index}].args.minAmountOut`,
      );
      return;
    }

    if (action.action === "call") {
      assertRawSwapProtection(action, index);
    }
  });
}
