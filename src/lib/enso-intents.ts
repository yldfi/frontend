import {
  CURVE_CONTROLLERS,
  getExternalVaultConfig,
  getVaultByAddress,
  TOKENS,
  type VaultConfig,
} from "@/config/vaults";
import type { EnsoBundleResponse, EnsoRouteResponse } from "@/types/enso";
import {
  EMPTY_CALLDATA_SELECTOR,
  ENSO_ROUTE_MULTI_SELECTOR,
  ENSO_ROUTE_SINGLE_SELECTOR,
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
  maxRepayAmount?: string;
  inSoftLiquidation?: boolean;
  withdrawAmount?: string;
  withdrawTokenOut?: string;
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

const ENSO_ROUTER = "0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E";
const ENSO_ROUTER_EXECUTOR = "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf";
const ENSO_SHORTCUTS = "0x4Fe93ebC4Ce6Ae4f81601cC7Ce7139023919E003";
const MORPHO_BUNDLER3 = "0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245";
const LEGACY_MORPHO = "0x9994E35Db50125E0DF82e4c2dde62496CE330999";
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
const COMMON_INTENT_TX_TARGETS = [ENSO_ROUTER, ENSO_ROUTER_EXECUTOR] as const;
const COMMON_INTENT_CALLDATA_SELECTORS = [ENSO_ROUTE_SINGLE_SELECTOR] as const;
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
  yldVaultToExternalVault: COMMON_INTENT_CALLDATA_SELECTORS,
  yldVaultToIlliquid: COMMON_INTENT_CALLDATA_SELECTORS,
  specialTokenToExternalVault: COMMON_INTENT_CALLDATA_SELECTORS,
  specialTokenToIlliquid: COMMON_INTENT_CALLDATA_SELECTORS,
  externalVaultToAny: COMMON_INTENT_CALLDATA_SELECTORS,
  illiquidToAny: COMMON_INTENT_CALLDATA_SELECTORS,
  anyToIlliquid: COMMON_INTENT_CALLDATA_SELECTORS,
  legacyMorphoWrap: [EMPTY_CALLDATA_SELECTOR],
  legacyMorphoZapIn: [EMPTY_CALLDATA_SELECTOR],
  curveLendingRepay: COMMON_INTENT_CALLDATA_SELECTORS,
  curveLendingRepayWithSwap: COMMON_INTENT_CALLDATA_SELECTORS,
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

function assertOptionalNonNegativeAmount(value: unknown, field: string) {
  if (value === undefined) return;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    failValidation(`${field} must be an integer string`);
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
  assertOptionalNonNegativeAmount(request.maxRepayAmount, "maxRepayAmount");
  assertOptionalBoolean(request.inSoftLiquidation, "inSoftLiquidation");
  assertOptionalNonNegativeAmount(request.withdrawAmount, "withdrawAmount");
  if (request.withdrawTokenOut !== undefined) {
    assertTokenAddress(request.withdrawTokenOut, "withdrawTokenOut");
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
        "maxRepayAmount",
        "inSoftLiquidation",
        "withdrawAmount",
        "withdrawTokenOut",
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
    allowedSelectors: INTENT_CALLDATA_SELECTOR_ALLOWLIST,
    forbiddenTargets: [ENSO_SHORTCUTS],
    forbiddenSelectors: [ENSO_ROUTE_MULTI_SELECTOR],
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
