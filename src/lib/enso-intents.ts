import { getVaultByAddress, TOKENS, type VaultConfig } from "@/config/vaults";
import type { EnsoBundleResponse, EnsoRouteResponse } from "@/types/enso";
import {
  ZERO_ADDRESS,
  assertAddress,
  assertBaseIntentFields,
  assertEnsoIntentTxTargetForIntent,
  assertNoForbiddenFields,
  assertOnlyFields,
  assertTokenAddress,
  failValidation,
  isRecord,
  normalizeAddress,
} from "@/lib/enso-intent-validation";

export {
  EnsoIntentResponseError,
  EnsoIntentValidationError,
  isHexAddress,
} from "@/lib/enso-intent-validation";

export type EnsoIntentName =
  | "plainTokenSwap"
  | "yldVaultZapIn"
  | "yldVaultZapOut"
  | "yldVaultToVault"
  | "yldVaultToCvgCvxVault"
  | "cvgCvxVaultToYldVault"
  | "yldVaultToPxCvxVault"
  | "pxCvxVaultToYldVault"
  | "cvgCvxZapIn"
  | "cvgCvxZapOut"
  | "pxCvxZapIn"
  | "pxCvxZapOut";

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

export type SpecialYldVaultToVaultIntentRequest = BaseIntentRequest & {
  intent:
    | "yldVaultToCvgCvxVault"
    | "cvgCvxVaultToYldVault"
    | "yldVaultToPxCvxVault"
    | "pxCvxVaultToYldVault";
  sourceVault: string;
  targetVault: string;
};

export type SpecialYldVaultZapInIntentRequest = BaseIntentRequest & {
  intent: "cvgCvxZapIn" | "pxCvxZapIn";
  inputToken: string;
  vaultAddress: string;
};

export type SpecialYldVaultZapOutIntentRequest = BaseIntentRequest & {
  intent: "cvgCvxZapOut" | "pxCvxZapOut";
  vaultAddress: string;
  outputToken: string;
};

export type EnsoIntentRequest =
  | PlainTokenSwapIntentRequest
  | YldVaultZapInIntentRequest
  | YldVaultZapOutIntentRequest
  | YldVaultToVaultIntentRequest
  | SpecialYldVaultToVaultIntentRequest
  | SpecialYldVaultZapInIntentRequest
  | SpecialYldVaultZapOutIntentRequest;

export type YldVaultToVaultIntentName =
  | YldVaultToVaultIntentRequest["intent"]
  | SpecialYldVaultToVaultIntentRequest["intent"];

export type EnsoIntentResponse = EnsoRouteResponse | EnsoBundleResponse;

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
const COMMON_INTENT_TX_TARGETS = [ENSO_ROUTER, ENSO_ROUTER_EXECUTOR] as const;
const INTENT_TX_TARGET_ALLOWLIST: Record<EnsoIntentName, readonly string[]> = {
  plainTokenSwap: COMMON_INTENT_TX_TARGETS,
  yldVaultZapIn: COMMON_INTENT_TX_TARGETS,
  yldVaultZapOut: COMMON_INTENT_TX_TARGETS,
  yldVaultToVault: COMMON_INTENT_TX_TARGETS,
  yldVaultToCvgCvxVault: COMMON_INTENT_TX_TARGETS,
  cvgCvxVaultToYldVault: COMMON_INTENT_TX_TARGETS,
  yldVaultToPxCvxVault: COMMON_INTENT_TX_TARGETS,
  pxCvxVaultToYldVault: COMMON_INTENT_TX_TARGETS,
  cvgCvxZapIn: COMMON_INTENT_TX_TARGETS,
  cvgCvxZapOut: COMMON_INTENT_TX_TARGETS,
  pxCvxZapIn: COMMON_INTENT_TX_TARGETS,
  pxCvxZapOut: COMMON_INTENT_TX_TARGETS,
};

function assertOnlyIntentFields(
  request: Record<string, unknown>,
  fields: readonly string[]
) {
  assertOnlyFields(request, [...BASE_INTENT_FIELDS, ...fields]);
}

function assertLiquidTokenAddress(
  value: unknown,
  field: string
): asserts value is `0x${string}` {
  assertTokenAddress(value, field);
  if (getIntentVault(value)) {
    failValidation(`${field} must be a liquid token, not a YLD vault`);
  }
}

export function getIntentVault(address: string): VaultConfig | undefined {
  if (normalizeAddress(address) === ZERO_ADDRESS) return undefined;
  return getVaultByAddress(address);
}

export function isStandardYldVaultIntentVault(vaultAddress: string): boolean {
  const vault = getIntentVault(vaultAddress);
  if (!vault) return false;
  return !SPECIAL_STANDARD_DEFERRED_ASSETS.has(vault.assetAddress.toLowerCase());
}

function getVaultAsset(address: string): string | undefined {
  return getIntentVault(address)?.assetAddress.toLowerCase();
}

function getVaultToVaultIntentName(
  sourceVault: string,
  targetVault: string
): YldVaultToVaultIntentName | undefined {
  const sourceAsset = getVaultAsset(sourceVault);
  const targetAsset = getVaultAsset(targetVault);
  if (!sourceAsset || !targetAsset) return undefined;

  // Match fetchVaultToVaultRoute dispatch order. Source pxCVX has precedence
  // because pxCVX exits need the Pirex unwrap/swap path even when the target is
  // another special vault.
  if (sourceAsset === TOKENS.PXCVX.toLowerCase()) return "pxCvxVaultToYldVault";
  if (targetAsset === TOKENS.CVGCVX.toLowerCase()) return "yldVaultToCvgCvxVault";
  if (sourceAsset === TOKENS.CVGCVX.toLowerCase()) return "cvgCvxVaultToYldVault";
  if (targetAsset === TOKENS.PXCVX.toLowerCase()) return "yldVaultToPxCvxVault";
  return "yldVaultToVault";
}

export function getYldVaultToVaultIntentName(params: {
  sourceVault: string;
  targetVault: string;
}): YldVaultToVaultIntentName | undefined {
  return getVaultToVaultIntentName(params.sourceVault, params.targetVault);
}

function assertYldVault(address: unknown, field: string): asserts address is `0x${string}` {
  assertAddress(address, field);
  if (!getIntentVault(address)) {
    failValidation(`${field} must be a known YLD vault`);
  }
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

function assertYldVaultAsset(address: unknown, field: string, asset: string, label: string): asserts address is `0x${string}` {
  assertYldVault(address, field);
  const vault = getIntentVault(address);
  if (vault?.assetAddress.toLowerCase() !== asset.toLowerCase()) {
    failValidation(`${field} must be a ${label}-backed YLD vault`);
  }
}

function assertPlainTokenSwap(request: Record<string, unknown>): asserts request is PlainTokenSwapIntentRequest {
  assertBaseIntentFields(request);
  assertLiquidTokenAddress(request.tokenIn, "tokenIn");
  assertLiquidTokenAddress(request.tokenOut, "tokenOut");
  if (normalizeAddress(request.tokenIn) === normalizeAddress(request.tokenOut)) {
    failValidation("tokenIn and tokenOut must be different");
  }
}

function assertYldVaultZapIn(request: Record<string, unknown>): asserts request is YldVaultZapInIntentRequest {
  assertBaseIntentFields(request);
  assertLiquidTokenAddress(request.inputToken, "inputToken");
  assertStandardYldVault(request.vaultAddress, "vaultAddress");
}

function assertYldVaultZapOut(request: Record<string, unknown>): asserts request is YldVaultZapOutIntentRequest {
  assertBaseIntentFields(request);
  assertStandardYldVault(request.vaultAddress, "vaultAddress");
  assertLiquidTokenAddress(request.outputToken, "outputToken");
}

function assertYldVaultToVault(request: Record<string, unknown>): asserts request is YldVaultToVaultIntentRequest {
  assertBaseIntentFields(request);
  assertStandardYldVault(request.sourceVault, "sourceVault");
  assertStandardYldVault(request.targetVault, "targetVault");
  if (normalizeAddress(request.sourceVault) === normalizeAddress(request.targetVault)) {
    failValidation("sourceVault and targetVault must be different");
  }
}

function assertSpecialYldVaultToVault(request: Record<string, unknown>): asserts request is SpecialYldVaultToVaultIntentRequest {
  assertBaseIntentFields(request, { requireSlippage: true });
  assertYldVault(request.sourceVault, "sourceVault");
  assertYldVault(request.targetVault, "targetVault");
  if (normalizeAddress(request.sourceVault) === normalizeAddress(request.targetVault)) {
    failValidation("sourceVault and targetVault must be different");
  }

  const expectedIntent = getVaultToVaultIntentName(request.sourceVault, request.targetVault);
  if (expectedIntent !== request.intent) {
    failValidation(`${String(request.intent)} does not match the source and target vault assets`);
  }
}

function assertSpecialYldVaultZapIn(request: Record<string, unknown>): asserts request is SpecialYldVaultZapInIntentRequest {
  assertBaseIntentFields(request, { requireSlippage: true });
  assertLiquidTokenAddress(request.inputToken, "inputToken");

  if (request.intent === "cvgCvxZapIn") {
    assertYldVaultAsset(request.vaultAddress, "vaultAddress", TOKENS.CVGCVX, "cvgCVX");
    return;
  }

  assertYldVaultAsset(request.vaultAddress, "vaultAddress", TOKENS.PXCVX, "pxCVX");
}

function assertSpecialYldVaultZapOut(request: Record<string, unknown>): asserts request is SpecialYldVaultZapOutIntentRequest {
  assertBaseIntentFields(request, { requireSlippage: true });
  assertLiquidTokenAddress(request.outputToken, "outputToken");

  if (request.intent === "cvgCvxZapOut") {
    assertYldVaultAsset(request.vaultAddress, "vaultAddress", TOKENS.CVGCVX, "cvgCVX");
    return;
  }

  assertYldVaultAsset(request.vaultAddress, "vaultAddress", TOKENS.PXCVX, "pxCVX");
}

export function assertValidEnsoIntentRequest(value: unknown): asserts value is EnsoIntentRequest {
  if (!isRecord(value)) {
    failValidation("Intent request body must be an object");
  }

  assertNoForbiddenFields(value, FORBIDDEN_INTENT_FIELDS);

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
    case "yldVaultToCvgCvxVault":
    case "cvgCvxVaultToYldVault":
    case "yldVaultToPxCvxVault":
    case "pxCvxVaultToYldVault":
      assertOnlyIntentFields(value, ["sourceVault", "targetVault"]);
      assertSpecialYldVaultToVault(value);
      return;
    case "cvgCvxZapIn":
    case "pxCvxZapIn":
      assertOnlyIntentFields(value, ["inputToken", "vaultAddress"]);
      assertSpecialYldVaultZapIn(value);
      return;
    case "cvgCvxZapOut":
    case "pxCvxZapOut":
      assertOnlyIntentFields(value, ["vaultAddress", "outputToken"]);
      assertSpecialYldVaultZapOut(value);
      return;
    default:
      failValidation("Unknown Enso intent");
  }
}

export function assertEnsoIntentTxTarget(
  intent: EnsoIntentName,
  response: EnsoIntentResponse
): void;
export function assertEnsoIntentTxTarget(response: EnsoIntentResponse): void;
export function assertEnsoIntentTxTarget(
  intentOrResponse: EnsoIntentName | EnsoIntentResponse,
  maybeResponse?: EnsoIntentResponse
): void {
  const intent = typeof intentOrResponse === "string" ? intentOrResponse : "plainTokenSwap";
  const response = typeof intentOrResponse === "string" ? maybeResponse : intentOrResponse;
  if (!response) {
    failValidation("Enso intent response is required");
  }

  assertEnsoIntentTxTargetForIntent({
    intent,
    response,
    allowedTargets: INTENT_TX_TARGET_ALLOWLIST,
    forbiddenTargets: [ENSO_SHORTCUTS],
  });
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
