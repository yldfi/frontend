"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient } from "wagmi";
import { parseUnits, formatUnits } from "viem";
import {
  fetchRoute,
  fetchZapInRoute,
  fetchZapOutRoute,
  fetchVaultToVaultRoute,
  fetchCvgCvxZapInRoute,
  fetchCvgCvxZapOutRoute,
  fetchYldVaultToExternalVaultRoute,
  fetchPxCvxZapInRoute,
  fetchPxCvxZapOutRoute,
  fetchExternalVaultZapInRoute,
  fetchLpxCvxZapInRoute,
  fetchPxCvxTokenZapInRoute,
  fetchAnyToPxCvxRoute,
  fetchAnyToCvgCvxRoute,
  fetchAnyToLpxCvxRoute,
  fetchAnyFromPxCvxRoute,
  fetchAnyFromCvgCvxRoute,
  fetchAnyFromLpxCvxRoute,
  fetchAnyFromUCvxRoute,
  fetchAnyFromErc4626ExternalVaultRoute,
  fetchAnyFromUCrvRoute,
  fetchAnyFromBeefyRoute,
  fetchAnyToErc4626ExternalVaultRoute,
  fetchAnyToUCrvRoute,
  fetchAnyToBeefyRoute,
  fetchComposableZapInRoute,
  fetchSpecialTokenToIlliquidRoute,
  fetchSpecialTokenToExternalVaultRoute,
  fetchYldVaultToIlliquidRoute,
  fetchLegacyMorphoWrapRoute,
  previewUCrvWithdraw,
  previewBeefyWithdraw,
  fetchTokenPrices,
  getPxCvxSwapRate,
  getCvgCvxSwapRate,
  getCvgCvxReverseSwapRate,
  getLpxCvxToCvxSwapRate,
  isYldfiVault,
  isPxCvxToken,
  isLpxCvxToken,
  isLegacyMorphoToken,
  MORPHO_TOKEN_ADDRESS,
  getTokenSymbol,
} from "@/lib/enso";
import {
  TOKENS,
  getVaultByAddress,
  isExternalVaultToken,
  getExternalVaultConfig as getExternalVaultConfigFn,
} from "@/config/vaults";
import { useVaultCache } from "@/hooks/useVaultCache";
import { PUBLIC_RPC_URLS } from "@/config/rpc";
import { ERC4626_ABI } from "@/lib/abis";
import {
  annotateEnsoStepSlippage,
  calculateCvxLegPriceImpact,
  calculateRoutePriceImpact,
  calculateValueDeltaImpact,
} from "@/lib/price-impact";
import type { EnsoToken, ZapQuote, RouteInfo, RouteStep } from "@/types/enso";

interface UseUniversalZapParams {
  inputToken: EnsoToken | null;
  outputToken: EnsoToken | null;
  inputAmount: string;
  slippage?: string;
  paused?: boolean;
}

function buildSimpleRouteInfo(
  inputSymbol: string,
  outputSymbol: string,
): RouteInfo {
  return {
    steps: [
      {
        tokenSymbol: inputSymbol,
        action: "Swap",
        description: `${inputSymbol} for ${outputSymbol}`,
        protocol: "Enso",
      },
      {
        tokenSymbol: outputSymbol,
        action: "Receive",
        description: "tokens",
        protocol: "Enso",
      },
    ],
  };
}

// convertToAssets(uint256) selector + uint256(1e18) zero-padded to 32 bytes
const CONVERT_TO_ASSETS_1E18_CALLDATA =
  "0x07a2d13a0000000000000000000000000000000000000000000000000de0b6b3a7640000";

async function readPpsViaRpc(vaultAddress: string): Promise<number | null> {
  const rpcUrls = [
    PUBLIC_RPC_URLS.publicnode,
    PUBLIC_RPC_URLS.onerpc,
    PUBLIC_RPC_URLS.payload,
    PUBLIC_RPC_URLS.drpc,
  ].filter(Boolean);
  for (const url of rpcUrls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: vaultAddress, data: CONVERT_TO_ASSETS_1E18_CALLDATA }, "latest"],
        }),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { result?: string };
      if (json.result && json.result !== "0x") {
        return Number(BigInt(json.result)) / 1e18;
      }
    } catch {
      // try next RPC
    }
  }
  return null;
}

async function getAssetsPerShare(
  publicClient: ReturnType<typeof usePublicClient>,
  vaultAddress: `0x${string}`,
  vaultCachePps?: number | null,
): Promise<number | null> {
  // Prefer cache value (updated by worker every minute, doesn't depend on the
  // user's connected chain/RPC).
  if (vaultCachePps != null && vaultCachePps > 0) return vaultCachePps;
  // Try wagmi's publicClient first (uses configured transport), then fall back
  // to direct RPC calls — ensures this works even if wagmi's client is in a
  // weird state or the user's wallet chain isn't mainnet.
  if (publicClient) {
    try {
      const oneShare = BigInt(10 ** 18);
      const assets = await publicClient.readContract({
        address: vaultAddress,
        abi: ERC4626_ABI,
        functionName: "convertToAssets",
        args: [oneShare],
      });
      return Number(assets) / 1e18;
    } catch {
      // fall through to direct RPC
    }
  }
  return readPpsViaRpc(vaultAddress);
}

async function getPrices(addresses: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (addresses.length === 0) return out;
  try {
    const prices = await fetchTokenPrices(addresses);
    for (const p of prices) out.set(p.address.toLowerCase(), p.price);
  } catch {
    // swallow
  }
  for (const a of addresses) {
    if (!out.has(a.toLowerCase())) out.set(a.toLowerCase(), null);
  }

  // For pxCVX / lpxCVX / cvgCVX the Curve pool mid-rate is the authoritative
  // price (these tokens trade on one pool each, and Enso's aggregator feed can
  // lag by a few percent). We OVERRIDE any Enso value with a fresh Curve-derived
  // price when we have a CVX reference price. Falls back to whatever Enso
  // returned if the pool query fails.
  const cvxKey = TOKENS.CVX.toLowerCase();
  const pxCvxKey = TOKENS.PXCVX.toLowerCase();
  const lpxCvxKey = TOKENS.LPXCVX.toLowerCase();
  const cvgCvxKey = TOKENS.CVGCVX.toLowerCase();
  const needsPxCvx =
    addresses.some((a) => a.toLowerCase() === pxCvxKey) ||
    addresses.some((a) => a.toLowerCase() === lpxCvxKey);
  const needsCvgCvx = addresses.some((a) => a.toLowerCase() === cvgCvxKey);
  const cvxPx = out.get(cvxKey) ?? null;
  if (cvxPx !== null && (needsPxCvx || needsCvgCvx)) {
    const probe = (10n ** 18n).toString();
    if (needsPxCvx) {
      try {
        const lpxCvxOut = await getPxCvxSwapRate(probe);
        if (lpxCvxOut > 0n) {
          const rate = Number(lpxCvxOut) / 1e18;
          const price = cvxPx / rate;
          out.set(lpxCvxKey, price);
          out.set(pxCvxKey, price); // wraps 1:1
        }
      } catch {
        // fall back to Enso value (if any)
      }
    }
    if (needsCvgCvx) {
      try {
        const cvgCvxOut = await getCvgCvxSwapRate(probe);
        if (cvgCvxOut > 0n) {
          const rate = Number(cvgCvxOut) / 1e18;
          out.set(cvgCvxKey, cvxPx / rate);
        }
      } catch {
        // fall back to Enso value (if any)
      }
    }
  }

  return out;
}

/**
 * Universal zap dispatcher — works for any (input, output) pair:
 *   - yld vault → yld vault          (vault-to-vault)
 *   - yld vault → token              (zap out)
 *   - token → yld vault              (zap in, incl. cvgCVX/pxCVX/external vault sources)
 *   - token → token                  (plain Enso swap)
 */
export function useUniversalZap({
  inputToken,
  outputToken,
  inputAmount,
  slippage = "50",
  paused = false,
}: UseUniversalZapParams) {
  const { address: userAddress } = useAccount();
  const publicClient = usePublicClient({ chainId: 1 });
  const { data: vaultCache } = useVaultCache();

  let amountInWei = "0";
  try {
    if (inputToken && inputAmount && Number(inputAmount) > 0) {
      amountInWei = parseUnits(inputAmount, inputToken.decimals).toString();
    }
  } catch {
    // invalid amount
  }

  const enabled =
    !paused &&
    !!userAddress &&
    !!inputToken &&
    !!outputToken &&
    amountInWei !== "0" &&
    inputToken.address.toLowerCase() !== outputToken.address.toLowerCase();

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: [
      "universal-zap",
      inputToken?.address,
      outputToken?.address,
      amountInWei,
      slippage,
      userAddress,
      // Include vault cache availability so the query re-runs once pps data
      // arrives (otherwise the closure captures undefined vaultCache forever).
      !!vaultCache,
    ],
    queryFn: async (): Promise<ZapQuote | null> => {
      if (!userAddress || !inputToken || !outputToken) return null;

      const inputVault = getVaultByAddress(inputToken.address);
      const outputVault = getVaultByAddress(outputToken.address);
      const inputIsYld = !!inputVault && isYldfiVault(inputToken.address);
      const outputIsYld = !!outputVault && isYldfiVault(outputToken.address);
      const inputIsExternal = isExternalVaultToken(inputToken.address);

      const outputDecimals = outputToken.decimals ?? 18;

      // ──────────────────────────────────────────────────────────
      // Case 1: yld vault → yld vault
      // ──────────────────────────────────────────────────────────
      if (inputIsYld && outputIsYld) {
        const bundle = await fetchVaultToVaultRoute({
          fromAddress: userAddress,
          sourceVault: inputToken.address,
          targetVault: outputToken.address,
          amountIn: amountInWei,
          slippage,
        });
        const outRaw =
          bundle.amountsOut[outputToken.address.toLowerCase()] ||
          bundle.amountsOut[outputToken.address] ||
          "0";
        const outFmt = formatUnits(BigInt(outRaw), 18);
        const inNum = Number(inputAmount);
        const outNum = Number(outFmt);

        const sourceUnderlying = inputVault!.assetAddress;
        const targetUnderlying = outputVault!.assetAddress;
        const sourceCachePps =
          (vaultCache as Record<string, { pps?: number }> | undefined)?.[inputVault!.id]?.pps;
        const targetCachePps =
          (vaultCache as Record<string, { pps?: number }> | undefined)?.[outputVault!.id]?.pps;
        // Include CVX in price fetch whenever either side's underlying is an
        // illiquid token, so getPrices can derive the Curve-pool mid-rate.
        const illiquidUnderlyings = [TOKENS.CVGCVX, TOKENS.PXCVX, TOKENS.LPXCVX].map((a) => a.toLowerCase());
        const hasIlliquid =
          illiquidUnderlyings.includes(sourceUnderlying.toLowerCase()) ||
          illiquidUnderlyings.includes(targetUnderlying.toLowerCase());
        const [priceMap, sourceAps, targetAps] = await Promise.all([
          getPrices(
            hasIlliquid
              ? [sourceUnderlying, targetUnderlying, TOKENS.CVX]
              : [sourceUnderlying, targetUnderlying],
          ),
          getAssetsPerShare(publicClient, inputToken.address as `0x${string}`, sourceCachePps),
          getAssetsPerShare(publicClient, outputToken.address as `0x${string}`, targetCachePps),
        ]);
        const srcPx = priceMap.get(sourceUnderlying.toLowerCase()) ?? null;
        const tgtPx = priceMap.get(targetUnderlying.toLowerCase()) ?? null;
        const inUsd = srcPx !== null && sourceAps !== null ? inNum * sourceAps * srcPx : null;
        const outUsd = tgtPx !== null && targetAps !== null ? outNum * targetAps * tgtPx : null;
        const sameUnderlying =
          sourceUnderlying.toLowerCase() === targetUnderlying.toLowerCase();
        const routeInfo = (bundle as { routeInfo?: RouteInfo }).routeInfo ?? {
          steps: sameUnderlying
            ? [
                { tokenSymbol: inputToken.symbol, action: "Redeem", description: `${inputToken.symbol} for ${getTokenSymbol(sourceUnderlying)}`, protocol: "yld" },
                { tokenSymbol: outputToken.symbol, action: "Deposit", description: `into ${outputToken.symbol}`, protocol: "yld" },
                { tokenSymbol: outputToken.symbol, action: "Receive", description: `${outputToken.symbol} shares`, protocol: "yld" },
              ]
            : [
                { tokenSymbol: inputToken.symbol, action: "Redeem", description: `${inputToken.symbol} for ${getTokenSymbol(sourceUnderlying)}`, protocol: "yld" },
                { tokenSymbol: getTokenSymbol(sourceUnderlying), action: "Swap", description: `for ${getTokenSymbol(targetUnderlying)}`, protocol: "Enso" },
                { tokenSymbol: getTokenSymbol(targetUnderlying), action: "Deposit", description: `into ${outputToken.symbol}`, protocol: "yld" },
                { tokenSymbol: outputToken.symbol, action: "Receive", description: `${outputToken.symbol} shares`, protocol: "yld" },
              ],
        };

        return {
          inputToken,
          inputAmount,
          outputAmount: outRaw,
          outputAmountFormatted: outFmt,
          exchangeRate: inNum > 0 ? outNum / inNum : 0,
          inputUsdValue: inUsd,
          outputUsdValue: outUsd,
          priceImpact: calculateRoutePriceImpact(inUsd, outUsd, routeInfo, bundle.priceImpact ?? null),
          gasEstimate: bundle.gas,
          tx: { to: bundle.tx.to, data: bundle.tx.data, value: bundle.tx.value },
          route: [],
          routeInfo,
        };
      }

      // ──────────────────────────────────────────────────────────
      // Case 2: yld vault → token (zap out)
      // ──────────────────────────────────────────────────────────
      if (inputIsYld && !outputIsYld) {
        const underlying = inputVault!.assetAddress;
        const isCvg = underlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();
        const isPx = underlying.toLowerCase() === TOKENS.PXCVX.toLowerCase();

        // yld vault → external vault: Enso can't route CVX/cvxCRV directly to
        // tokens like uCVX/aCVX, so the standard zap-out path would fall to a
        // bad "no route" quote. Use a dedicated builder that redeems, converts
        // to the external vault's underlying, then runs the vault-specific
        // deposit — all atomic.
        const outputExternalConfig = isExternalVaultToken(outputToken.address)
          ? getExternalVaultConfigFn(outputToken.address)
          : undefined;
        if (outputExternalConfig) {
          const bundle = await fetchYldVaultToExternalVaultRoute({
            fromAddress: userAddress,
            sourceVault: inputToken.address,
            sourceUnderlying: underlying,
            targetVault: outputToken.address,
            targetUnderlying: outputExternalConfig.underlying,
            targetInterface: outputExternalConfig.interface,
            targetSymbol: outputExternalConfig.symbol,
            targetProtocol: outputExternalConfig.protocol,
            amountIn: amountInWei,
            slippage,
          });

          const outRaw =
            bundle.amountsOut[outputToken.address.toLowerCase()] ||
            bundle.amountsOut[outputToken.address] ||
            "0";
          const outFmt = formatUnits(BigInt(outRaw), outputDecimals);
          const inNum = Number(inputAmount);
          const outNum = Number(outFmt);

          const inputCachePps =
            (vaultCache as Record<string, { pps?: number }> | undefined)?.[inputVault!.id]?.pps;
          const isUcvxTarget =
            outputExternalConfig.interface === "erc4626" &&
            outputExternalConfig.underlying.toLowerCase() === TOKENS.PXCVX.toLowerCase();
          const priceAddrs = [underlying, outputExternalConfig.underlying, TOKENS.CVX];
          if (isUcvxTarget) priceAddrs.push(TOKENS.PXCVX);
          const [priceMap, sourceAps, targetSharePrice] = await Promise.all([
            getPrices(priceAddrs),
            getAssetsPerShare(publicClient, inputToken.address as `0x${string}`, inputCachePps),
            getAssetsPerShare(publicClient, outputToken.address as `0x${string}`),
          ]);
          const underPx =
            priceMap.get(underlying.toLowerCase()) ??
            priceMap.get(TOKENS.CVX.toLowerCase()) ??
            null;
          const targetUnderPx = isUcvxTarget
            ? priceMap.get(TOKENS.PXCVX.toLowerCase()) ?? null
            : priceMap.get(outputExternalConfig.underlying.toLowerCase()) ?? null;
          const inUsd =
            underPx !== null && sourceAps !== null ? inNum * sourceAps * underPx : null;
          const outUsd =
            targetUnderPx !== null && targetSharePrice !== null
              ? outNum * targetSharePrice * targetUnderPx
              : null;
          const cvxPx = priceMap.get(TOKENS.CVX.toLowerCase()) ?? null;
          const priceImpact = isUcvxTarget
            ? calculateCvxLegPriceImpact({
                inputUsd: inUsd,
                cvxUsd: cvxPx,
                routeInfo: bundle.routeInfo,
              }) ?? calculateRoutePriceImpact(inUsd, outUsd, bundle.routeInfo, bundle.priceImpact ?? null)
            : calculateRoutePriceImpact(inUsd, outUsd, bundle.routeInfo, bundle.priceImpact ?? null);

          return {
            inputToken,
            inputAmount,
            outputAmount: outRaw,
            outputAmountFormatted: outFmt,
            exchangeRate: inNum > 0 ? outNum / inNum : 0,
            inputUsdValue: inUsd,
            outputUsdValue: outUsd,
            priceImpact,
            gasEstimate: bundle.gas,
            tx: { to: bundle.tx.to, data: bundle.tx.data, value: bundle.tx.value },
            route: [],
            routeInfo: bundle.routeInfo,
          };
        }

        const outputIsIlliquid =
          outputToken.address.toLowerCase() === TOKENS.PXCVX.toLowerCase() ||
          outputToken.address.toLowerCase() === TOKENS.CVGCVX.toLowerCase() ||
          outputToken.address.toLowerCase() === TOKENS.LPXCVX.toLowerCase();
        if (outputIsIlliquid) {
          const bundle = await fetchYldVaultToIlliquidRoute({
            fromAddress: userAddress,
            sourceVault: inputToken.address,
            sourceUnderlying: underlying,
            outputToken: outputToken.address,
            amountIn: amountInWei,
            slippage,
          });

          const outRaw =
            bundle.amountsOut[outputToken.address.toLowerCase()] ||
            bundle.amountsOut[outputToken.address] ||
            "0";
          const outFmt = formatUnits(BigInt(outRaw), outputDecimals);
          const inNum = Number(inputAmount);
          const outNum = Number(outFmt);
          const inputCachePps =
            (vaultCache as Record<string, { pps?: number }> | undefined)?.[inputVault!.id]?.pps;
          const [priceMap, aps] = await Promise.all([
            getPrices([underlying, outputToken.address, TOKENS.CVX]),
            getAssetsPerShare(publicClient, inputToken.address as `0x${string}`, inputCachePps),
          ]);
          const underPx =
            priceMap.get(underlying.toLowerCase()) ??
            priceMap.get(TOKENS.CVX.toLowerCase()) ??
            null;
          const outPx = priceMap.get(outputToken.address.toLowerCase()) ?? null;
          const cvxPx = priceMap.get(TOKENS.CVX.toLowerCase()) ?? null;
          const inUsd =
            underPx !== null && aps !== null ? inNum * aps * underPx : null;
          const outUsd = outPx !== null ? outNum * outPx : null;
          const priceImpact =
            calculateCvxLegPriceImpact({
              inputUsd: inUsd,
              cvxUsd: cvxPx,
              routeInfo: bundle.routeInfo,
            }) ?? calculateRoutePriceImpact(inUsd, outUsd, bundle.routeInfo, bundle.priceImpact ?? null);

          return {
            inputToken,
            inputAmount,
            outputAmount: outRaw,
            outputAmountFormatted: outFmt,
            exchangeRate: inNum > 0 ? outNum / inNum : 0,
            inputUsdValue: inUsd,
            outputUsdValue: outUsd,
            priceImpact,
            gasEstimate: bundle.gas,
            tx: { to: bundle.tx.to, data: bundle.tx.data, value: bundle.tx.value },
            route: [],
            routeInfo: bundle.routeInfo,
          };
        }

        const bundle = isCvg
          ? await fetchCvgCvxZapOutRoute({
              fromAddress: userAddress,
              vaultAddress: inputToken.address,
              outputToken: outputToken.address,
              amountIn: amountInWei,
              slippage,
            })
          : isPx
          ? await fetchPxCvxZapOutRoute({
              fromAddress: userAddress,
              vaultAddress: inputToken.address,
              outputToken: outputToken.address,
              amountIn: amountInWei,
              slippage,
            })
          : await fetchZapOutRoute({
              fromAddress: userAddress,
              vaultAddress: inputToken.address,
              outputToken: outputToken.address,
              amountIn: amountInWei,
              slippage,
              underlyingToken: underlying,
            });

        const outRaw =
          bundle.amountsOut[outputToken.address.toLowerCase()] ||
          bundle.amountsOut[outputToken.address] ||
          "0";
        const outFmt = formatUnits(BigInt(outRaw), outputDecimals);
        const inNum = Number(inputAmount);
        const outNum = Number(outFmt);

        // For cvgCVX/pxCVX/lpxCVX underlyings Enso often has no price feed,
        // so fall back to CVX price (1:1 CVX-equivalent via mint/wrap).
        const underlyingNeedsCvxFallback =
          underlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase() ||
          underlying.toLowerCase() === TOKENS.PXCVX.toLowerCase() ||
          underlying.toLowerCase() === TOKENS.LPXCVX.toLowerCase();
        const inputCachePps =
          (vaultCache as Record<string, { pps?: number }> | undefined)?.[inputVault!.id]?.pps;
        const [priceMap, aps] = await Promise.all([
          getPrices(
            underlyingNeedsCvxFallback
              ? [outputToken.address, underlying, TOKENS.CVX]
              : [outputToken.address, underlying],
          ),
          getAssetsPerShare(publicClient, inputToken.address as `0x${string}`, inputCachePps),
        ]);
        const outPx = priceMap.get(outputToken.address.toLowerCase()) ?? null;
        const underPxRaw = priceMap.get(underlying.toLowerCase()) ?? null;
        // Curve-pool fallback runs inside getPrices; only use CVX as a last
        // resort when Enso and Curve both failed (rare).
        const cvxFallbackPx = underlyingNeedsCvxFallback
          ? priceMap.get(TOKENS.CVX.toLowerCase()) ?? null
          : null;
        const underPx = underPxRaw ?? cvxFallbackPx;
        // Don't invent an aps: if convertToAssets fails, display blank rather
        // than a misleading 1:1 share-to-underlying ratio.
        const inUsd =
          underPx !== null && aps !== null ? inNum * aps * underPx : null;
        const outUsd = outPx !== null ? outNum * outPx : null;

        // Intermediate underlying amount (redeemed vault shares × assetsPerShare)
        const intermediateUnderlyingAmount =
          aps !== null ? (inNum * aps).toFixed(4) : undefined;

        // Build detailed fallback route. For cvgCVX/pxCVX vaults the underlying
        // isn't directly swappable on Enso, so the real route goes through a
        // Curve pool + CVX1 unwrap (cvgCVX) or wrap+pool (pxCVX). Matches the
        // detailed display used on the vault pages for consistency.
        const isCvgCvxUnderlying =
          underlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();
        const isPxCvxUnderlying =
          underlying.toLowerCase() === TOKENS.PXCVX.toLowerCase();

        // Estimate the CVX amount mid-bundle by simulating the Curve pool swap
        // of the redeemed underlying, so the route can display "X CVX".
        let cvxIntermediateAmount: string | undefined;
        if (aps !== null && (isCvgCvxUnderlying || isPxCvxUnderlying)) {
          try {
            const redeemedWei = parseUnits((inNum * aps).toFixed(18), 18).toString();
            const cvxOut = isCvgCvxUnderlying
              ? await getCvgCvxReverseSwapRate(redeemedWei)
              : await getLpxCvxToCvxSwapRate(redeemedWei);
            if (cvxOut > 0n) {
              cvxIntermediateAmount = (Number(cvxOut) / 1e18).toFixed(4);
            }
          } catch {
            // leave undefined
          }
        }

        // When the output IS CVX, the CVX → output swap step is redundant.
        // The bundle produces CVX directly; skip the extra "Swap CVX for CVX"
        // hop and let the previous step flow into the final receive row.
        const outputIsCvx =
          outputToken.address.toLowerCase() === TOKENS.CVX.toLowerCase();

        let fallbackRouteInfo: RouteInfo;
        if (isCvgCvxUnderlying) {
          fallbackRouteInfo = {
            steps: [
              {
                tokenSymbol: inputToken.symbol,
                action: "Redeem",
                description: `${inputToken.symbol} for cvgCVX`,
                protocol: "yld",
              },
              {
                tokenSymbol: "cvgCVX",
                amount: intermediateUnderlyingAmount,
                action: "Swap",
                description: "cvgCVX → CVX1 → CVX",
                protocol: "LiquidBoost",
              },
              ...(outputIsCvx
                ? [
                    {
                      tokenSymbol: "CVX",
                      amount: cvxIntermediateAmount,
                      action: "Receive",
                      description: "tokens",
                      protocol: "LiquidBoost",
                    } satisfies RouteStep,
                  ]
                : [
                    {
                      tokenSymbol: "CVX",
                      amount: cvxIntermediateAmount,
                      action: "Swap",
                      description: `CVX for ${outputToken.symbol}`,
                      protocol: "Enso",
                    } satisfies RouteStep,
                    {
                      tokenSymbol: outputToken.symbol,
                      action: "Receive",
                      description: "tokens",
                      protocol: "Enso",
                    } satisfies RouteStep,
                  ]),
            ],
          };
        } else if (isPxCvxUnderlying) {
          fallbackRouteInfo = {
            steps: [
              {
                tokenSymbol: inputToken.symbol,
                action: "Redeem",
                description: `${inputToken.symbol} for pxCVX`,
                protocol: "yld",
              },
              {
                tokenSymbol: "pxCVX",
                amount: intermediateUnderlyingAmount,
                action: "Swap",
                description: "pxCVX → lpxCVX → CVX",
                protocol: "Pirex",
              },
              ...(outputIsCvx
                ? [
                    {
                      tokenSymbol: "CVX",
                      amount: cvxIntermediateAmount,
                      action: "Receive",
                      description: "tokens",
                      protocol: "Pirex",
                    } satisfies RouteStep,
                  ]
                : [
                    {
                      tokenSymbol: "CVX",
                      amount: cvxIntermediateAmount,
                      action: "Swap",
                      description: `CVX for ${outputToken.symbol}`,
                      protocol: "Enso",
                    } satisfies RouteStep,
                    {
                      tokenSymbol: outputToken.symbol,
                      action: "Receive",
                      description: "tokens",
                      protocol: "Enso",
                    } satisfies RouteStep,
                  ]),
            ],
          };
        } else {
          fallbackRouteInfo = {
            steps: [
              {
                tokenSymbol: inputToken.symbol,
                action: "Redeem",
                description: `${inputToken.symbol} for ${getTokenSymbol(underlying)}`,
                protocol: "yld",
              },
              {
                tokenSymbol: getTokenSymbol(underlying),
                amount: intermediateUnderlyingAmount,
                action: "Swap",
                description: `for ${outputToken.symbol}`,
                protocol: "Enso",
              },
              {
                tokenSymbol: outputToken.symbol,
                action: "Receive",
                description: "tokens",
                protocol: "Enso",
              },
            ],
          };
        }
        const routeInfo = (bundle as { routeInfo?: RouteInfo }).routeInfo ?? fallbackRouteInfo;

        return {
          inputToken,
          inputAmount,
          outputAmount: outRaw,
          outputAmountFormatted: outFmt,
          exchangeRate: inNum > 0 ? outNum / inNum : 0,
          inputUsdValue: inUsd,
          outputUsdValue: outUsd,
          priceImpact: calculateRoutePriceImpact(inUsd, outUsd, routeInfo, bundle.priceImpact ?? null),
          gasEstimate: bundle.gas,
          tx: { to: bundle.tx.to, data: bundle.tx.data, value: bundle.tx.value },
          route: [],
          routeInfo,
        };
      }

      // ──────────────────────────────────────────────────────────
      // Case 3: token → yld vault (zap in)
      // ──────────────────────────────────────────────────────────
      if (!inputIsYld && outputIsYld) {
        const underlying = outputVault!.assetAddress;
        const targetIsCvg = underlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();
        const targetIsPx = underlying.toLowerCase() === TOKENS.PXCVX.toLowerCase();

        let bundle;
        if (inputIsExternal && targetIsPx) {
          bundle = await fetchComposableZapInRoute({
            fromAddress: userAddress,
            inputToken: inputToken.address,
            vaultAddress: outputToken.address,
            amountIn: amountInWei,
            slippage,
          });
        } else if (inputToken.address.toLowerCase() === TOKENS.CVGCVX.toLowerCase() && !targetIsCvg) {
          bundle = await fetchComposableZapInRoute({
            fromAddress: userAddress,
            inputToken: inputToken.address,
            vaultAddress: outputToken.address,
            amountIn: amountInWei,
            slippage,
          });
        } else if (inputIsExternal) {
          bundle = await fetchExternalVaultZapInRoute({
            fromAddress: userAddress,
            vaultAddress: outputToken.address,
            externalVaultAddress: inputToken.address,
            amountIn: amountInWei,
            slippage,
          });
        } else if (isLpxCvxToken(inputToken.address)) {
          bundle = await fetchLpxCvxZapInRoute({
            fromAddress: userAddress,
            vaultAddress: outputToken.address,
            amountIn: amountInWei,
            slippage,
          });
        } else if (isPxCvxToken(inputToken.address) && !targetIsPx) {
          bundle = await fetchPxCvxTokenZapInRoute({
            fromAddress: userAddress,
            vaultAddress: outputToken.address,
            amountIn: amountInWei,
            slippage,
          });
        } else if (targetIsCvg) {
          bundle = await fetchCvgCvxZapInRoute({
            fromAddress: userAddress,
            vaultAddress: outputToken.address,
            inputToken: inputToken.address,
            amountIn: amountInWei,
            slippage,
          });
        } else if (targetIsPx) {
          bundle = await fetchPxCvxZapInRoute({
            fromAddress: userAddress,
            vaultAddress: outputToken.address,
            inputToken: inputToken.address,
            amountIn: amountInWei,
            slippage,
          });
        } else {
          bundle = await fetchZapInRoute({
            fromAddress: userAddress,
            vaultAddress: outputToken.address,
            inputToken: inputToken.address,
            amountIn: amountInWei,
            slippage,
            underlyingToken: underlying,
          });
        }

        const outRaw =
          bundle.amountsOut[outputToken.address.toLowerCase()] ||
          bundle.amountsOut[outputToken.address] ||
          "0";
        const outFmt = formatUnits(BigInt(outRaw), 18);
        const inNum = Number(inputAmount);
        const outNum = Number(outFmt);

        const underlyingNeedsCvxFallback =
          underlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase() ||
          underlying.toLowerCase() === TOKENS.PXCVX.toLowerCase() ||
          underlying.toLowerCase() === TOKENS.LPXCVX.toLowerCase();
        const outputCachePps =
          (vaultCache as Record<string, { pps?: number }> | undefined)?.[outputVault!.id]?.pps;
        const [priceMap, aps] = await Promise.all([
          getPrices(
            underlyingNeedsCvxFallback
              ? [inputToken.address, underlying, TOKENS.CVX]
              : [inputToken.address, underlying],
          ),
          getAssetsPerShare(publicClient, outputToken.address as `0x${string}`, outputCachePps),
        ]);
        const inPx = priceMap.get(inputToken.address.toLowerCase()) ?? null;
        const underPxRaw = priceMap.get(underlying.toLowerCase()) ?? null;
        const cvxFallbackPx = underlyingNeedsCvxFallback
          ? priceMap.get(TOKENS.CVX.toLowerCase()) ?? null
          : null;
        const underPx = underPxRaw ?? cvxFallbackPx;
        const inUsd = inPx !== null ? inNum * inPx : null;
        const outUsd =
          underPx !== null && aps !== null ? outNum * aps * underPx : null;

        const intermediateUnderlyingAmount =
          aps !== null ? (outNum * aps).toFixed(4) : undefined;

        const fallbackRouteInfo: RouteInfo = {
          steps: [
            {
              tokenSymbol: inputToken.symbol,
              action: "Swap",
              description: `for ${getTokenSymbol(underlying)}`,
              protocol: "Enso",
            },
            {
              tokenSymbol: getTokenSymbol(underlying),
              amount: intermediateUnderlyingAmount,
              action: "Deposit",
              description: `into ${outputToken.symbol}`,
              protocol: "yld",
            },
            {
              tokenSymbol: outputToken.symbol,
              action: "Receive",
              description: `${outputToken.symbol} shares`,
              protocol: "yld",
            },
          ],
        };
        const routeInfo = (bundle as { routeInfo?: RouteInfo }).routeInfo ?? fallbackRouteInfo;
        const priceImpact = underlyingNeedsCvxFallback
          ? calculateCvxLegPriceImpact({
              inputUsd: inUsd,
              cvxUsd: cvxFallbackPx,
              routeInfo,
            }) ?? calculateRoutePriceImpact(inUsd, outUsd, routeInfo, bundle.priceImpact ?? null)
          : calculateRoutePriceImpact(inUsd, outUsd, routeInfo, bundle.priceImpact ?? null);

        return {
          inputToken,
          inputAmount,
          outputAmount: outRaw,
          outputAmountFormatted: outFmt,
          exchangeRate: inNum > 0 ? outNum / inNum : 0,
          inputUsdValue: inUsd,
          outputUsdValue: outUsd,
          priceImpact,
          gasEstimate: bundle.gas,
          tx: { to: bundle.tx.to, data: bundle.tx.data, value: bundle.tx.value },
          route: [],
          routeInfo,
        };
      }

      // ──────────────────────────────────────────────────────────
      // Case 4: token → token (plain Enso swap or custom illiquid routes)
      // ──────────────────────────────────────────────────────────
      const inAddr = inputToken.address.toLowerCase();
      const outAddr = outputToken.address.toLowerCase();
      const inputIsPxCvx = inAddr === TOKENS.PXCVX.toLowerCase();
      const inputIsCvgCvx = inAddr === TOKENS.CVGCVX.toLowerCase();
      const inputIsLpxCvx = inAddr === TOKENS.LPXCVX.toLowerCase();
      const outputIsPxCvx = outAddr === TOKENS.PXCVX.toLowerCase();
      const outputIsCvgCvx = outAddr === TOKENS.CVGCVX.toLowerCase();
      const outputIsLpxCvx = outAddr === TOKENS.LPXCVX.toLowerCase();
      const inputExternalConfig = isExternalVaultToken(inputToken.address)
        ? getExternalVaultConfigFn(inputToken.address)
        : undefined;
      const inputIsSpecialInput =
        !!inputExternalConfig || inputIsPxCvx || inputIsCvgCvx || inputIsLpxCvx;

      // External vaults as output (uCVX / aCVX / aCRV / afCVX / mooCvxCRV /
      // mooCvxCVX / uCRV / scrvUSD). Enso's aggregator can't build routes to
      // these tokens directly — we route to the underlying first, then deposit
      // via the vault's specific interface.
      const outputExternalConfig = isExternalVaultToken(outputToken.address)
        ? getExternalVaultConfigFn(outputToken.address)
        : undefined;
      if (inputIsSpecialInput && outputExternalConfig) {
        const bundle = await fetchSpecialTokenToExternalVaultRoute({
          fromAddress: userAddress,
          inputToken: inputToken.address,
          outputVault: outputToken.address,
          amountIn: amountInWei,
          slippage,
        });

        const outRaw =
          bundle.amountsOut[outAddr] || bundle.amountsOut[outputToken.address] || "0";
        const outFmt = formatUnits(BigInt(outRaw), outputDecimals);
        const inNum = Number(inputAmount);
        const outNum = Number(outFmt);

        const [priceMap, underlyingAmount, targetSharePrice] = await Promise.all([
          getPrices([
            outputExternalConfig.underlying,
            TOKENS.CVX,
            TOKENS.PXCVX,
          ]),
          (async (): Promise<number> => {
            if (!inputExternalConfig) return Number(inputAmount);
            try {
              if (inputExternalConfig.interface === "ucrv") {
                const raw = await previewUCrvWithdraw(amountInWei);
                return Number(raw) / 1e18;
              }
              if (inputExternalConfig.interface === "beefy") {
                const raw = await previewBeefyWithdraw(inputToken.address, amountInWei);
                return Number(raw) / 1e18;
              }
              const aps = await getAssetsPerShare(
                publicClient,
                inputToken.address as `0x${string}`,
              );
              if (aps !== null) return Number(inputAmount) * aps;
            } catch {
              // fall through
            }
            return 0;
          })(),
          (async (): Promise<number | null> => {
            try {
              if (outputExternalConfig.interface === "erc4626") {
                return getAssetsPerShare(
                  publicClient,
                  outputToken.address as `0x${string}`,
                );
              }
              if (outputExternalConfig.interface === "ucrv") {
                const raw = await previewUCrvWithdraw((10n ** 18n).toString());
                return Number(raw) / 1e18;
              }
              const raw = await previewBeefyWithdraw(
                outputToken.address,
                (10n ** 18n).toString(),
              );
              return Number(raw) / 1e18;
            } catch {
              return null;
            }
          })(),
        ]);

        const underPx =
          priceMap.get(outputExternalConfig.underlying.toLowerCase()) ??
          priceMap.get(TOKENS.PXCVX.toLowerCase()) ??
          priceMap.get(TOKENS.CVX.toLowerCase()) ??
          null;
        const cvxPx = priceMap.get(TOKENS.CVX.toLowerCase()) ?? null;
        const inUsd = inputExternalConfig
          ? underPx !== null && underlyingAmount > 0
            ? underlyingAmount * underPx
            : null
          : cvxPx !== null
            ? inNum * cvxPx
            : null;
        const outUsd =
          underPx !== null && targetSharePrice !== null
            ? outNum * targetSharePrice * underPx
            : null;
        const outputUnderlyingIsIlliquid =
          outputExternalConfig.underlying.toLowerCase() === TOKENS.PXCVX.toLowerCase() ||
          outputExternalConfig.underlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase() ||
          outputExternalConfig.underlying.toLowerCase() === TOKENS.LPXCVX.toLowerCase();
        const priceImpact = outputUnderlyingIsIlliquid
          ? calculateCvxLegPriceImpact({
              inputUsd: inUsd,
              cvxUsd: cvxPx,
              routeInfo: bundle.routeInfo,
            }) ?? calculateRoutePriceImpact(inUsd, outUsd, bundle.routeInfo, bundle.priceImpact ?? null)
          : calculateRoutePriceImpact(inUsd, outUsd, bundle.routeInfo, bundle.priceImpact ?? null);

        return {
          inputToken,
          inputAmount,
          outputAmount: outRaw,
          outputAmountFormatted: outFmt,
          exchangeRate: inNum > 0 ? outNum / inNum : 0,
          inputUsdValue: inUsd,
          outputUsdValue: outUsd,
          priceImpact,
          gasEstimate: bundle.gas,
          tx: { to: bundle.tx.to, data: bundle.tx.data, value: bundle.tx.value },
          route: [],
          routeInfo: bundle.routeInfo,
        };
      }

      if (inputIsSpecialInput && (outputIsPxCvx || outputIsCvgCvx || outputIsLpxCvx)) {
        const bundle = await fetchSpecialTokenToIlliquidRoute({
          fromAddress: userAddress,
          inputToken: inputToken.address,
          outputToken: outputToken.address,
          amountIn: amountInWei,
          slippage,
        });

        const outRaw =
          bundle.amountsOut[outAddr] || bundle.amountsOut[outputToken.address] || "0";
        const outFmt = formatUnits(BigInt(outRaw), outputDecimals);
        const inNum = Number(inputAmount);
        const outNum = Number(outFmt);

        const [priceMap, underlyingAmount] = await Promise.all([
          getPrices([
            outputToken.address,
            TOKENS.CVX,
            ...(inputExternalConfig ? [inputExternalConfig.underlying] : []),
          ]),
          (async (): Promise<number> => {
            if (!inputExternalConfig) return Number(inputAmount);
            try {
              if (inputExternalConfig.interface === "ucrv") {
                const raw = await previewUCrvWithdraw(amountInWei);
                return Number(raw) / 1e18;
              }
              if (inputExternalConfig.interface === "beefy") {
                const raw = await previewBeefyWithdraw(inputToken.address, amountInWei);
                return Number(raw) / 1e18;
              }
              const aps = await getAssetsPerShare(
                publicClient,
                inputToken.address as `0x${string}`,
              );
              if (aps !== null) return Number(inputAmount) * aps;
            } catch {
              // fall through
            }
            return 0;
          })(),
        ]);
        const cvxPx = priceMap.get(TOKENS.CVX.toLowerCase()) ?? null;
        const underPx = inputExternalConfig
          ? priceMap.get(inputExternalConfig.underlying.toLowerCase()) ?? cvxPx
          : cvxPx;
        const outPx = priceMap.get(outputToken.address.toLowerCase()) ?? null;
        const inUsd = inputExternalConfig
          ? underPx !== null && underlyingAmount > 0
            ? underlyingAmount * underPx
            : null
          : cvxPx !== null
            ? inNum * cvxPx
            : null;
        const outUsd = outPx !== null ? outNum * outPx : null;
        const priceImpact =
          calculateCvxLegPriceImpact({
            inputUsd: inUsd,
            cvxUsd: cvxPx,
            routeInfo: bundle.routeInfo,
          }) ?? calculateRoutePriceImpact(inUsd, outUsd, bundle.routeInfo, bundle.priceImpact ?? null);

        return {
          inputToken,
          inputAmount,
          outputAmount: outRaw,
          outputAmountFormatted: outFmt,
          exchangeRate: inNum > 0 ? outNum / inNum : 0,
          inputUsdValue: inUsd,
          outputUsdValue: outUsd,
          priceImpact,
          gasEstimate: bundle.gas,
          tx: { to: bundle.tx.to, data: bundle.tx.data, value: bundle.tx.value },
          route: [],
          routeInfo: bundle.routeInfo,
        };
      }

      if (outputExternalConfig) {
        const extUnderlying = outputExternalConfig.underlying.toLowerCase();
        const isUcvxOutput =
          outputExternalConfig.interface === "erc4626" &&
          extUnderlying === TOKENS.PXCVX.toLowerCase();

        let bundle;
        if (isUcvxOutput) {
          // uCVX — hybrid pxCVX acquisition then erc4626/deposit
          bundle = await fetchAnyToPxCvxRoute({
            fromAddress: userAddress,
            inputToken: inputToken.address,
            amountIn: amountInWei,
            slippage,
            depositIntoVault: outputToken.address,
          });
        } else if (outputExternalConfig.interface === "ucrv") {
          bundle = await fetchAnyToUCrvRoute({
            fromAddress: userAddress,
            inputToken: inputToken.address,
            amountIn: amountInWei,
            slippage,
          });
        } else if (outputExternalConfig.interface === "beefy") {
          bundle = await fetchAnyToBeefyRoute({
            fromAddress: userAddress,
            inputToken: inputToken.address,
            beefyVault: outputToken.address,
            beefyVaultUnderlying: outputExternalConfig.underlying,
            beefyVaultSymbol: outputExternalConfig.symbol,
            amountIn: amountInWei,
            slippage,
          });
        } else {
          // ERC4626 with liquid underlying (aCVX, aCRV, afCVX, scrvUSD)
          bundle = await fetchAnyToErc4626ExternalVaultRoute({
            fromAddress: userAddress,
            inputToken: inputToken.address,
            externalVault: outputToken.address,
            externalVaultUnderlying: outputExternalConfig.underlying,
            externalVaultSymbol: outputExternalConfig.symbol,
            externalVaultProtocol: outputExternalConfig.protocol,
            amountIn: amountInWei,
            slippage,
          });
        }

        const outRaw =
          bundle.amountsOut[outAddr] || bundle.amountsOut[outputToken.address] || "0";
        const outFmt = formatUnits(BigInt(outRaw), outputDecimals);
        const inNum = Number(inputAmount);
        const outNum = Number(outFmt);

        // Value via the underlying × underlying price × vault share price.
        // For uCVX we use the captured pxCVX-equivalent instead.
        const priceMap = await getPrices([
          inputToken.address,
          outputExternalConfig.underlying,
          TOKENS.PXCVX,
          TOKENS.CVX,
        ]);
        const inPx = priceMap.get(inputToken.address.toLowerCase()) ?? null;
        const underPx = priceMap.get(outputExternalConfig.underlying.toLowerCase()) ?? null;
        const inUsd = inPx !== null ? inNum * inPx : null;

        let outUsd: number | null = null;
        let underlyingAmountFromShares: number | null = null;
        if (isUcvxOutput) {
          const pxCvxPx = priceMap.get(TOKENS.PXCVX.toLowerCase()) ?? null;
          const pxCvxEquivalentRaw = bundle.amountsOut[TOKENS.PXCVX.toLowerCase()] || "0";
          const pxCvxEquivalent = Number(formatUnits(BigInt(pxCvxEquivalentRaw), 18));
          outUsd =
            pxCvxPx !== null && pxCvxEquivalent > 0 ? pxCvxEquivalent * pxCvxPx : null;
        } else if (underPx !== null && outNum > 0) {
          // Share → underlying ratio via the appropriate preview method.
          // Reuse getAssetsPerShare for ERC4626 — it falls back to direct RPC
          // when wagmi's publicClient hits a transient transport error (common
          // with fallback RPCs under load).
          let sharePrice: number | null = null;
          try {
            if (outputExternalConfig.interface === "erc4626") {
              sharePrice = await getAssetsPerShare(
                publicClient,
                outputToken.address as `0x${string}`,
              );
            } else if (outputExternalConfig.interface === "ucrv") {
              const raw = await previewUCrvWithdraw((10n ** 18n).toString());
              sharePrice = Number(raw) / 1e18;
            } else if (outputExternalConfig.interface === "beefy") {
              const raw = await previewBeefyWithdraw(
                outputToken.address,
                (10n ** 18n).toString(),
              );
              sharePrice = Number(raw) / 1e18;
            }
          } catch {
            sharePrice = null;
          }
          if (sharePrice !== null) {
            underlyingAmountFromShares = outNum * sharePrice;
            outUsd = underlyingAmountFromShares * underPx;
          }
        }

        // Inject the intermediate underlying amount into the deposit step if
        // the bundle didn't already supply one.
        const routeInfo = bundle.routeInfo;
        if (routeInfo && underlyingAmountFromShares !== null) {
          const underlyingAddr = outputExternalConfig.underlying.toLowerCase();
          const depositStep = routeInfo.steps.find(
            (s) =>
              s.action?.toLowerCase() === "deposit" &&
              s.tokenSymbol.toLowerCase() === getTokenSymbol(underlyingAddr).toLowerCase() &&
              !s.amount,
          );
          if (depositStep) {
            depositStep.amount = underlyingAmountFromShares.toFixed(4);
          }
        }
        const cvxPx = priceMap.get(TOKENS.CVX.toLowerCase()) ?? null;
        const priceImpact = isUcvxOutput
          ? calculateCvxLegPriceImpact({
              inputUsd: inUsd,
              cvxUsd: cvxPx,
              routeInfo,
            }) ?? calculateRoutePriceImpact(inUsd, outUsd, routeInfo, bundle.priceImpact ?? null)
          : calculateRoutePriceImpact(inUsd, outUsd, routeInfo, bundle.priceImpact ?? null);

        return {
          inputToken,
          inputAmount,
          outputAmount: outRaw,
          outputAmountFormatted: outFmt,
          exchangeRate: inNum > 0 ? outNum / inNum : 0,
          inputUsdValue: inUsd,
          outputUsdValue: outUsd,
          priceImpact,
          gasEstimate: bundle.gas,
          tx: { to: bundle.tx.to, data: bundle.tx.data, value: bundle.tx.value },
          route: [],
          routeInfo,
        };
      }

      // Custom routes for external vault inputs (uCVX, aCVX, aCRV, afCVX, scrvUSD)
      // Enso's aggregator can't route arbitrary external-vault tokens, so we
      // redeem them to their underlying first and then route to the output.
      if (
        inputExternalConfig &&
        !(outputIsPxCvx || outputIsCvgCvx || outputIsLpxCvx) &&
        !outputIsYld
      ) {
        const isUcvx =
          inputExternalConfig.interface === "erc4626" &&
          inputExternalConfig.underlying.toLowerCase() === TOKENS.PXCVX.toLowerCase();
        const bundle =
          isUcvx
            ? await fetchAnyFromUCvxRoute({
                fromAddress: userAddress,
                outputToken: outputToken.address,
                amountIn: amountInWei,
                slippage,
              })
            : inputExternalConfig.interface === "ucrv"
              ? await fetchAnyFromUCrvRoute({
                  fromAddress: userAddress,
                  outputToken: outputToken.address,
                  amountIn: amountInWei,
                  slippage,
                })
              : inputExternalConfig.interface === "beefy"
                ? await fetchAnyFromBeefyRoute({
                    fromAddress: userAddress,
                    beefyVault: inputToken.address,
                    beefyVaultUnderlying: inputExternalConfig.underlying,
                    beefyVaultSymbol: inputExternalConfig.symbol,
                    outputToken: outputToken.address,
                    amountIn: amountInWei,
                    slippage,
                  })
                : await fetchAnyFromErc4626ExternalVaultRoute({
                    fromAddress: userAddress,
                    externalVault: inputToken.address,
                    externalVaultUnderlying: inputExternalConfig.underlying,
                    outputToken: outputToken.address,
                    amountIn: amountInWei,
                    slippage,
                    protocolLabel: inputExternalConfig.protocol,
                  });

        const outRaw =
          bundle.amountsOut[outAddr] || bundle.amountsOut[outputToken.address] || "0";
        const outFmt = formatUnits(BigInt(outRaw), outputDecimals);
        const inNum = Number(inputAmount);
        const outNum = Number(outFmt);

        // Input uCVX/uCRV/Beefy etc. don't have Enso price feeds; value via
        // the vault's underlying (estimated using the same preview helpers
        // the route builders use) × underlying market price.
        const [priceMap, underlyingAmount] = await Promise.all([
          getPrices([inputExternalConfig.underlying, outputToken.address, TOKENS.PXCVX]),
          (async (): Promise<number> => {
            try {
              if (inputExternalConfig.interface === "ucrv") {
                const raw = await previewUCrvWithdraw(amountInWei);
                return Number(raw) / 1e18;
              }
              if (inputExternalConfig.interface === "beefy") {
                const raw = await previewBeefyWithdraw(
                  inputToken.address,
                  amountInWei,
                );
                return Number(raw) / 1e18;
              }
              // ERC4626: assetsPerShare × share count (resilient across RPCs).
              const aps = await getAssetsPerShare(
                publicClient,
                inputToken.address as `0x${string}`,
              );
              if (aps !== null) return Number(inputAmount) * aps;
            } catch {
              // fall through
            }
            return 0;
          })(),
        ]);
        const underPx =
          priceMap.get(inputExternalConfig.underlying.toLowerCase()) ?? null;
        const outPx = priceMap.get(outputToken.address.toLowerCase()) ?? null;
        const inUsd =
          underPx !== null && underlyingAmount > 0
            ? underlyingAmount * underPx
            : null;
        const outUsd = outPx !== null ? outNum * outPx : null;
        const priceImpact = calculateRoutePriceImpact(
          inUsd,
          outUsd,
          bundle.routeInfo,
          bundle.priceImpact ?? null,
        );

        return {
          inputToken,
          inputAmount,
          outputAmount: outRaw,
          outputAmountFormatted: outFmt,
          exchangeRate: inNum > 0 ? outNum / inNum : 0,
          inputUsdValue: inUsd,
          outputUsdValue: outUsd,
          priceImpact,
          gasEstimate: bundle.gas,
          tx: { to: bundle.tx.to, data: bundle.tx.data, value: bundle.tx.value },
          route: [],
          routeInfo: bundle.routeInfo,
        };
      }

      // Custom routes for illiquid inputs (pxCVX/cvgCVX/lpxCVX → any token)
      if (
        (inputIsPxCvx || inputIsCvgCvx || inputIsLpxCvx) &&
        !(outputIsPxCvx || outputIsCvgCvx || outputIsLpxCvx)
      ) {
        const bundle = inputIsPxCvx
          ? await fetchAnyFromPxCvxRoute({
              fromAddress: userAddress,
              outputToken: outputToken.address,
              amountIn: amountInWei,
              slippage,
            })
          : inputIsCvgCvx
          ? await fetchAnyFromCvgCvxRoute({
              fromAddress: userAddress,
              outputToken: outputToken.address,
              amountIn: amountInWei,
              slippage,
            })
          : await fetchAnyFromLpxCvxRoute({
              fromAddress: userAddress,
              outputToken: outputToken.address,
              amountIn: amountInWei,
              slippage,
            });

        const outRaw =
          bundle.amountsOut[outAddr] || bundle.amountsOut[outputToken.address] || "0";
        const outFmt = formatUnits(BigInt(outRaw), outputDecimals);
        const inNum = Number(inputAmount);
        const outNum = Number(outFmt);

        // Price impact: treat the illiquid input as 1 CVX-equivalent. The loss
        // vs market mid-price captures Curve pool depth + any Enso slippage on
        // the CVX → output hop.
        const priceMap = await getPrices([TOKENS.CVX, outputToken.address]);
        const cvxPx = priceMap.get(TOKENS.CVX.toLowerCase()) ?? null;
        const outPx = priceMap.get(outputToken.address.toLowerCase()) ?? null;
        const inUsd = cvxPx !== null ? inNum * cvxPx : null;
        const outUsd = outPx !== null ? outNum * outPx : null;
        const priceImpact = calculateRoutePriceImpact(
          inUsd,
          outUsd,
          bundle.routeInfo,
          bundle.priceImpact ?? null,
        );

        return {
          inputToken,
          inputAmount,
          outputAmount: outRaw,
          outputAmountFormatted: outFmt,
          exchangeRate: inNum > 0 ? outNum / inNum : 0,
          inputUsdValue: inUsd,
          outputUsdValue: outUsd,
          priceImpact,
          gasEstimate: bundle.gas,
          tx: { to: bundle.tx.to, data: bundle.tx.data, value: bundle.tx.value },
          route: [],
          routeInfo: bundle.routeInfo,
        };
      }

      // Custom hybrid routes for illiquid targets (Enso aggregator has no good route)
      if (outputIsPxCvx || outputIsCvgCvx || outputIsLpxCvx) {
        const bundle = outputIsPxCvx
          ? await fetchAnyToPxCvxRoute({
              fromAddress: userAddress,
              inputToken: inputToken.address,
              amountIn: amountInWei,
              slippage,
            })
          : outputIsCvgCvx
          ? await fetchAnyToCvgCvxRoute({
              fromAddress: userAddress,
              inputToken: inputToken.address,
              amountIn: amountInWei,
              slippage,
            })
          : await fetchAnyToLpxCvxRoute({
              fromAddress: userAddress,
              inputToken: inputToken.address,
              amountIn: amountInWei,
              slippage,
            });

        const outRaw =
          bundle.amountsOut[outAddr] || bundle.amountsOut[outputToken.address] || "0";
        const outFmt = formatUnits(BigInt(outRaw), outputDecimals);
        const inNum = Number(inputAmount);
        const outNum = Number(outFmt);

        // Price impact should measure only actual routing slippage (the
        // input → CVX Enso leg). The CVX → pxCVX/cvgCVX/lpxCVX leg is either a
        // 1:1 mint (no slippage) or a Curve pool swap that can return a peg
        // bonus (shown as "+X vs mint" on the route). Conflating the bonus
        // with slippage would cause the summary to show a "gain" that the user
        // can't actually realize on secondary markets.
        const priceMap = await getPrices([inputToken.address, TOKENS.CVX, outputToken.address]);
        const inPx = priceMap.get(inputToken.address.toLowerCase()) ?? null;
        const cvxPx = priceMap.get(TOKENS.CVX.toLowerCase()) ?? null;
        const marketOutPx = priceMap.get(outputToken.address.toLowerCase()) ?? null;
        const inUsd = inPx !== null ? inNum * inPx : null;
        const marketOutUsd = marketOutPx !== null ? outNum * marketOutPx : null;
        const priceImpact = calculateCvxLegPriceImpact({
          inputUsd: inUsd,
          cvxUsd: cvxPx,
          routeInfo: bundle.routeInfo,
        });
        const routeInfo = annotateEnsoStepSlippage(bundle.routeInfo, priceImpact);

        return {
          inputToken,
          inputAmount,
          outputAmount: outRaw,
          outputAmountFormatted: outFmt,
          exchangeRate: inNum > 0 ? outNum / inNum : 0,
          inputUsdValue: inUsd,
          // Market-price value (what pxCVX/cvgCVX/lpxCVX is worth today).
          outputUsdValue: marketOutUsd,
          priceImpact,
          gasEstimate: bundle.gas,
          tx: { to: bundle.tx.to, data: bundle.tx.data, value: bundle.tx.value },
          route: [],
          routeInfo,
        };
      }

      if (isLegacyMorphoToken(inputToken.address)) {
        const bundle = await fetchLegacyMorphoWrapRoute({
          fromAddress: userAddress,
          outputToken: outputToken.address,
          amountIn: amountInWei,
          slippage,
        });
        const outRaw =
          bundle.amountsOut[outputToken.address.toLowerCase()] ||
          bundle.amountsOut[outputToken.address] ||
          "0";
        const outFmt = formatUnits(BigInt(outRaw), outputDecimals);
        const inNum = Number(inputAmount);
        const outNum = Number(outFmt);

        const priceMap = await getPrices([inputToken.address, MORPHO_TOKEN_ADDRESS, outputToken.address]);
        const morphoPx = priceMap.get(MORPHO_TOKEN_ADDRESS.toLowerCase()) ?? null;
        const legacyPx = priceMap.get(inputToken.address.toLowerCase()) ?? null;
        const outPx = priceMap.get(outputToken.address.toLowerCase()) ?? null;
        const inputPrice = morphoPx ?? legacyPx;
        const inUsd = inputPrice !== null ? inNum * inputPrice : null;
        const outUsd = outPx !== null ? outNum * outPx : null;
        const priceImpact = calculateValueDeltaImpact(inUsd, outUsd, bundle.priceImpact ?? null);
        const routeInfo = annotateEnsoStepSlippage(bundle.routeInfo, priceImpact);

        return {
          inputToken,
          inputAmount,
          outputAmount: outRaw,
          outputAmountFormatted: outFmt,
          exchangeRate: inNum > 0 ? outNum / inNum : 0,
          inputUsdValue: inUsd,
          outputUsdValue: outUsd,
          priceImpact,
          gasEstimate: bundle.gas,
          tx: { to: bundle.tx.to, data: bundle.tx.data, value: bundle.tx.value },
          route: [],
          routeInfo,
        };
      }

      const route = await fetchRoute({
        fromAddress: userAddress,
        tokenIn: inputToken.address,
        tokenOut: outputToken.address,
        amountIn: amountInWei,
        slippage,
        receiver: userAddress,
      });
      const outFmt = formatUnits(BigInt(route.amountOut), outputDecimals);
      const inNum = Number(inputAmount);
      const outNum = Number(outFmt);

      const priceMap = await getPrices([inputToken.address, outputToken.address]);
      const inPx = priceMap.get(inputToken.address.toLowerCase()) ?? null;
      const outPx = priceMap.get(outputToken.address.toLowerCase()) ?? null;
      const inUsd = inPx !== null ? inNum * inPx : null;
      const outUsd = outPx !== null ? outNum * outPx : null;

      return {
        inputToken,
        inputAmount,
        outputAmount: route.amountOut,
        outputAmountFormatted: outFmt,
        exchangeRate: inNum > 0 ? outNum / inNum : 0,
        inputUsdValue: inUsd,
        outputUsdValue: outUsd,
        priceImpact: calculateValueDeltaImpact(inUsd, outUsd, route.priceImpact ?? null),
        gasEstimate: route.gas,
        tx: { to: route.tx.to, data: route.tx.data, value: route.tx.value },
        route: route.route,
        routeInfo: buildSimpleRouteInfo(inputToken.symbol, outputToken.symbol),
      };
    },
    enabled,
    staleTime: 15 * 1000,
    refetchInterval: enabled ? 60 * 1000 : false,
    retry: false,
  });

  return {
    quote: data,
    isLoading: isLoading || isFetching,
    error: error as Error | null,
    refetch,
  };
}
