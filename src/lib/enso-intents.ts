import { getVaultByAddress, TOKENS, type VaultConfig } from "@/config/vaults";
import type { EnsoBundleResponse, EnsoRouteResponse } from "@/types/enso";

export type EnsoIntentName =
  | "plainTokenSwap"
  | "yldVaultZapIn"
  | "yldVaultZapOut"
  | "yldVaultToVault";

type BaseIntentRequest = {
  fromAddress: string;
  amountIn: string;
  slippage?: string;
  receiver?: string;
};

export type PlainTokenSwapIntentRequest = BaseIntentRequest & {
  intent: "plainTokenSwap";
  tokenIn: string;
  tokenOut: string;
};

export type YldVaultZapInIntentRequest = BaseIntentRequest & {
  intent: "yldVaultZapIn";
  inputToken: string;
  vaultAddress: string;
};

export type YldVaultZapOutIntentRequest = BaseIntentRequest & {
  intent: "yldVaultZapOut";
  vaultAddress: string;
  outputToken: string;
};

export type YldVaultToVaultIntentRequest = BaseIntentRequest & {
  intent: "yldVaultToVault";
  sourceVault: string;
  targetVault: string;
};

export type EnsoIntentRequest =
  | PlainTokenSwapIntentRequest
  | YldVaultZapInIntentRequest
  | YldVaultZapOutIntentRequest
  | YldVaultToVaultIntentRequest;

export type EnsoIntentResponse = EnsoRouteResponse | EnsoBundleResponse;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ENSO_ROUTER = "0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E";
const ENSO_ROUTER_EXECUTOR = "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf";
const ENSO_SHORTCUTS = "0x4Fe93ebC4Ce6Ae4f81601cC7Ce7139023919E003";
const FORBIDDEN_INTENT_FIELDS = [
  "actions",
  "data",
  "innerData",
  "routingStrategy",
  "skipQuote",
  "target",
] as const;
const BASE_INTENT_FIELDS = [
  "intent",
  "fromAddress",
  "amountIn",
  "slippage",
  "receiver",
] as const;
const SPECIAL_STANDARD_DEFERRED_ASSETS = new Set([
  TOKENS.CVGCVX.toLowerCase(),
  TOKENS.PXCVX.toLowerCase(),
]);
const ALLOWED_INTENT_TX_TARGETS = new Set([
  ENSO_ROUTER.toLowerCase(),
  ENSO_ROUTER_EXECUTOR.toLowerCase(),
]);

export class EnsoIntentValidationError extends Error {
  statusCode = 400;
}

export class EnsoIntentResponseError extends Error {
  statusCode = 502;
}

function failValidation(message: string): never {
  throw new EnsoIntentValidationError(message);
}

function failResponse(message: string): never {
  throw new EnsoIntentResponseError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isHexAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

function assertAddress(value: unknown, field: string): asserts value is `0x${string}` {
  if (!isHexAddress(value)) {
    failValidation(`${field} must be a valid address`);
  }
}

function assertPositiveAmount(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    failValidation("amountIn must be a positive integer string");
  }
  if (BigInt(value) <= 0n) {
    failValidation("amountIn must be greater than zero");
  }
}

function assertSlippage(value: unknown): asserts value is string | undefined {
  if (value === undefined) return;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    failValidation("slippage must be a basis-points string");
  }
  const slippageBps = Number(value);
  if (!Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    failValidation("slippage must be between 0 and 10000 basis points");
  }
}

function assertReceiverIsOwner(request: Record<string, unknown>) {
  if (request.receiver === undefined) return;
  assertAddress(request.receiver, "receiver");
  assertAddress(request.fromAddress, "fromAddress");

  if (request.receiver.toLowerCase() !== request.fromAddress.toLowerCase()) {
    failValidation("receiver must match fromAddress for this intent");
  }
}

function assertBaseIntentFields(request: Record<string, unknown>) {
  assertAddress(request.fromAddress, "fromAddress");
  assertPositiveAmount(request.amountIn);
  assertSlippage(request.slippage);
  assertReceiverIsOwner(request);
}

function assertOnlyIntentFields(
  request: Record<string, unknown>,
  fields: readonly string[]
) {
  const allowedFields = new Set<string>([...BASE_INTENT_FIELDS, ...fields]);
  for (const field of Object.keys(request)) {
    if (!allowedFields.has(field)) {
      failValidation(`${field} is not accepted by the ${String(request.intent)} intent`);
    }
  }
}

export function getIntentVault(address: string): VaultConfig | undefined {
  if (address.toLowerCase() === ZERO_ADDRESS) return undefined;
  return getVaultByAddress(address);
}

export function isStandardYldVaultIntentVault(vaultAddress: string): boolean {
  const vault = getIntentVault(vaultAddress);
  if (!vault) return false;
  return !SPECIAL_STANDARD_DEFERRED_ASSETS.has(vault.assetAddress.toLowerCase());
}

function assertStandardYldVault(address: unknown, field: string): asserts address is `0x${string}` {
  assertAddress(address, field);
  const vault = getIntentVault(address);
  if (!vault) {
    failValidation(`${field} must be a known YLD vault`);
  }
  if (!isStandardYldVaultIntentVault(address)) {
    failValidation(`${field} uses a special asset flow that is not migrated to this intent yet`);
  }
}

function assertPlainTokenSwap(request: Record<string, unknown>): asserts request is PlainTokenSwapIntentRequest {
  assertBaseIntentFields(request);
  assertAddress(request.tokenIn, "tokenIn");
  assertAddress(request.tokenOut, "tokenOut");
  if (request.tokenIn.toLowerCase() === request.tokenOut.toLowerCase()) {
    failValidation("tokenIn and tokenOut must be different");
  }
}

function assertYldVaultZapIn(request: Record<string, unknown>): asserts request is YldVaultZapInIntentRequest {
  assertBaseIntentFields(request);
  assertAddress(request.inputToken, "inputToken");
  assertStandardYldVault(request.vaultAddress, "vaultAddress");
}

function assertYldVaultZapOut(request: Record<string, unknown>): asserts request is YldVaultZapOutIntentRequest {
  assertBaseIntentFields(request);
  assertStandardYldVault(request.vaultAddress, "vaultAddress");
  assertAddress(request.outputToken, "outputToken");
}

function assertYldVaultToVault(request: Record<string, unknown>): asserts request is YldVaultToVaultIntentRequest {
  assertBaseIntentFields(request);
  assertStandardYldVault(request.sourceVault, "sourceVault");
  assertStandardYldVault(request.targetVault, "targetVault");
  if (request.sourceVault.toLowerCase() === request.targetVault.toLowerCase()) {
    failValidation("sourceVault and targetVault must be different");
  }
}

export function assertValidEnsoIntentRequest(value: unknown): asserts value is EnsoIntentRequest {
  if (!isRecord(value)) {
    failValidation("Intent request body must be an object");
  }

  for (const field of FORBIDDEN_INTENT_FIELDS) {
    if (field in value) {
      failValidation(`${field} is not accepted by the intent endpoint`);
    }
  }

  switch (value.intent) {
    case "plainTokenSwap":
      assertOnlyIntentFields(value, ["tokenIn", "tokenOut"]);
      assertPlainTokenSwap(value);
      return;
    case "yldVaultZapIn":
      assertOnlyIntentFields(value, ["inputToken", "vaultAddress"]);
      assertYldVaultZapIn(value);
      return;
    case "yldVaultZapOut":
      assertOnlyIntentFields(value, ["vaultAddress", "outputToken"]);
      assertYldVaultZapOut(value);
      return;
    case "yldVaultToVault":
      assertOnlyIntentFields(value, ["sourceVault", "targetVault"]);
      assertYldVaultToVault(value);
      return;
    default:
      failValidation("Unknown Enso intent");
  }
}

export function assertEnsoIntentTxTarget(response: EnsoIntentResponse): void {
  const target = response.tx.to.toLowerCase();
  if (target === ENSO_SHORTCUTS.toLowerCase()) {
    failResponse("Enso intent returned ENSO_SHORTCUTS as the transaction target");
  }
  if (!ALLOWED_INTENT_TX_TARGETS.has(target)) {
    failResponse("Enso intent returned an unexpected transaction target");
  }
}

export function shouldUsePlainTokenSwapIntent(params: {
  fromAddress: string;
  receiver?: string;
}): boolean {
  return (
    !params.receiver ||
    params.receiver.toLowerCase() === params.fromAddress.toLowerCase()
  );
}

export async function fetchEnsoIntent<T extends EnsoIntentResponse>(
  request: EnsoIntentRequest
): Promise<T> {
  const res = await fetch("/api/enso/intent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(err.error || `Enso intent proxy error: ${res.status}`);
  }

  return await res.json() as T;
}
