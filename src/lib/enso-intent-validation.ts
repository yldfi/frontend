import type { EnsoBundleResponse, EnsoRouteResponse } from "@/types/enso";

export type EnsoIntentResponse = EnsoRouteResponse | EnsoBundleResponse;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX_DATA_RE = /^0x(?:[a-fA-F0-9]{2})*$/;
const INTEGER_STRING_RE = /^\d+$/;

export class EnsoIntentValidationError extends Error {
  statusCode = 400;
}

export class EnsoIntentResponseError extends Error {
  statusCode = 502;
}

export function failValidation(message: string): never {
  throw new EnsoIntentValidationError(message);
}

export function failResponse(message: string): never {
  throw new EnsoIntentResponseError(message);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isHexAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

export function normalizeAddress(value: string): string {
  return value.toLowerCase();
}

export function assertAddress(
  value: unknown,
  field: string
): asserts value is `0x${string}` {
  if (!isHexAddress(value)) {
    failValidation(`${field} must be a valid address`);
  }
}

export function assertNonZeroAddress(
  value: unknown,
  field: string
): asserts value is `0x${string}` {
  assertAddress(value, field);
  if (normalizeAddress(value) === ZERO_ADDRESS) {
    failValidation(`${field} must not be the zero address`);
  }
}

export function assertTokenAddress(
  value: unknown,
  field: string
): asserts value is `0x${string}` {
  assertNonZeroAddress(value, field);
}

export function assertPositiveAmount(value: unknown): asserts value is string {
  if (typeof value !== "string" || !INTEGER_STRING_RE.test(value)) {
    failValidation("amountIn must be a positive integer string");
  }
  if (BigInt(value) <= 0n) {
    failValidation("amountIn must be greater than zero");
  }
}

export function assertSlippage(value: unknown): asserts value is string | undefined {
  if (value === undefined) return;
  if (typeof value !== "string" || !INTEGER_STRING_RE.test(value)) {
    failValidation("slippage must be a basis-points string");
  }
  const slippageBps = Number(value);
  if (!Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    failValidation("slippage must be between 0 and 10000 basis points");
  }
}

export function assertExplicitSlippage(value: unknown): asserts value is string {
  if (value === undefined) {
    failValidation("slippage is required for this Enso intent");
  }
  assertSlippage(value);
}

export function assertReceiverIsOwner(request: Record<string, unknown>) {
  if (request.receiver === undefined) return;
  assertAddress(request.receiver, "receiver");
  assertAddress(request.fromAddress, "fromAddress");

  if (normalizeAddress(request.receiver) !== normalizeAddress(request.fromAddress)) {
    failValidation("receiver must match fromAddress for this intent");
  }
}

export function assertBaseIntentFields(
  request: Record<string, unknown>,
  options?: { requireSlippage?: boolean }
) {
  assertNonZeroAddress(request.fromAddress, "fromAddress");
  assertPositiveAmount(request.amountIn);
  if (options?.requireSlippage) {
    assertExplicitSlippage(request.slippage);
  } else {
    assertSlippage(request.slippage);
  }
  assertReceiverIsOwner(request);
}

export function assertOnlyFields(
  request: Record<string, unknown>,
  allowedFields: readonly string[]
) {
  const allowed = new Set<string>(allowedFields);
  for (const field of Object.keys(request)) {
    if (!allowed.has(field)) {
      failValidation(`${field} is not accepted by the ${String(request.intent)} intent`);
    }
  }
}

export function assertNoForbiddenFields(
  request: Record<string, unknown>,
  forbiddenFields: readonly string[]
) {
  for (const field of forbiddenFields) {
    if (field in request) {
      failValidation(`${field} is not accepted by the intent endpoint`);
    }
  }
}

function assertIntegerString(value: unknown, field: string, options?: { positive?: boolean }) {
  if (typeof value !== "string" || !INTEGER_STRING_RE.test(value)) {
    failResponse(`${field} must be an integer string`);
  }
  const parsed = BigInt(value);
  if (options?.positive && parsed <= 0n) {
    failResponse(`${field} must be greater than zero`);
  }
}

function assertHexData(value: unknown, field: string) {
  if (typeof value !== "string" || !HEX_DATA_RE.test(value)) {
    failResponse(`${field} must be hex calldata`);
  }
}

function assertResponseAmountMap(value: unknown, field: string) {
  if (value === undefined) return;
  if (!isRecord(value)) {
    failResponse(`${field} must be an object`);
  }
  for (const [token, amount] of Object.entries(value)) {
    if (!isHexAddress(token)) {
      failResponse(`${field} contains an invalid token address`);
    }
    assertIntegerString(amount, `${field}.${token}`);
  }
}

export function assertEnsoIntentResponseShape(response: EnsoIntentResponse): void {
  if (!isRecord(response) || !isRecord(response.tx)) {
    failResponse("Enso intent returned an invalid transaction response");
  }

  if (!isHexAddress(response.tx.to)) {
    failResponse("Enso intent returned an invalid transaction target");
  }
  assertHexData(response.tx.data, "tx.data");
  assertIntegerString(response.tx.value, "tx.value");

  if ("gas" in response && response.gas !== undefined) {
    assertIntegerString(response.gas, "gas");
  }
  if ("amountOut" in response && response.amountOut !== undefined) {
    assertIntegerString(response.amountOut, "amountOut");
  }
  if ("amountsOut" in response) {
    assertResponseAmountMap(response.amountsOut, "amountsOut");
  }
}

export function assertEnsoIntentTxTargetForIntent(params: {
  intent: string;
  response: EnsoIntentResponse;
  allowedTargets: Readonly<Record<string, readonly string[]>>;
  forbiddenTargets?: readonly string[];
}): void {
  assertEnsoIntentResponseShape(params.response);

  const allowedTargets = params.allowedTargets[params.intent];
  if (!allowedTargets || allowedTargets.length === 0) {
    failResponse(`No transaction target allowlist configured for ${params.intent}`);
  }

  const target = normalizeAddress(params.response.tx.to);
  const forbiddenTargets = new Set(
    (params.forbiddenTargets ?? []).map((address) => normalizeAddress(address))
  );
  if (forbiddenTargets.has(target)) {
    failResponse(`Enso intent ${params.intent} returned a forbidden transaction target`);
  }

  const allowed = new Set(allowedTargets.map((address) => normalizeAddress(address)));
  if (!allowed.has(target)) {
    failResponse(`Enso intent ${params.intent} returned an unexpected transaction target`);
  }
}
