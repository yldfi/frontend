import { encodeFunctionData, parseAbi } from "viem";
import type { Hex } from "viem";
import type {
  EnsoBundleResponse,
  LegacyMorphoPermitCall,
  LegacyMorphoPermitRequest,
  RouteStep,
} from "@/types/enso";
import { VAULTS } from "@/config/vaults";
import { fetchEnsoIntent } from "@/lib/enso-intents";
import { fetchRoute } from "./api";
import { buildRouteMetadataFromSteps, createRouteStep } from "./bundle-helpers";
import {
  CVXCRV_ADDRESS,
  ENSO_ROUTER_V2,
  ENSO_SHORTCUTS,
  ETH_ADDRESS,
  LEGACY_MORPHO_ADDRESS,
  MORPHO_BUNDLER3_ADDRESS,
  MORPHO_GENERAL_ADAPTER1_ADDRESS,
  MORPHO_TOKEN_ADDRESS,
  ZERO_BYTES32,
  isNativeETH,
} from "./constants";
import { estimateExternalVaultShares } from "./conversions";
import { getTokenSymbol } from "./tokens";
import { fetchZapInRoute } from "./yld-vault-zaps";

const MORPHO_BUNDLER_ABI = parseAbi([
  "function multicall((address to, bytes data, uint256 value, bool skipRevert, bytes32 callbackHash)[] bundle) payable",
]);
const LEGACY_MORPHO_PERMIT_ABI = parseAbi([
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);
const MORPHO_ADAPTER_ABI = parseAbi([
  "function erc20TransferFrom(address token, address receiver, uint256 amount)",
  "function morphoWrapperDepositFor(address receiver, uint256 amount)",
]);
const ENSO_ROUTER_V2_ABI = parseAbi([
  "function routeMulti((uint8 tokenType, bytes data)[] tokensIn, bytes data) payable returns (bytes)",
]);

type MorphoBundlerCall = {
  to: `0x${string}`;
  data: Hex;
  value: bigint;
  skipRevert: boolean;
  callbackHash: Hex;
};

function toLegacyMorphoPermitCall(call: MorphoBundlerCall): LegacyMorphoPermitCall {
  return {
    to: call.to,
    data: call.data,
    value: call.value.toString(),
    skipRevert: call.skipRevert,
    callbackHash: call.callbackHash,
  };
}

function fromLegacyMorphoPermitCall(call: LegacyMorphoPermitCall): MorphoBundlerCall {
  return {
    to: call.to as `0x${string}`,
    data: call.data as Hex,
    value: BigInt(call.value),
    skipRevert: call.skipRevert,
    callbackHash: call.callbackHash as Hex,
  };
}

function morphoBundlerCall(to: string, data: Hex): MorphoBundlerCall {
  return {
    to: to as `0x${string}`,
    data,
    value: 0n,
    skipRevert: false,
    callbackHash: ZERO_BYTES32,
  };
}

function createLegacyMorphoPermitRequest(params: {
  amount: string;
  receiver: string;
  innerEnsoData?: Hex;
}): LegacyMorphoPermitRequest {
  const amount = BigInt(params.amount);
  const calls: MorphoBundlerCall[] = [
    morphoBundlerCall(
      MORPHO_GENERAL_ADAPTER1_ADDRESS,
      encodeFunctionData({
        abi: MORPHO_ADAPTER_ABI,
        functionName: "erc20TransferFrom",
        args: [
          LEGACY_MORPHO_ADDRESS as `0x${string}`,
          MORPHO_GENERAL_ADAPTER1_ADDRESS as `0x${string}`,
          amount,
        ],
      }),
    ),
    morphoBundlerCall(
      MORPHO_GENERAL_ADAPTER1_ADDRESS,
      encodeFunctionData({
        abi: MORPHO_ADAPTER_ABI,
        functionName: "morphoWrapperDepositFor",
        args: [params.receiver as `0x${string}`, amount],
      }),
    ),
  ];

  if (params.innerEnsoData) {
    calls.push(
      morphoBundlerCall(
        ENSO_ROUTER_V2,
        encodeFunctionData({
          abi: ENSO_ROUTER_V2_ABI,
          functionName: "routeMulti",
          args: [[], params.innerEnsoData],
        }),
      ),
    );
  }

  return {
    token: LEGACY_MORPHO_ADDRESS,
    spender: MORPHO_GENERAL_ADAPTER1_ADDRESS,
    amount: params.amount,
    postPermitCalls: calls.map(toLegacyMorphoPermitCall),
  };
}

export function buildLegacyMorphoPermitTransaction(params: {
  permit: LegacyMorphoPermitRequest;
  owner: string;
  deadline: bigint;
  v: number;
  r: Hex;
  s: Hex;
}): { to: string; data: string; value: string } {
  const permitCall = morphoBundlerCall(
    params.permit.token,
    encodeFunctionData({
      abi: LEGACY_MORPHO_PERMIT_ABI,
      functionName: "permit",
      args: [
        params.owner as `0x${string}`,
        params.permit.spender as `0x${string}`,
        BigInt(params.permit.amount),
        params.deadline,
        params.v,
        params.r,
        params.s,
      ],
    }),
  );

  const calls = [
    permitCall,
    ...params.permit.postPermitCalls.map(fromLegacyMorphoPermitCall),
  ];

  return {
    to: MORPHO_BUNDLER3_ADDRESS,
    data: encodeFunctionData({
      abi: MORPHO_BUNDLER_ABI,
      functionName: "multicall",
      args: [calls],
    }),
    value: "0",
  };
}

export async function fetchLegacyMorphoWrapRoute(params: {
  fromAddress: string;
  outputToken: string;
  amountIn: string;
  slippage?: string;
}): Promise<EnsoBundleResponse> {
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<EnsoBundleResponse>({
      intent: "legacyMorphoWrap",
      fromAddress: params.fromAddress,
      outputToken: params.outputToken,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const outputToken = params.outputToken;
  const outputLower = outputToken.toLowerCase();
  const wrapOnly = outputLower === MORPHO_TOKEN_ADDRESS.toLowerCase();
  const wrapReceiver = wrapOnly ? params.fromAddress : ENSO_SHORTCUTS;
  const amountIn = params.amountIn;
  let expectedOut = amountIn;
  let routePriceImpact: number | null | undefined = null;
  let gasFallback = 150000n;
  let innerEnsoData: Hex | undefined;
  const steps: RouteStep[] = [
    createRouteStep({
      tokenAddress: LEGACY_MORPHO_ADDRESS,
      amount: amountIn,
      action: "Wrap",
      description: "Legacy MORPHO to MORPHO (1:1)",
      protocol: "Morpho",
    }),
  ];

  if (!wrapOnly) {
    const { extractInnerSwapData } = await import("@/lib/enso-route-decode");
    const standaloneRoute = await fetchRoute({
      fromAddress: params.fromAddress,
      tokenIn: MORPHO_TOKEN_ADDRESS,
      tokenOut: outputToken,
      amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
    innerEnsoData = extractInnerSwapData(standaloneRoute.tx.data) as Hex;
    expectedOut = standaloneRoute.amountOut;
    routePriceImpact = standaloneRoute.priceImpact;
    gasFallback = BigInt(standaloneRoute.gas || "0") + 160000n;

    steps.push(createRouteStep({
      tokenAddress: MORPHO_TOKEN_ADDRESS,
      amount: amountIn,
      action: "Swap",
      description: `MORPHO for ${getTokenSymbol(outputToken)}`,
      protocol: "Enso",
      slippage: routePriceImpact != null ? routePriceImpact / 100 : undefined,
    }));
  }

  steps.push(createRouteStep({
    tokenAddress: outputToken,
    amount: expectedOut,
    action: "Receive",
    description: "tokens",
    protocol: wrapOnly ? "Morpho" : "Enso",
  }));

  return {
    tx: {
      to: MORPHO_BUNDLER3_ADDRESS,
      data: "0x",
      value: "0",
      from: params.fromAddress,
    },
    gas: gasFallback.toString(),
    amountsOut: {
      [outputLower]: expectedOut,
      ...(isNativeETH(outputToken) ? { [ETH_ADDRESS.toLowerCase()]: expectedOut } : {}),
    },
    priceImpact: routePriceImpact ?? null,
    routeInfo: { steps },
    legacyMorphoPermit: createLegacyMorphoPermitRequest({
      amount: amountIn,
      receiver: wrapReceiver,
      innerEnsoData,
    }),
  };
}

/**
 * Legacy MORPHO → yld vault zap-in.
 *
 * The legacy token cannot be routed directly by Enso. We wrap it into current
 * MORPHO inside ENSO_SHORTCUTS, execute a pre-built MORPHO → vault-underlying
 * route with routeMulti so the wrapped MORPHO is consumed atomically, then
 * deposit the received underlying into the target ERC4626 vault.
 */
export async function fetchLegacyMorphoZapInRoute(params: {
  fromAddress: string;
  vaultAddress: string;
  amountIn: string;
  slippage?: string;
  underlyingToken?: string;
}): Promise<EnsoBundleResponse> {
  if (typeof window !== "undefined") {
    return fetchEnsoIntent<EnsoBundleResponse>({
      intent: "legacyMorphoZapIn",
      fromAddress: params.fromAddress,
      vaultAddress: params.vaultAddress,
      amountIn: params.amountIn,
      slippage: params.slippage ?? "100",
      receiver: params.fromAddress,
    });
  }

  const underlying = params.underlyingToken || CVXCRV_ADDRESS;
  const amountIn = params.amountIn;
  const vaultConfig = Object.values(VAULTS).find(
    (vault) => vault.address.toLowerCase() === params.vaultAddress.toLowerCase(),
  );
  const vaultSymbol = vaultConfig?.symbol ?? getTokenSymbol(params.vaultAddress);
  const underlyingSymbol = getTokenSymbol(underlying);

  const { extractInnerSwapData } = await import("@/lib/enso-route-decode");
  const standaloneRoute = await fetchRoute({
    fromAddress: params.fromAddress,
    tokenIn: MORPHO_TOKEN_ADDRESS,
    tokenOut: underlying,
    amountIn,
    slippage: params.slippage ?? "100",
    receiver: ENSO_SHORTCUTS,
  });
  const expectedUnderlying = BigInt(standaloneRoute.amountOut);
  const expectedShares = await estimateExternalVaultShares({
    vaultAddress: params.vaultAddress,
    vaultInterface: "erc4626",
    underlyingAmount: expectedUnderlying,
  });
  const innerZapBundle = await fetchZapInRoute({
    fromAddress: params.fromAddress,
    vaultAddress: params.vaultAddress,
    inputToken: MORPHO_TOKEN_ADDRESS,
    amountIn,
    slippage: params.slippage ?? "100",
    underlyingToken: underlying,
  });
  const innerZapData = extractInnerSwapData(innerZapBundle.tx.data) as Hex;

  const innerGas = innerZapBundle.gas && innerZapBundle.gas !== "0" ? innerZapBundle.gas : standaloneRoute.gas;
  const gasFallback = BigInt(innerGas || "0") + 160000n;
  const steps: RouteStep[] = [
    createRouteStep({
      tokenAddress: LEGACY_MORPHO_ADDRESS,
      amount: amountIn,
      action: "Wrap",
      description: "Legacy MORPHO to MORPHO (1:1)",
      protocol: "Morpho",
    }),
    createRouteStep({
      tokenAddress: MORPHO_TOKEN_ADDRESS,
      amount: amountIn,
      action: "Swap",
      description: `MORPHO for ${underlyingSymbol}`,
      protocol: "Enso",
      slippage: standaloneRoute.priceImpact != null ? standaloneRoute.priceImpact / 100 : undefined,
    }),
    createRouteStep({
      tokenAddress: underlying,
      tokenSymbol: underlyingSymbol,
      amount: expectedUnderlying,
      action: "Deposit",
      description: `into ${vaultSymbol}`,
      protocol: "yld",
    }),
    createRouteStep({
      tokenAddress: params.vaultAddress,
      tokenSymbol: vaultSymbol,
      amount: expectedShares,
      action: "Receive",
      description: `${vaultSymbol} shares`,
      protocol: "yld",
    }),
  ];

  return {
    tx: {
      to: MORPHO_BUNDLER3_ADDRESS,
      data: "0x",
      value: "0",
      from: params.fromAddress,
    },
    gas: gasFallback.toString(),
    amountsOut: {
      ...innerZapBundle.amountsOut,
      [underlying.toLowerCase()]: expectedUnderlying.toString(),
      [params.vaultAddress.toLowerCase()]: expectedShares,
    },
    priceImpact: standaloneRoute.priceImpact ?? innerZapBundle.priceImpact ?? null,
    routeInfo: {
      steps,
      ...buildRouteMetadataFromSteps(steps),
    },
    legacyMorphoPermit: createLegacyMorphoPermitRequest({
      amount: amountIn,
      receiver: ENSO_SHORTCUTS,
      innerEnsoData: innerZapData,
    }),
  };
}
