import {
  CURVE_CONTROLLERS,
  getExternalVaultConfig,
  getVaultByAddress,
  TOKENS,
  type VaultConfig,
} from "@/config/vaults";
import type {
  EnsoBundleResponse,
  EnsoRouteResponse,
  LegacyMorphoPermitRequest,
} from "@/types/enso";
import {
  ENSO_ROUTER_V2,
  ENSO_SHORTCUTS,
  LEGACY_MORPHO,
  MORPHO_GENERAL_ADAPTER1,
  MORPHO_BUNDLER3,
  MORPHO_TOKEN,
} from "@/lib/enso-addresses";
import { CRVUSD_ADDRESS } from "@/config/addresses";
import {
  EMPTY_CALLDATA_SELECTOR,
  ENSO_ROUTE_MULTI_SELECTOR,
  ENSO_ROUTE_SINGLE_SELECTOR,
  ZERO_ADDRESS,
  assertAddress,
  assertBaseIntentFields,
  assertEnsoIntentResponseShape,
  assertEnsoIntentTxTargetForIntent,
  assertNoForbiddenFields,
  assertOnlyFields,
  assertPositiveAmount,
  assertTokenAddress,
  failResponse,
  failValidation,
  isRecord,
  normalizeAddress,
} from "@/lib/enso-intent-validation";
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  parseAbiParameters,
  type Hex,
} from "viem";

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
  | "pxCvxZapOut"
  | "externalVaultZapInToYld"
  | "anyToExternalVault"
  | "yldVaultToExternalVault"
  | "yldVaultToIlliquid"
  | "specialTokenToExternalVault"
  | "specialTokenToIlliquid"
  | "externalVaultToAny"
  | "illiquidToAny"
  | "anyToIlliquid"
  | "legacyMorphoWrap"
  | "legacyMorphoZapIn"
  | "curveLendingRepay"
  | "curveLendingRepayWithSwap";

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

export type ExternalVaultZapInToYldIntentRequest = BaseIntentRequest & {
  intent: "externalVaultZapInToYld";
  externalVaultAddress: string;
  vaultAddress: string;
};

export type AnyToExternalVaultIntentRequest = BaseIntentRequest & {
  intent: "anyToExternalVault";
  inputToken: string;
  externalVaultAddress: string;
};

export type YldVaultToExternalVaultIntentRequest = BaseIntentRequest & {
  intent: "yldVaultToExternalVault";
  sourceVault: string;
  targetVault: string;
};

export type YldVaultToIlliquidIntentRequest = BaseIntentRequest & {
  intent: "yldVaultToIlliquid";
  sourceVault: string;
  outputToken: string;
};

export type SpecialTokenToExternalVaultIntentRequest = BaseIntentRequest & {
  intent: "specialTokenToExternalVault";
  inputToken: string;
  outputVault: string;
};

export type SpecialTokenToIlliquidIntentRequest = BaseIntentRequest & {
  intent: "specialTokenToIlliquid";
  inputToken: string;
  outputToken: string;
};

export type ExternalVaultToAnyIntentRequest = BaseIntentRequest & {
  intent: "externalVaultToAny";
  externalVaultAddress: string;
  outputToken: string;
};

export type IlliquidToAnyIntentRequest = BaseIntentRequest & {
  intent: "illiquidToAny";
  inputToken: string;
  outputToken: string;
};

export type AnyToIlliquidIntentRequest = BaseIntentRequest & {
  intent: "anyToIlliquid";
  inputToken: string;
  outputToken: string;
};

export type LegacyMorphoWrapIntentRequest = BaseIntentRequest & {
  intent: "legacyMorphoWrap";
  outputToken: string;
};

export type LegacyMorphoZapInIntentRequest = BaseIntentRequest & {
  intent: "legacyMorphoZapIn";
  vaultAddress: string;
};

export type CurveLendingRepayIntentRequest = BaseIntentRequest & {
  intent: "curveLendingRepay";
  vaultAddress: string;
};

export type CurveLendingRepayWithSwapIntentRequest = BaseIntentRequest & {
  intent: "curveLendingRepayWithSwap";
  vaultAddress: string;
  tokenIn: string;
  inSoftLiquidation?: boolean;
  closeLoan?: boolean;
  maxRepayAmount?: string;
};

export type EnsoIntentRequest =
  | PlainTokenSwapIntentRequest
  | YldVaultZapInIntentRequest
  | YldVaultZapOutIntentRequest
  | YldVaultToVaultIntentRequest
  | SpecialYldVaultToVaultIntentRequest
  | SpecialYldVaultZapInIntentRequest
  | SpecialYldVaultZapOutIntentRequest
  | ExternalVaultZapInToYldIntentRequest
  | AnyToExternalVaultIntentRequest
  | YldVaultToExternalVaultIntentRequest
  | YldVaultToIlliquidIntentRequest
  | SpecialTokenToExternalVaultIntentRequest
  | SpecialTokenToIlliquidIntentRequest
  | ExternalVaultToAnyIntentRequest
  | IlliquidToAnyIntentRequest
  | AnyToIlliquidIntentRequest
  | LegacyMorphoWrapIntentRequest
  | LegacyMorphoZapInIntentRequest
  | CurveLendingRepayIntentRequest
  | CurveLendingRepayWithSwapIntentRequest;

export type YldVaultToVaultIntentName =
  | YldVaultToVaultIntentRequest["intent"]
  | SpecialYldVaultToVaultIntentRequest["intent"];

export type EnsoIntentResponse = EnsoRouteResponse | EnsoBundleResponse;

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
const SPECIAL_INPUT_TOKENS = new Set([
  TOKENS.CVGCVX.toLowerCase(),
  TOKENS.PXCVX.toLowerCase(),
  TOKENS.LPXCVX.toLowerCase(),
]);
const COMMON_INTENT_TX_TARGETS = [ENSO_ROUTER_V2] as const;
const COMMON_INTENT_CALLDATA_SELECTORS = [ENSO_ROUTE_SINGLE_SELECTOR] as const;
const SERVER_BUNDLE_CALLDATA_SELECTORS = [
  ENSO_ROUTE_SINGLE_SELECTOR,
  ENSO_ROUTE_MULTI_SELECTOR,
] as const;
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
  externalVaultZapInToYld: COMMON_INTENT_TX_TARGETS,
  anyToExternalVault: COMMON_INTENT_TX_TARGETS,
  yldVaultToExternalVault: COMMON_INTENT_TX_TARGETS,
  yldVaultToIlliquid: COMMON_INTENT_TX_TARGETS,
  specialTokenToExternalVault: COMMON_INTENT_TX_TARGETS,
  specialTokenToIlliquid: COMMON_INTENT_TX_TARGETS,
  externalVaultToAny: COMMON_INTENT_TX_TARGETS,
  illiquidToAny: COMMON_INTENT_TX_TARGETS,
  anyToIlliquid: COMMON_INTENT_TX_TARGETS,
  legacyMorphoWrap: [MORPHO_BUNDLER3],
  legacyMorphoZapIn: [MORPHO_BUNDLER3],
  curveLendingRepay: COMMON_INTENT_TX_TARGETS,
  curveLendingRepayWithSwap: COMMON_INTENT_TX_TARGETS,
};
const INTENT_CALLDATA_SELECTOR_ALLOWLIST: Record<EnsoIntentName, readonly `0x${string}`[]> = {
  plainTokenSwap: COMMON_INTENT_CALLDATA_SELECTORS,
  yldVaultZapIn: COMMON_INTENT_CALLDATA_SELECTORS,
  yldVaultZapOut: COMMON_INTENT_CALLDATA_SELECTORS,
  yldVaultToVault: COMMON_INTENT_CALLDATA_SELECTORS,
  yldVaultToCvgCvxVault: COMMON_INTENT_CALLDATA_SELECTORS,
  cvgCvxVaultToYldVault: COMMON_INTENT_CALLDATA_SELECTORS,
  yldVaultToPxCvxVault: COMMON_INTENT_CALLDATA_SELECTORS,
  pxCvxVaultToYldVault: COMMON_INTENT_CALLDATA_SELECTORS,
  cvgCvxZapIn: COMMON_INTENT_CALLDATA_SELECTORS,
  cvgCvxZapOut: COMMON_INTENT_CALLDATA_SELECTORS,
  pxCvxZapIn: COMMON_INTENT_CALLDATA_SELECTORS,
  pxCvxZapOut: COMMON_INTENT_CALLDATA_SELECTORS,
  externalVaultZapInToYld: COMMON_INTENT_CALLDATA_SELECTORS,
  anyToExternalVault: COMMON_INTENT_CALLDATA_SELECTORS,
  yldVaultToExternalVault: SERVER_BUNDLE_CALLDATA_SELECTORS,
  yldVaultToIlliquid: SERVER_BUNDLE_CALLDATA_SELECTORS,
  specialTokenToExternalVault: SERVER_BUNDLE_CALLDATA_SELECTORS,
  specialTokenToIlliquid: SERVER_BUNDLE_CALLDATA_SELECTORS,
  externalVaultToAny: SERVER_BUNDLE_CALLDATA_SELECTORS,
  illiquidToAny: SERVER_BUNDLE_CALLDATA_SELECTORS,
  anyToIlliquid: SERVER_BUNDLE_CALLDATA_SELECTORS,
  legacyMorphoWrap: [EMPTY_CALLDATA_SELECTOR],
  legacyMorphoZapIn: [EMPTY_CALLDATA_SELECTOR],
  curveLendingRepay: SERVER_BUNDLE_CALLDATA_SELECTORS,
  curveLendingRepayWithSwap: SERVER_BUNDLE_CALLDATA_SELECTORS,
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

function assertPlainLiquidTokenAddress(
  value: unknown,
  field: string
): asserts value is `0x${string}` {
  assertLiquidTokenAddress(value, field);
  if (getExternalVaultConfig(value)) {
    failValidation(`${field} must be a liquid token, not an external vault`);
  }
  if (SPECIAL_INPUT_TOKENS.has(normalizeAddress(value))) {
    failValidation(`${field} must be a liquid token, not a supported illiquid token`);
  }
  if (normalizeAddress(value) === LEGACY_MORPHO.toLowerCase()) {
    failValidation(`${field} must use a legacy MORPHO intent`);
  }
}

function assertSupportedIlliquidToken(
  value: unknown,
  field: string
): asserts value is `0x${string}` {
  assertAddress(value, field);
  if (!SPECIAL_INPUT_TOKENS.has(normalizeAddress(value))) {
    failValidation(`${field} must be pxCVX, cvgCVX, or lpxCVX`);
  }
}

function assertExternalVaultToken(
  value: unknown,
  field: string
): asserts value is `0x${string}` {
  assertAddress(value, field);
  if (!getExternalVaultConfig(value)) {
    failValidation(`${field} must be a known external vault`);
  }
}

function assertSpecialInputToken(
  value: unknown,
  field: string
): asserts value is `0x${string}` {
  assertAddress(value, field);
  if (!getExternalVaultConfig(value) && !SPECIAL_INPUT_TOKENS.has(normalizeAddress(value))) {
    failValidation(`${field} must be a known external vault or supported illiquid token`);
  }
}

function assertOptionalBoolean(value: unknown, field: string) {
  if (value !== undefined && typeof value !== "boolean") {
    failValidation(`${field} must be a boolean`);
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

function assertExternalVaultZapInToYld(request: Record<string, unknown>): asserts request is ExternalVaultZapInToYldIntentRequest {
  assertBaseIntentFields(request, { requireSlippage: true });
  assertYldVault(request.vaultAddress, "vaultAddress");
  assertAddress(request.externalVaultAddress, "externalVaultAddress");

  if (!getExternalVaultConfig(request.externalVaultAddress)) {
    failValidation("externalVaultAddress must be a known external vault");
  }
}

function assertAnyToExternalVault(request: Record<string, unknown>): asserts request is AnyToExternalVaultIntentRequest {
  assertBaseIntentFields(request, { requireSlippage: true });
  assertLiquidTokenAddress(request.inputToken, "inputToken");
  assertAddress(request.externalVaultAddress, "externalVaultAddress");

  if (getExternalVaultConfig(request.inputToken)) {
    failValidation("inputToken must be a liquid token, not an external vault");
  }
  if (SPECIAL_INPUT_TOKENS.has(normalizeAddress(request.inputToken))) {
    failValidation("inputToken must use the specialTokenToExternalVault intent");
  }
  if (normalizeAddress(request.inputToken) === LEGACY_MORPHO.toLowerCase()) {
    failValidation("inputToken must use a legacy MORPHO intent");
  }
  if (!getExternalVaultConfig(request.externalVaultAddress)) {
    failValidation("externalVaultAddress must be a known external vault");
  }
}

function assertYldVaultToExternalVault(request: Record<string, unknown>): asserts request is YldVaultToExternalVaultIntentRequest {
  assertBaseIntentFields(request, { requireSlippage: true });
  assertYldVault(request.sourceVault, "sourceVault");
  assertExternalVaultToken(request.targetVault, "targetVault");
}

function assertYldVaultToIlliquid(request: Record<string, unknown>): asserts request is YldVaultToIlliquidIntentRequest {
  assertBaseIntentFields(request, { requireSlippage: true });
  assertYldVault(request.sourceVault, "sourceVault");
  assertSupportedIlliquidToken(request.outputToken, "outputToken");
}

function assertSpecialTokenToExternalVault(request: Record<string, unknown>): asserts request is SpecialTokenToExternalVaultIntentRequest {
  assertBaseIntentFields(request, { requireSlippage: true });
  assertSpecialInputToken(request.inputToken, "inputToken");
  assertExternalVaultToken(request.outputVault, "outputVault");
  if (normalizeAddress(request.inputToken) === normalizeAddress(request.outputVault)) {
    failValidation("inputToken and outputVault must be different");
  }
}

function assertSpecialTokenToIlliquid(request: Record<string, unknown>): asserts request is SpecialTokenToIlliquidIntentRequest {
  assertBaseIntentFields(request, { requireSlippage: true });
  assertSpecialInputToken(request.inputToken, "inputToken");
  assertSupportedIlliquidToken(request.outputToken, "outputToken");
  if (normalizeAddress(request.inputToken) === normalizeAddress(request.outputToken)) {
    failValidation("inputToken and outputToken must be different");
  }
}

function assertExternalVaultToAny(request: Record<string, unknown>): asserts request is ExternalVaultToAnyIntentRequest {
  assertBaseIntentFields(request, { requireSlippage: true });
  assertExternalVaultToken(request.externalVaultAddress, "externalVaultAddress");
  assertPlainLiquidTokenAddress(request.outputToken, "outputToken");
}

function assertIlliquidToAny(request: Record<string, unknown>): asserts request is IlliquidToAnyIntentRequest {
  assertBaseIntentFields(request, { requireSlippage: true });
  assertSupportedIlliquidToken(request.inputToken, "inputToken");
  assertPlainLiquidTokenAddress(request.outputToken, "outputToken");
}

function assertAnyToIlliquid(request: Record<string, unknown>): asserts request is AnyToIlliquidIntentRequest {
  assertBaseIntentFields(request, { requireSlippage: true });
  assertPlainLiquidTokenAddress(request.inputToken, "inputToken");
  assertSupportedIlliquidToken(request.outputToken, "outputToken");
}

function assertLegacyMorphoWrap(request: Record<string, unknown>): asserts request is LegacyMorphoWrapIntentRequest {
  assertBaseIntentFields(request, { requireSlippage: true });
  assertPlainLiquidTokenAddress(request.outputToken, "outputToken");
  if (normalizeAddress(request.outputToken) === LEGACY_MORPHO.toLowerCase()) {
    failValidation("outputToken must be different from Legacy MORPHO");
  }
}

function assertLegacyMorphoZapIn(request: Record<string, unknown>): asserts request is LegacyMorphoZapInIntentRequest {
  assertBaseIntentFields(request, { requireSlippage: true });
  assertYldVault(request.vaultAddress, "vaultAddress");
}

function assertCurveLendingVault(value: unknown, field: string): asserts value is `0x${string}` {
  assertAddress(value, field);
  const normalized = normalizeAddress(value);
  const known = Object.keys(CURVE_CONTROLLERS).some(
    (address) => normalizeAddress(address) === normalized,
  );
  if (!known) {
    failValidation(`${field} must be a Curve lending collateral vault`);
  }
}

function assertCurveLendingRepay(request: Record<string, unknown>): asserts request is CurveLendingRepayIntentRequest {
  assertBaseIntentFields(request);
  assertCurveLendingVault(request.vaultAddress, "vaultAddress");
}

function assertCurveLendingRepayWithSwap(request: Record<string, unknown>): asserts request is CurveLendingRepayWithSwapIntentRequest {
  assertBaseIntentFields(request, { requireSlippage: true });
  assertCurveLendingVault(request.vaultAddress, "vaultAddress");
  assertTokenAddress(request.tokenIn, "tokenIn");
  assertOptionalBoolean(request.inSoftLiquidation, "inSoftLiquidation");
  assertOptionalBoolean(request.closeLoan, "closeLoan");
  if (request.maxRepayAmount !== undefined) {
    if (request.closeLoan !== true) {
      failValidation("maxRepayAmount requires closeLoan");
    }
    assertPositiveAmount(request.maxRepayAmount);
  }
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
    case "externalVaultZapInToYld":
      assertOnlyIntentFields(value, ["externalVaultAddress", "vaultAddress"]);
      assertExternalVaultZapInToYld(value);
      return;
    case "anyToExternalVault":
      assertOnlyIntentFields(value, ["inputToken", "externalVaultAddress"]);
      assertAnyToExternalVault(value);
      return;
    case "yldVaultToExternalVault":
      assertOnlyIntentFields(value, ["sourceVault", "targetVault"]);
      assertYldVaultToExternalVault(value);
      return;
    case "yldVaultToIlliquid":
      assertOnlyIntentFields(value, ["sourceVault", "outputToken"]);
      assertYldVaultToIlliquid(value);
      return;
    case "specialTokenToExternalVault":
      assertOnlyIntentFields(value, ["inputToken", "outputVault"]);
      assertSpecialTokenToExternalVault(value);
      return;
    case "specialTokenToIlliquid":
      assertOnlyIntentFields(value, ["inputToken", "outputToken"]);
      assertSpecialTokenToIlliquid(value);
      return;
    case "externalVaultToAny":
      assertOnlyIntentFields(value, ["externalVaultAddress", "outputToken"]);
      assertExternalVaultToAny(value);
      return;
    case "illiquidToAny":
      assertOnlyIntentFields(value, ["inputToken", "outputToken"]);
      assertIlliquidToAny(value);
      return;
    case "anyToIlliquid":
      assertOnlyIntentFields(value, ["inputToken", "outputToken"]);
      assertAnyToIlliquid(value);
      return;
    case "legacyMorphoWrap":
      assertOnlyIntentFields(value, ["outputToken"]);
      assertLegacyMorphoWrap(value);
      return;
    case "legacyMorphoZapIn":
      assertOnlyIntentFields(value, ["vaultAddress"]);
      assertLegacyMorphoZapIn(value);
      return;
    case "curveLendingRepay":
      assertOnlyIntentFields(value, ["vaultAddress"]);
      assertCurveLendingRepay(value);
      return;
    case "curveLendingRepayWithSwap":
      assertOnlyIntentFields(value, [
        "vaultAddress",
        "tokenIn",
        "inSoftLiquidation",
        "closeLoan",
        "maxRepayAmount",
      ]);
      assertCurveLendingRepayWithSwap(value);
      return;
    default:
      failValidation("Unknown Enso intent");
  }
}

export function assertEnsoIntentTxTarget(
  intent: EnsoIntentName,
  response: EnsoIntentResponse
): void;
export function assertEnsoIntentTxTarget(
  intent: EnsoIntentName,
  response: EnsoIntentResponse
): void {
  if (!response) {
    failValidation("Enso intent response is required");
  }

  assertEnsoIntentTxTargetForIntent({
    intent,
    response,
    allowedTargets: INTENT_TX_TARGET_ALLOWLIST,
    allowedSelectors: INTENT_CALLDATA_SELECTOR_ALLOWLIST,
    forbiddenTargets: [ENSO_SHORTCUTS],
    forbiddenSelectors: [ENSO_ROUTE_MULTI_SELECTOR],
  });
}

const ENSO_NATIVE_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
// IEnsoRouter.TokenType: Native, ERC20, ERC721, ERC1155.
const TOKEN_TYPE_NATIVE = 0;
const TOKEN_TYPE_ERC20 = 1;
const DEFAULT_SLIPPAGE_BPS = 100n;
const BPS_DENOMINATOR = 10_000n;
const ZERO_CALLBACK_HASH = `0x${"00".repeat(32)}` as Hex;

const ENSO_ROUTER_PROTECTION_ABI = parseAbi([
  "function routeSingle((uint8 tokenType, bytes data) tokenIn, bytes data) payable returns (bytes)",
  "function routeMulti((uint8 tokenType, bytes data)[] tokensIn, bytes data) payable returns (bytes)",
  "function safeRouteSingle((uint8 tokenType, bytes data) tokenIn, (uint8 tokenType, bytes data) tokenOut, address receiver, bytes data) payable returns (bytes)",
  "function safeRouteMulti((uint8 tokenType, bytes data)[] tokensIn, (uint8 tokenType, bytes data)[] tokensOut, address receiver, bytes data) payable returns (bytes)",
]);
const ERC20_AMOUNT_PARAMETERS = parseAbiParameters("address token, uint256 amount");
const NATIVE_AMOUNT_PARAMETERS = parseAbiParameters("uint256 amount");
const MORPHO_ADAPTER_PROTECTION_ABI = parseAbi([
  "function erc20TransferFrom(address token, address receiver, uint256 amount)",
  "function morphoWrapperDepositFor(address receiver, uint256 amount)",
]);

type RouterToken = {
  tokenType: number;
  data: Hex;
};

type DecodedRawRoute = {
  kind: "single" | "multi";
  tokensIn: RouterToken[];
  innerData: Hex;
};

type DecodedSafeRoute = {
  kind: "single" | "multi";
  tokensIn: RouterToken[];
  tokensOut: RouterToken[];
  receiver: string;
  innerData: Hex;
};

function asRouterToken(value: unknown, field: string): RouterToken {
  if (!isRecord(value) || typeof value.tokenType !== "number" || typeof value.data !== "string") {
    failResponse(`${field} is malformed`);
  }
  if (!/^0x(?:[a-fA-F0-9]{2})*$/.test(value.data)) {
    failResponse(`${field}.data must be hex calldata`);
  }
  return { tokenType: value.tokenType, data: value.data as Hex };
}

function asRouterTokens(value: unknown, field: string): RouterToken[] {
  if (!Array.isArray(value)) {
    failResponse(`${field} must be an array`);
  }
  return value.map((token, index) => asRouterToken(token, `${field}[${index}]`));
}

function assertInnerData(value: unknown): asserts value is Hex {
  if (typeof value !== "string" || !/^0x(?:[a-fA-F0-9]{2})+$/.test(value)) {
    failResponse("Enso intent returned empty or malformed inner router calldata");
  }
}

function decodeRawRoute(data: string): DecodedRawRoute {
  let decoded: ReturnType<typeof decodeFunctionData>;
  try {
    decoded = decodeFunctionData({
      abi: ENSO_ROUTER_PROTECTION_ABI,
      data: data as Hex,
    });
  } catch {
    failResponse("Enso intent returned undecodable router calldata");
  }

  if (decoded.functionName === "routeSingle") {
    const [tokenIn, innerData] = decoded.args;
    assertInnerData(innerData);
    return {
      kind: "single",
      tokensIn: [asRouterToken(tokenIn, "tokenIn")],
      innerData,
    };
  }
  if (decoded.functionName === "routeMulti") {
    const [tokensIn, innerData] = decoded.args;
    assertInnerData(innerData);
    return {
      kind: "multi",
      tokensIn: asRouterTokens(tokensIn, "tokensIn"),
      innerData,
    };
  }
  failResponse("Enso intent must return an unprotected route entrypoint before wrapping");
}

function decodeSafeRoute(data: string): DecodedSafeRoute {
  let decoded: ReturnType<typeof decodeFunctionData>;
  try {
    decoded = decodeFunctionData({
      abi: ENSO_ROUTER_PROTECTION_ABI,
      data: data as Hex,
    });
  } catch {
    failResponse("Enso intent returned undecodable protected router calldata");
  }

  if (decoded.functionName === "safeRouteSingle") {
    const [tokenIn, tokenOut, receiver, innerData] = decoded.args;
    assertInnerData(innerData);
    if (typeof receiver !== "string") failResponse("Protected Enso receiver is malformed");
    return {
      kind: "single",
      tokensIn: [asRouterToken(tokenIn, "tokenIn")],
      tokensOut: [asRouterToken(tokenOut, "tokenOut")],
      receiver,
      innerData,
    };
  }
  if (decoded.functionName === "safeRouteMulti") {
    const [tokensIn, tokensOut, receiver, innerData] = decoded.args;
    assertInnerData(innerData);
    if (typeof receiver !== "string") failResponse("Protected Enso receiver is malformed");
    return {
      kind: "multi",
      tokensIn: asRouterTokens(tokensIn, "tokensIn"),
      tokensOut: asRouterTokens(tokensOut, "tokensOut"),
      receiver,
      innerData,
    };
  }
  failResponse("Enso intent returned an unprotected router entrypoint");
}

function getIntentInputToken(request: EnsoIntentRequest): string {
  switch (request.intent) {
    case "plainTokenSwap":
      return request.tokenIn;
    case "yldVaultZapIn":
    case "cvgCvxZapIn":
    case "pxCvxZapIn":
      return request.inputToken;
    case "yldVaultZapOut":
    case "cvgCvxZapOut":
    case "pxCvxZapOut":
      return request.vaultAddress;
    case "yldVaultToVault":
    case "yldVaultToCvgCvxVault":
    case "cvgCvxVaultToYldVault":
    case "yldVaultToPxCvxVault":
    case "pxCvxVaultToYldVault":
    case "yldVaultToExternalVault":
    case "yldVaultToIlliquid":
      return request.sourceVault;
    case "externalVaultZapInToYld":
    case "externalVaultToAny":
      return request.externalVaultAddress;
    case "anyToExternalVault":
    case "specialTokenToExternalVault":
    case "specialTokenToIlliquid":
    case "illiquidToAny":
    case "anyToIlliquid":
      return request.inputToken;
    case "legacyMorphoWrap":
    case "legacyMorphoZapIn":
      return LEGACY_MORPHO;
    case "curveLendingRepay":
      return CRVUSD_ADDRESS;
    case "curveLendingRepayWithSwap":
      return request.tokenIn;
  }
}

function getIntentOutputToken(request: EnsoIntentRequest): string | undefined {
  switch (request.intent) {
    case "plainTokenSwap":
      return request.tokenOut;
    case "yldVaultZapIn":
    case "cvgCvxZapIn":
    case "pxCvxZapIn":
    case "externalVaultZapInToYld":
    case "legacyMorphoZapIn":
      return request.vaultAddress;
    case "yldVaultZapOut":
    case "cvgCvxZapOut":
    case "pxCvxZapOut":
    case "yldVaultToIlliquid":
    case "specialTokenToIlliquid":
    case "externalVaultToAny":
    case "illiquidToAny":
    case "anyToIlliquid":
    case "legacyMorphoWrap":
      return request.outputToken;
    case "yldVaultToVault":
    case "yldVaultToCvgCvxVault":
    case "cvgCvxVaultToYldVault":
    case "yldVaultToPxCvxVault":
    case "pxCvxVaultToYldVault":
    case "yldVaultToExternalVault":
      return request.targetVault;
    case "anyToExternalVault":
      return request.externalVaultAddress;
    case "specialTokenToExternalVault":
      return request.outputVault;
    case "curveLendingRepay":
    case "curveLendingRepayWithSwap":
      return undefined;
  }
}

function findTokenAmount(amounts: Record<string, string> | undefined, token: string): string | undefined {
  if (!amounts) return undefined;
  const tokenKey = normalizeAddress(token);
  return Object.entries(amounts).find(([address]) => normalizeAddress(address) === tokenKey)?.[1];
}

function getExpectedOutputAmount(response: EnsoIntentResponse, outputToken: string): bigint {
  const amount = "amountOut" in response
    ? response.amountOut
    : findTokenAmount(response.amountsOut, outputToken);
  if (amount === undefined || !/^\d+$/.test(amount)) {
    failResponse("Enso intent did not quote the requested final output token");
  }
  const parsed = BigInt(amount);
  if (parsed <= 0n) {
    failResponse("Enso intent returned a zero final output quote");
  }
  return parsed;
}

function getMinimumOutputAmount(
  request: EnsoIntentRequest,
  response: EnsoIntentResponse,
  outputToken: string
): bigint {
  const expected = getExpectedOutputAmount(response, outputToken);
  const quotedMinimum = "minAmountOut" in response
    ? response.minAmountOut
    : "minAmountsOut" in response
      ? findTokenAmount(response.minAmountsOut, outputToken)
      : undefined;
  const configuredMinimum = expected
    * (BPS_DENOMINATOR - BigInt(request.slippage ?? DEFAULT_SLIPPAGE_BPS))
    / BPS_DENOMINATOR;
  const quotedMinimumValue = quotedMinimum === undefined ? 0n : BigInt(quotedMinimum);
  const minimum = quotedMinimumValue > configuredMinimum
    ? quotedMinimumValue
    : configuredMinimum;

  if (minimum <= 0n || minimum > expected) {
    failResponse("Enso intent returned an invalid minimum output");
  }
  return minimum;
}

function withProtectedMinimum(
  response: EnsoIntentResponse,
  outputToken: string,
  minimum: bigint
): EnsoIntentResponse {
  if ("amountOut" in response) {
    return { ...response, minAmountOut: minimum.toString() };
  }
  return {
    ...response,
    minAmountsOut: {
      ...(response.minAmountsOut ?? {}),
      [normalizeAddress(outputToken)]: minimum.toString(),
    },
  };
}

function assertResponseSender(request: EnsoIntentRequest, response: EnsoIntentResponse) {
  if ("from" in response.tx && normalizeAddress(response.tx.from) !== normalizeAddress(request.fromAddress)) {
    failResponse("Enso intent returned a transaction for a different sender");
  }
}

function assertBoundInput(
  request: EnsoIntentRequest,
  tokensIn: RouterToken[],
  txValue: string
) {
  if (tokensIn.length !== 1) {
    failResponse("Enso intent must pull exactly one bound input token");
  }

  const tokenIn = tokensIn[0];
  const expectedToken = getIntentInputToken(request);
  const expectedAmount = BigInt(request.amountIn);
  if (normalizeAddress(expectedToken) === ENSO_NATIVE_TOKEN) {
    if (tokenIn.tokenType !== TOKEN_TYPE_NATIVE || tokenIn.data !== "0x") {
      failResponse("Enso intent native input does not match the request");
    }
    if (BigInt(txValue) !== expectedAmount) {
      failResponse("Enso intent native value does not match amountIn");
    }
    return;
  }

  if (tokenIn.tokenType !== TOKEN_TYPE_ERC20 || BigInt(txValue) !== 0n) {
    failResponse("Enso intent ERC20 input type or value does not match the request");
  }
  let decodedToken: string;
  let decodedAmount: bigint;
  try {
    [decodedToken, decodedAmount] = decodeAbiParameters(ERC20_AMOUNT_PARAMETERS, tokenIn.data);
  } catch {
    failResponse("Enso intent returned malformed ERC20 input data");
  }
  if (
    normalizeAddress(decodedToken) !== normalizeAddress(expectedToken) ||
    decodedAmount !== expectedAmount
  ) {
    failResponse("Enso intent input token or amount does not match the request");
  }
}

function makeBoundOutput(outputToken: string, minimum: bigint): RouterToken {
  if (normalizeAddress(outputToken) === ENSO_NATIVE_TOKEN) {
    return {
      tokenType: TOKEN_TYPE_NATIVE,
      data: encodeAbiParameters(NATIVE_AMOUNT_PARAMETERS, [minimum]),
    };
  }
  return {
    tokenType: TOKEN_TYPE_ERC20,
    data: encodeAbiParameters(ERC20_AMOUNT_PARAMETERS, [outputToken as `0x${string}`, minimum]),
  };
}

function assertBoundOutput(tokenOut: RouterToken, outputToken: string, minimum: bigint) {
  if (normalizeAddress(outputToken) === ENSO_NATIVE_TOKEN) {
    if (tokenOut.tokenType !== TOKEN_TYPE_NATIVE) {
      failResponse("Protected Enso output is not the requested native token");
    }
    let decodedMinimum: bigint;
    try {
      [decodedMinimum] = decodeAbiParameters(NATIVE_AMOUNT_PARAMETERS, tokenOut.data);
    } catch {
      failResponse("Protected Enso native output is malformed");
    }
    if (decodedMinimum !== minimum) {
      failResponse("Protected Enso native minimum output does not match the quote");
    }
    return;
  }

  if (tokenOut.tokenType !== TOKEN_TYPE_ERC20) {
    failResponse("Protected Enso output is not the requested ERC20 token");
  }
  let decodedToken: string;
  let decodedMinimum: bigint;
  try {
    [decodedToken, decodedMinimum] = decodeAbiParameters(ERC20_AMOUNT_PARAMETERS, tokenOut.data);
  } catch {
    failResponse("Protected Enso ERC20 output is malformed");
  }
  if (
    normalizeAddress(decodedToken) !== normalizeAddress(outputToken) ||
    decodedMinimum !== minimum
  ) {
    failResponse("Protected Enso output token or minimum does not match the quote");
  }
}

function getLegacyPermit(response: EnsoIntentResponse): LegacyMorphoPermitRequest {
  const permit = "legacyMorphoPermit" in response ? response.legacyMorphoPermit : undefined;
  if (!isRecord(permit)) {
    failResponse("Legacy MORPHO intent did not return a permit request");
  }
  if (
    typeof permit.token !== "string" ||
    typeof permit.spender !== "string" ||
    typeof permit.amount !== "string" ||
    !/^\d+$/.test(permit.amount) ||
    !Array.isArray(permit.postPermitCalls)
  ) {
    failResponse("Legacy MORPHO intent returned a malformed permit request");
  }
  for (const call of permit.postPermitCalls) {
    if (
      !isRecord(call) ||
      typeof call.to !== "string" ||
      typeof call.data !== "string" ||
      typeof call.value !== "string" ||
      typeof call.skipRevert !== "boolean" ||
      typeof call.callbackHash !== "string" ||
      !/^0x[a-fA-F0-9]{40}$/.test(call.to) ||
      !/^0x(?:[a-fA-F0-9]{2})*$/.test(call.data) ||
      !/^\d+$/.test(call.value) ||
      !/^0x[a-fA-F0-9]{64}$/.test(call.callbackHash)
    ) {
      failResponse("Legacy MORPHO intent returned a malformed post-permit call");
    }
  }
  return permit as unknown as LegacyMorphoPermitRequest;
}

function assertLegacyCallEnvelope(call: {
  value: string;
  skipRevert: boolean;
  callbackHash: string;
}) {
  if (call.value !== "0" || call.skipRevert || call.callbackHash.toLowerCase() !== ZERO_CALLBACK_HASH) {
    failResponse("Legacy MORPHO intent returned an unsafe post-permit call envelope");
  }
}

function assertLegacyMorphoBaseCalls(
  request: LegacyMorphoWrapIntentRequest | LegacyMorphoZapInIntentRequest,
  response: EnsoIntentResponse
) {
  const permit = getLegacyPermit(response);
  if (
    normalizeAddress(permit.token) !== normalizeAddress(LEGACY_MORPHO) ||
    normalizeAddress(permit.spender) !== normalizeAddress(MORPHO_GENERAL_ADAPTER1) ||
    permit.amount !== request.amountIn
  ) {
    failResponse("Legacy MORPHO permit does not match the request");
  }
  if (permit.postPermitCalls.length < 2 || permit.postPermitCalls.length > 3) {
    failResponse("Legacy MORPHO intent returned unexpected post-permit calls");
  }

  const [transferCall, wrapCall] = permit.postPermitCalls;
  for (const call of [transferCall, wrapCall]) {
    assertLegacyCallEnvelope(call);
    if (normalizeAddress(call.to) !== normalizeAddress(MORPHO_GENERAL_ADAPTER1)) {
      failResponse("Legacy MORPHO intent returned an unexpected adapter target");
    }
  }

  let transfer: ReturnType<typeof decodeFunctionData>;
  let wrap: ReturnType<typeof decodeFunctionData>;
  try {
    transfer = decodeFunctionData({ abi: MORPHO_ADAPTER_PROTECTION_ABI, data: transferCall.data as Hex });
    wrap = decodeFunctionData({ abi: MORPHO_ADAPTER_PROTECTION_ABI, data: wrapCall.data as Hex });
  } catch {
    failResponse("Legacy MORPHO intent returned malformed adapter calldata");
  }
  if (transfer.functionName !== "erc20TransferFrom" || wrap.functionName !== "morphoWrapperDepositFor") {
    failResponse("Legacy MORPHO intent returned unexpected adapter calldata");
  }
  const [transferToken, transferReceiver, transferAmount] = transfer.args as readonly [string, string, bigint];
  const [wrapReceiver, wrapAmount] = wrap.args as readonly [string, bigint];
  const expectedWrapReceiver = permit.postPermitCalls.length === 3 ? ENSO_SHORTCUTS : request.fromAddress;
  if (
    normalizeAddress(transferToken) !== normalizeAddress(LEGACY_MORPHO) ||
    normalizeAddress(transferReceiver) !== normalizeAddress(MORPHO_GENERAL_ADAPTER1) ||
    transferAmount !== BigInt(request.amountIn) ||
    normalizeAddress(wrapReceiver) !== normalizeAddress(expectedWrapReceiver) ||
    wrapAmount !== BigInt(request.amountIn)
  ) {
    failResponse("Legacy MORPHO adapter calls do not match the request");
  }
  return permit;
}

function protectLegacyMorphoResponse(
  request: LegacyMorphoWrapIntentRequest | LegacyMorphoZapInIntentRequest,
  response: EnsoIntentResponse
): EnsoIntentResponse {
  const permit = assertLegacyMorphoBaseCalls(request, response);
  const outputToken = getIntentOutputToken(request)!;
  const expected = getExpectedOutputAmount(response, outputToken);
  const routeCall = permit.postPermitCalls[2];

  if (!routeCall) {
    if (normalizeAddress(outputToken) !== normalizeAddress(MORPHO_TOKEN) || expected !== BigInt(request.amountIn)) {
      failResponse("Legacy MORPHO wrap-only response does not match the requested 1:1 output");
    }
    return response;
  }

  assertLegacyCallEnvelope(routeCall);
  if (normalizeAddress(routeCall.to) !== normalizeAddress(ENSO_ROUTER_V2)) {
    failResponse("Legacy MORPHO intent returned an unexpected nested router target");
  }
  const rawRoute = decodeRawRoute(routeCall.data);
  if (rawRoute.kind !== "multi" || rawRoute.tokensIn.length !== 0) {
    failResponse("Legacy MORPHO nested route must consume the token already held by Shortcuts");
  }
  const minimum = getMinimumOutputAmount(request, response, outputToken);
  const protectedResponse = withProtectedMinimum(response, outputToken, minimum);
  const safeData = encodeFunctionData({
    abi: ENSO_ROUTER_PROTECTION_ABI,
    functionName: "safeRouteMulti",
    args: [[], [makeBoundOutput(outputToken, minimum)], request.fromAddress as `0x${string}`, rawRoute.innerData],
  });
  const protectedPermit = {
    ...permit,
    postPermitCalls: permit.postPermitCalls.map((call, index) =>
      index === 2 ? { ...call, data: safeData } : call
    ),
  };
  return { ...protectedResponse, legacyMorphoPermit: protectedPermit } as EnsoIntentResponse;
}

function assertProtectedLegacyMorphoResponse(
  request: LegacyMorphoWrapIntentRequest | LegacyMorphoZapInIntentRequest,
  response: EnsoIntentResponse
) {
  const permit = assertLegacyMorphoBaseCalls(request, response);
  const outputToken = getIntentOutputToken(request)!;
  const expected = getExpectedOutputAmount(response, outputToken);
  const routeCall = permit.postPermitCalls[2];
  if (!routeCall) {
    if (normalizeAddress(outputToken) !== normalizeAddress(MORPHO_TOKEN) || expected !== BigInt(request.amountIn)) {
      failResponse("Legacy MORPHO wrap-only response does not match the request");
    }
    return;
  }
  assertLegacyCallEnvelope(routeCall);
  if (normalizeAddress(routeCall.to) !== normalizeAddress(ENSO_ROUTER_V2)) {
    failResponse("Legacy MORPHO protected route has an unexpected target");
  }
  const safeRoute = decodeSafeRoute(routeCall.data);
  const minimum = getMinimumOutputAmount(request, response, outputToken);
  if (
    safeRoute.kind !== "multi" ||
    safeRoute.tokensIn.length !== 0 ||
    safeRoute.tokensOut.length !== 1 ||
    normalizeAddress(safeRoute.receiver) !== normalizeAddress(request.fromAddress)
  ) {
    failResponse("Legacy MORPHO protected route does not match the request");
  }
  assertBoundOutput(safeRoute.tokensOut[0], outputToken, minimum);
}

/**
 * Converts an untrusted Enso response into calldata whose outer Router V2 call
 * independently binds the exact input and the owner-facing minimum output.
 */
export function protectEnsoIntentResponse<T extends EnsoIntentResponse>(
  request: EnsoIntentRequest,
  response: T
): T {
  assertValidEnsoIntentRequest(request);
  assertEnsoIntentTxTarget(request.intent, response);
  assertResponseSender(request, response);

  if (request.intent === "legacyMorphoWrap" || request.intent === "legacyMorphoZapIn") {
    const protectedResponse = protectLegacyMorphoResponse(request, response);
    assertProtectedEnsoIntentResponse(request, protectedResponse);
    return protectedResponse as T;
  }

  const rawRoute = decodeRawRoute(response.tx.data);
  assertBoundInput(request, rawRoute.tokensIn, response.tx.value);
  const outputToken = getIntentOutputToken(request);
  const receiver = (request.receiver ?? request.fromAddress) as `0x${string}`;
  let protectedResponse: EnsoIntentResponse = response;
  let protectedData: Hex;

  if (!outputToken) {
    protectedData = encodeFunctionData({
      abi: ENSO_ROUTER_PROTECTION_ABI,
      functionName: "safeRouteMulti",
      args: [rawRoute.tokensIn, [], receiver, rawRoute.innerData],
    });
  } else {
    const minimum = getMinimumOutputAmount(request, response, outputToken);
    protectedResponse = withProtectedMinimum(response, outputToken, minimum);
    const tokenOut = makeBoundOutput(outputToken, minimum);
    protectedData = rawRoute.kind === "single"
      ? encodeFunctionData({
          abi: ENSO_ROUTER_PROTECTION_ABI,
          functionName: "safeRouteSingle",
          args: [rawRoute.tokensIn[0], tokenOut, receiver, rawRoute.innerData],
        })
      : encodeFunctionData({
          abi: ENSO_ROUTER_PROTECTION_ABI,
          functionName: "safeRouteMulti",
          args: [rawRoute.tokensIn, [tokenOut], receiver, rawRoute.innerData],
        });
  }

  const result = {
    ...protectedResponse,
    tx: { ...protectedResponse.tx, to: ENSO_ROUTER_V2, data: protectedData },
  } as EnsoIntentResponse;
  assertProtectedEnsoIntentResponse(request, result);
  return result as T;
}

/** Re-validates the final response in the browser before any wallet prompt. */
export function assertProtectedEnsoIntentResponse(
  request: EnsoIntentRequest,
  response: EnsoIntentResponse
): void {
  assertValidEnsoIntentRequest(request);
  assertEnsoIntentResponseShape(response);
  assertResponseSender(request, response);

  if (request.intent === "legacyMorphoWrap" || request.intent === "legacyMorphoZapIn") {
    if (
      normalizeAddress(response.tx.to) !== normalizeAddress(MORPHO_BUNDLER3) ||
      response.tx.data !== "0x" ||
      response.tx.value !== "0"
    ) {
      failResponse("Legacy MORPHO protected transaction envelope is invalid");
    }
    assertProtectedLegacyMorphoResponse(request, response);
    return;
  }

  if (normalizeAddress(response.tx.to) !== normalizeAddress(ENSO_ROUTER_V2)) {
    failResponse("Protected Enso intent must target Router V2");
  }
  const safeRoute = decodeSafeRoute(response.tx.data);
  assertBoundInput(request, safeRoute.tokensIn, response.tx.value);
  const expectedReceiver = request.receiver ?? request.fromAddress;
  if (normalizeAddress(safeRoute.receiver) !== normalizeAddress(expectedReceiver)) {
    failResponse("Protected Enso receiver does not match the owner");
  }

  const outputToken = getIntentOutputToken(request);
  if (!outputToken) {
    if (safeRoute.kind !== "multi" || safeRoute.tokensOut.length !== 0) {
      failResponse("Repayment intent returned unexpected protected token outputs");
    }
    return;
  }

  if (safeRoute.tokensOut.length !== 1) {
    failResponse("Protected Enso intent must bind exactly one final output token");
  }
  const minimum = getMinimumOutputAmount(request, response, outputToken);
  assertBoundOutput(safeRoute.tokensOut[0], outputToken, minimum);
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

  const response = await res.json() as T;
  assertProtectedEnsoIntentResponse(request, response);
  return response;
}
