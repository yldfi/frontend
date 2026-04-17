"use client";

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient } from "wagmi";
import { parseUnits, formatUnits } from "viem";
import { fetchZapInRoute, fetchZapOutRoute, fetchVaultToVaultRoute, fetchCvgCvxZapInRoute, fetchCvgCvxZapOutRoute, fetchPxCvxZapInRoute, fetchPxCvxZapOutRoute, fetchExternalVaultZapInRoute, fetchLpxCvxZapInRoute, fetchPxCvxTokenZapInRoute, isPxCvxToken, isLpxCvxToken, fetchTokenPrices, getCvgCvxReverseSwapRate, getLpxCvxToCvxSwapRate, CVXCRV_ADDRESS, isYldfiVault, getTokenSymbol } from "@/lib/enso";
import { TOKENS, getVaultByAddress, isExternalVaultToken, getExternalVaultConfig } from "@/config/vaults";
import { useTestNetwork } from "@/contexts/TestNetworkContext";
import type { EnsoToken, ZapQuote, ZapDirection, RouteInfo, RouteStep } from "@/types/enso";
import { ERC4626_ABI } from "@/lib/abis";
import { PUBLIC_RPC_URLS } from "@/config/rpc";

/**
 * Build route info for vault-to-vault zaps
 */
function buildVaultToVaultRouteInfo(
  sourceVaultAddress: string,
  targetVaultAddress: string,
  sourceUnderlyingAddress: string,
  targetUnderlyingAddress: string,
  sourceUnderlyingAmount?: string,  // Amount after redeem (calculated from convertToAssets)
  targetUnderlyingAmount?: string   // Amount after swap (from amountsOut if different underlying)
): RouteInfo {
  const sourceVault = getVaultByAddress(sourceVaultAddress);
  const targetVault = getVaultByAddress(targetVaultAddress);

  const sourceSymbol = sourceVault?.symbol || getTokenSymbol(sourceVaultAddress);
  const targetSymbol = targetVault?.symbol || getTokenSymbol(targetVaultAddress);

  const sameUnderlying = sourceUnderlyingAddress.toLowerCase() === targetUnderlyingAddress.toLowerCase();
  const sourceUnderlyingSymbol = getTokenSymbol(sourceUnderlyingAddress);
  const targetUnderlyingSymbol = getTokenSymbol(targetUnderlyingAddress);

  const steps: RouteStep[] = [
    {
      tokenSymbol: sourceSymbol,
      action: "Redeem",
      description: `${sourceSymbol} for ${sourceUnderlyingSymbol}`,
      protocol: "yld",
    },
  ];

  if (!sameUnderlying) {
    steps.push({
      tokenSymbol: sourceUnderlyingSymbol,
      action: "Swap",
      description: `${sourceUnderlyingSymbol} for ${targetUnderlyingSymbol}`,
      protocol: "Enso",
      amount: sourceUnderlyingAmount,
    });
    steps.push({
      tokenSymbol: targetUnderlyingSymbol,
      action: "Deposit",
      description: `${targetUnderlyingSymbol} into ${targetSymbol}`,
      protocol: "yld",
      amount: targetUnderlyingAmount,
    });
  } else {
    steps.push({
      tokenSymbol: sourceUnderlyingSymbol,
      action: "Deposit",
      description: `${sourceUnderlyingSymbol} into ${targetSymbol}`,
      protocol: "yld",
      amount: sourceUnderlyingAmount,
    });
  }

  steps.push({
    tokenSymbol: targetSymbol,
    action: "Receive",
    description: `${targetSymbol} shares`,
    protocol: "yld",
  });

  return { steps };
}

/**
 * Build route info for standard zap in (token → vault)
 */
function buildZapInRouteInfo(
  inputToken: EnsoToken,
  vaultAddress: string,
  underlyingAddress: string,
  vaultSharesOut?: string,
  assetsPerShare?: number | null
): RouteInfo {
  const vault = getVaultByAddress(vaultAddress);
  const vaultSymbol = vault?.symbol || getTokenSymbol(vaultAddress);
  const underlyingSymbol = getTokenSymbol(underlyingAddress);
  const inputSymbol = inputToken.symbol;

  // Calculate intermediate amount: vault shares × assetsPerShare = underlying deposited
  let underlyingAmount: string | undefined;
  if (vaultSharesOut && assetsPerShare) {
    const vaultShares = Number(formatUnits(BigInt(vaultSharesOut), 18));
    underlyingAmount = (vaultShares * assetsPerShare).toFixed(4);
  }

  const steps: RouteStep[] = [];

  // If input is the underlying, direct deposit
  if (inputToken.address.toLowerCase() === underlyingAddress.toLowerCase()) {
    steps.push({
      tokenSymbol: inputSymbol,
      action: "Deposit",
      description: `${inputSymbol} into ${vaultSymbol}`,
      protocol: "yld",
    });
  } else {
    // Swap → deposit
    steps.push({
      tokenSymbol: inputSymbol,
      action: "Swap",
      description: `${inputSymbol} for ${underlyingSymbol}`,
      protocol: "Enso",
    });
    steps.push({
      tokenSymbol: underlyingSymbol,
      action: "Deposit",
      description: `${underlyingSymbol} into ${vaultSymbol}`,
      protocol: "yld",
      amount: underlyingAmount,
    });
  }

  steps.push({
    tokenSymbol: vaultSymbol,
    action: "Receive",
    description: `${vaultSymbol} shares`,
    protocol: "yld",
  });

  return { steps };
}

/**
 * Build route info for standard zap out (vault → token)
 */
function buildZapOutRouteInfo(
  outputToken: EnsoToken,
  vaultAddress: string,
  underlyingAddress: string,
  amountsOut?: Record<string, string>,
  intermediateAmount?: string  // Calculated from vault shares × assetsPerShare
): RouteInfo {
  const vault = getVaultByAddress(vaultAddress);
  const vaultSymbol = vault?.symbol || getTokenSymbol(vaultAddress);
  const underlyingSymbol = getTokenSymbol(underlyingAddress);
  const outputSymbol = outputToken.symbol;

  // Use calculated intermediate amount, or try to get from amountsOut
  let underlyingAmount = intermediateAmount;
  if (!underlyingAmount) {
    const underlyingAmountRaw = amountsOut?.[underlyingAddress.toLowerCase()] || amountsOut?.[underlyingAddress];
    underlyingAmount = underlyingAmountRaw ? Number(formatUnits(BigInt(underlyingAmountRaw), 18)).toFixed(4) : undefined;
  }

  const steps: RouteStep[] = [
    {
      tokenSymbol: vaultSymbol,
      action: "Redeem",
      description: `${vaultSymbol} for ${underlyingSymbol}`,
      protocol: "yld",
    },
  ];

  // If output is the underlying, direct redeem (no swap needed)
  if (outputToken.address.toLowerCase() !== underlyingAddress.toLowerCase()) {
    steps.push({
      tokenSymbol: underlyingSymbol,
      action: "Swap",
      description: `${underlyingSymbol} for ${outputSymbol}`,
      protocol: "Enso",
      amount: underlyingAmount,
    });
  }

  steps.push({
    tokenSymbol: outputSymbol,
    action: "Receive",
    description: "tokens",
    protocol: outputToken.address.toLowerCase() === underlyingAddress.toLowerCase() ? "yld" : "Enso",
  });

  return { steps };
}


interface UseZapQuoteParams {
  inputToken: EnsoToken | null;
  outputToken: EnsoToken | null;
  inputAmount: string;
  direction: ZapDirection;
  vaultAddress: string;
  underlyingToken?: string; // Vault's underlying token address
  slippage?: string; // basis points, default "100" = 1%
  underlyingTokenPrice?: number; // For illiquid tokens like cvgCVX
  paused?: boolean; // Pause quote fetching (e.g., when modals are open)
}

/**
 * Calculate real price impact from USD values
 * Returns: ((inputUsd - outputUsd) / inputUsd) × 100
 * Positive = loss (bad), Negative = gain (good)
 */
function calculatePriceImpact(inputUsd: number | null, outputUsd: number | null): number | null {
  if (inputUsd === null || outputUsd === null || inputUsd === 0) {
    return null;
  }
  return ((inputUsd - outputUsd) / inputUsd) * 100;
}

/**
 * Fetch token price from Enso API
 * Returns price in USD, or null if not available
 */
async function _getTokenPrice(address: string): Promise<number | null> {
  try {
    const prices = await fetchTokenPrices([address]);
    if (prices.length > 0) {
      return prices[0].price;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Batch fetch multiple token prices from Enso API
 * Returns a Map of address -> price (null if not available)
 * More efficient than multiple getTokenPrice calls
 */
async function getTokenPrices(addresses: string[]): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (addresses.length === 0) return result;

  try {
    const prices = await fetchTokenPrices(addresses);
    for (const p of prices) {
      result.set(p.address.toLowerCase(), p.price);
    }
  } catch {
    // On error, set all to null
  }

  // Ensure all requested addresses have an entry
  for (const addr of addresses) {
    if (!result.has(addr.toLowerCase())) {
      result.set(addr.toLowerCase(), null);
    }
  }

  return result;
}

/**
 * Get vault's assets per share (exchange rate)
 * Returns how many underlying tokens (cvxCRV) each share is worth
 */
// convertToAssets(uint256) selector + uint256(1e18) padded to 32 bytes
const CONVERT_TO_ASSETS_1E18_CALLDATA =
  "0x07a2d13a0000000000000000000000000000000000000000000000000de0b6b3a7640000";

async function readPpsViaRpc(vaultAddress: string): Promise<number | null> {
  const rpcUrls = [PUBLIC_RPC_URLS.drpc, PUBLIC_RPC_URLS.publicnode, PUBLIC_RPC_URLS.onerpc].filter(Boolean);
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

async function getVaultAssetsPerShare(
  publicClient: ReturnType<typeof usePublicClient>,
  vaultAddress: `0x${string}`
): Promise<number | null> {
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

export function useZapQuote({
  inputToken,
  outputToken,
  inputAmount,
  direction,
  vaultAddress,
  underlyingToken,
  slippage = "50",
  underlyingTokenPrice,
  paused = false,
}: UseZapQuoteParams) {
  const { address: userAddress } = useAccount();
  const publicClient = usePublicClient();
  const { isTestNetwork } = useTestNetwork();
  // Check if vault uses cvgCVX or pxCVX as underlying (requires custom routing)
  const isCvgCvxVault = underlyingToken?.toLowerCase() === TOKENS.CVGCVX.toLowerCase();
  const isPxCvxVault = underlyingToken?.toLowerCase() === TOKENS.PXCVX.toLowerCase();
  const vaultConfig = getVaultByAddress(vaultAddress);
  const vaultSymbol = vaultConfig?.symbol || "Vault Shares";
  const vaultName = vaultConfig?.name || "Vault Shares";

  // Determine token addresses based on direction
  // Zap In: inputToken → underlying (then vault deposits)
  // Zap Out: vault shares → underlying → outputToken
  const underlying = underlyingToken || CVXCRV_ADDRESS;
  const tokenIn = direction === "in" ? inputToken?.address : underlying;
  const tokenOut = direction === "in" ? underlying : outputToken?.address;
  const decimals = direction === "in" ? inputToken?.decimals : 18;

  // Parse input amount to wei
  let amountInWei = "0";
  try {
    if (inputAmount && decimals && Number(inputAmount) > 0) {
      amountInWei = parseUnits(inputAmount, decimals).toString();
    }
  } catch {
    // Invalid amount
  }

  const enabled =
    !paused &&
    !!userAddress &&
    !!tokenIn &&
    !!tokenOut &&
    amountInWei !== "0" &&
    (direction === "in" ? !!inputToken : !!outputToken);

  // Check if this is a vault-to-vault zap
  // Zap Out: current vault → another yld vault
  // Zap In: another yld vault → current vault
  const isVaultToVaultOut = direction === "out" && outputToken && isYldfiVault(outputToken.address);
  const isVaultToVaultIn = direction === "in" && inputToken && isYldfiVault(inputToken.address);
  const isVaultToVault = isVaultToVaultOut || isVaultToVaultIn;

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["zap-quote", tokenIn, tokenOut, amountInWei, slippage, userAddress, isVaultToVault, vaultAddress, inputToken?.address, isCvgCvxVault, isPxCvxVault, inputToken?.address ? isExternalVaultToken(inputToken.address) : false],
    queryFn: async (): Promise<ZapQuote | null> => {
      if (!userAddress || !tokenIn || !tokenOut) return null;

      // Vault-to-vault zap: use bundle endpoint for redeem + deposit
      // Check this FIRST before cvgCVX check, since fetchVaultToVaultRoute
      // handles cvgCVX vaults internally via fetchCvgCvxVaultToVaultRoute
      if (isVaultToVaultOut && outputToken) {
        // Zap Out to another vault: current vault → target vault
        const bundle = await fetchVaultToVaultRoute({
          fromAddress: userAddress,
          sourceVault: vaultAddress,
          targetVault: outputToken.address,
          amountIn: amountInWei,
          slippage: slippage,
        });

        // Get output amount from amountsOut (keyed by token address)
        const outputAmountRaw = bundle.amountsOut[outputToken.address.toLowerCase()]
          || bundle.amountsOut[outputToken.address]
          || "0";
        const outputDecimals = outputToken.decimals ?? 18;
        const outputAmountFormatted = formatUnits(BigInt(outputAmountRaw), outputDecimals);

        const inputNum = Number(inputAmount);
        const outputNum = Number(outputAmountFormatted);
        const exchangeRate = inputNum > 0 ? outputNum / inputNum : 0;

        // Get underlying token prices for BOTH vaults (they may have different underlying tokens)
        // For V2V OUT: source = current vault, so use underlyingTokenPrice if available (for illiquid tokens)
        const sourceUnderlyingToken = underlyingToken || CVXCRV_ADDRESS;
        const targetVaultConfig = getVaultByAddress(outputToken.address);
        const targetUnderlyingToken = targetVaultConfig?.assetAddress || CVXCRV_ADDRESS;

        // Fetch prices from Enso (batched for efficiency) and vault exchange rates in parallel
        const [priceMap, sourceAssetsPerShare, targetAssetsPerShare] = await Promise.all([
          getTokenPrices([sourceUnderlyingToken, targetUnderlyingToken]),
          getVaultAssetsPerShare(publicClient, vaultAddress as `0x${string}`),
          getVaultAssetsPerShare(publicClient, outputToken.address as `0x${string}`),
        ]);
        // Prefer Enso price for consistency, fall back to passed price for illiquid tokens without Enso data
        const ensoSourcePrice = priceMap.get(sourceUnderlyingToken.toLowerCase()) ?? null;
        const targetUnderlyingPrice = priceMap.get(targetUnderlyingToken.toLowerCase()) ?? null;
        const sourceUnderlyingPrice = ensoSourcePrice ?? underlyingTokenPrice ?? null;

        const inputUnderlyingValue = sourceAssetsPerShare !== null ? inputNum * sourceAssetsPerShare : inputNum;
        const inputUsdValue = sourceUnderlyingPrice !== null ? inputUnderlyingValue * sourceUnderlyingPrice : null;
        const outputUnderlyingValue = targetAssetsPerShare !== null ? outputNum * targetAssetsPerShare : outputNum;
        const outputUsdValue = targetUnderlyingPrice !== null ? outputUnderlyingValue * targetUnderlyingPrice : null;
        const priceImpact = calculatePriceImpact(inputUsdValue, outputUsdValue);

        return {
          inputToken: {
            address: vaultAddress,
            symbol: vaultSymbol,
            name: vaultName,
            decimals: 18,
            chainId: 1,
            type: "defi",
          } as EnsoToken,
          inputAmount,
          outputAmount: outputAmountRaw,
          outputAmountFormatted,
          exchangeRate,
          inputUsdValue,
          outputUsdValue,
          priceImpact,
          gasEstimate: bundle.gas,
          tx: {
            to: bundle.tx.to,
            data: bundle.tx.data,
            value: bundle.tx.value,
          },
          route: [],
          // Use routeInfo from bundle if available (custom routes like cvgCVX have detailed info)
          // Otherwise build generic vault-to-vault route info
          routeInfo: (bundle as { routeInfo?: RouteInfo }).routeInfo ?? (() => {
            // Use already-calculated values for intermediate amounts
            // sourceUnderlyingAmount = input vault shares × source assetsPerShare
            const sourceUnderlyingAmount = inputUnderlyingValue.toFixed(4);
            // targetUnderlyingAmount = output vault shares × target assetsPerShare
            const targetUnderlyingAmount = outputUnderlyingValue.toFixed(4);

            return buildVaultToVaultRouteInfo(
              vaultAddress,
              outputToken.address,
              sourceUnderlyingToken,
              targetUnderlyingToken,
              sourceUnderlyingAmount,
              targetUnderlyingAmount
            );
          })(),
        };
      }

      if (isVaultToVaultIn && inputToken) {
        // Zap In from another vault: source vault → current vault
        const bundle = await fetchVaultToVaultRoute({
          fromAddress: userAddress,
          sourceVault: inputToken.address,
          targetVault: vaultAddress,
          amountIn: amountInWei,
          slippage: slippage,
        });

        const outputAmountRaw = bundle.amountsOut[vaultAddress.toLowerCase()]
          || bundle.amountsOut[vaultAddress]
          || "0";
        const outputAmountFormatted = formatUnits(BigInt(outputAmountRaw), 18);

        const inputNum = Number(inputAmount);
        const outputNum = Number(outputAmountFormatted);
        const exchangeRate = inputNum > 0 ? outputNum / inputNum : 0;

        // Get underlying token prices for BOTH vaults (they may have different underlying tokens)
        // For V2V IN: target = current vault, so use underlyingTokenPrice if available (for illiquid tokens)
        const sourceVaultConfig = getVaultByAddress(inputToken.address);
        const sourceUnderlyingToken = sourceVaultConfig?.assetAddress || CVXCRV_ADDRESS;
        const targetUnderlyingToken = underlyingToken || CVXCRV_ADDRESS;

        // Fetch prices from Enso (batched for efficiency) and vault exchange rates in parallel
        const [priceMap, sourceAssetsPerShare, targetAssetsPerShare] = await Promise.all([
          getTokenPrices([sourceUnderlyingToken, targetUnderlyingToken]),
          getVaultAssetsPerShare(publicClient, inputToken.address as `0x${string}`),
          getVaultAssetsPerShare(publicClient, vaultAddress as `0x${string}`),
        ]);
        // Prefer Enso price for consistency, fall back to passed price for illiquid tokens without Enso data
        const sourceUnderlyingPrice = priceMap.get(sourceUnderlyingToken.toLowerCase()) ?? null;
        const ensoTargetPrice = priceMap.get(targetUnderlyingToken.toLowerCase()) ?? null;
        const targetUnderlyingPrice = ensoTargetPrice ?? underlyingTokenPrice ?? null;

        const inputUnderlyingValue = sourceAssetsPerShare !== null ? inputNum * sourceAssetsPerShare : inputNum;
        const inputUsdValue = sourceUnderlyingPrice !== null ? inputUnderlyingValue * sourceUnderlyingPrice : null;
        const outputUnderlyingValue = targetAssetsPerShare !== null ? outputNum * targetAssetsPerShare : outputNum;
        const outputUsdValue = targetUnderlyingPrice !== null ? outputUnderlyingValue * targetUnderlyingPrice : null;
        const priceImpact = calculatePriceImpact(inputUsdValue, outputUsdValue);

        return {
          // Manually construct inputToken from vault config to ensure correct address
          // This matches how Zap Out constructs its inputToken (line ~764)
          inputToken: {
            address: sourceVaultConfig?.address ?? inputToken.address,
            symbol: sourceVaultConfig?.symbol ?? inputToken.symbol ?? "Vault Shares",
            name: sourceVaultConfig?.name ?? inputToken.name ?? "Vault Shares",
            decimals: sourceVaultConfig?.decimals ?? inputToken.decimals ?? 18,
            chainId: 1,
            type: "defi",
            logoURI: sourceVaultConfig?.logo ?? inputToken.logoURI,
          } as EnsoToken,
          inputAmount,
          outputAmount: outputAmountRaw,
          outputAmountFormatted,
          exchangeRate,
          inputUsdValue,
          outputUsdValue,
          priceImpact,
          gasEstimate: bundle.gas,
          tx: {
            to: bundle.tx.to,
            data: bundle.tx.data,
            value: bundle.tx.value,
          },
          route: [],
          // Use routeInfo from bundle if available (custom routes like cvgCVX have detailed info)
          // Otherwise build generic vault-to-vault route info
          routeInfo: (bundle as { routeInfo?: RouteInfo }).routeInfo ?? (() => {
            // Use already-calculated values for intermediate amounts
            // sourceUnderlyingAmount = input vault shares × source assetsPerShare
            const sourceUnderlyingAmount = inputUnderlyingValue.toFixed(4);
            // targetUnderlyingAmount = output vault shares × target assetsPerShare
            const targetUnderlyingAmount = outputUnderlyingValue.toFixed(4);

            return buildVaultToVaultRouteInfo(
              inputToken.address,
              vaultAddress,
              sourceUnderlyingToken,
              targetUnderlyingToken,
              sourceUnderlyingAmount,
              targetUnderlyingAmount
            );
          })(),
        };
      }

      // External vault input (Llama Airforce, Concentrator, Beefy)
      // These are external vaults users may hold that we can zap FROM into yld vaults
      if (direction === "in" && inputToken && isExternalVaultToken(inputToken.address)) {
        const externalConfig = getExternalVaultConfig(inputToken.address);
        if (!externalConfig) {
          throw new Error(`Unknown external vault: ${inputToken.address}`);
        }

        const bundle = await fetchExternalVaultZapInRoute({
          fromAddress: userAddress,
          vaultAddress,
          externalVaultAddress: inputToken.address,
          amountIn: amountInWei,
          slippage: slippage,
        });

        const outputAmountRaw = bundle.amountsOut[vaultAddress.toLowerCase()]
          || bundle.amountsOut[vaultAddress]
          || "0";
        const outputAmountFormatted = formatUnits(BigInt(outputAmountRaw), 18);

        const inputNum = Number(inputAmount);
        const outputNum = Number(outputAmountFormatted);
        const exchangeRate = inputNum > 0 ? outputNum / inputNum : 0;

        // Price impact calculation for external vault zap
        // Input: external vault shares → underlying value
        // Output: yld vault shares → underlying value
        const [priceMap, targetAssetsPerShare] = await Promise.all([
          getTokenPrices([externalConfig.underlying, underlyingToken || CVXCRV_ADDRESS]),
          getVaultAssetsPerShare(publicClient, vaultAddress as `0x${string}`),
        ]);

        const externalUnderlyingPrice = priceMap.get(externalConfig.underlying.toLowerCase()) ?? null;
        const targetUnderlyingPrice = priceMap.get((underlyingToken || CVXCRV_ADDRESS).toLowerCase()) ?? null;

        // For external vaults, estimate input value from bundle (we don't have direct price for vault token)
        // Use output value as proxy since the bundle does the conversion
        const outputUnderlyingValue = targetAssetsPerShare !== null ? outputNum * targetAssetsPerShare : outputNum;
        const outputUsdValue = targetUnderlyingPrice !== null ? outputUnderlyingValue * targetUnderlyingPrice : null;

        // Estimate input USD value (rough approximation using external underlying price)
        // This is an approximation since we don't have exact price for external vault token
        const inputUsdValue = externalUnderlyingPrice !== null && outputUsdValue !== null
          ? outputUsdValue * 1.02 // Assume ~2% exit cost for external vault
          : null;

        const priceImpact = calculatePriceImpact(inputUsdValue, outputUsdValue);

        return {
          inputToken,
          inputAmount,
          outputAmount: outputAmountRaw,
          outputAmountFormatted,
          exchangeRate,
          inputUsdValue,
          outputUsdValue,
          priceImpact,
          gasEstimate: bundle.gas,
          tx: {
            to: bundle.tx.to,
            data: bundle.tx.data,
            value: bundle.tx.value,
          },
          route: [],
          routeInfo: bundle.routeInfo,
        };
      }

      // lpxCVX input token → any yld vault
      // Route: lpxCVX → unwrap to pxCVX (for yspxCVX) or → swap via Curve to CVX → route to target
      if (direction === "in" && inputToken && isLpxCvxToken(inputToken.address)) {
        const bundle = await fetchLpxCvxZapInRoute({
          fromAddress: userAddress,
          vaultAddress,
          amountIn: amountInWei,
          slippage: slippage,
        });

        const outputAmountRaw = bundle.amountsOut[vaultAddress.toLowerCase()]
          || bundle.amountsOut[vaultAddress]
          || "0";
        const outputAmountFormatted = formatUnits(BigInt(outputAmountRaw), 18);

        const inputNum = Number(inputAmount);
        const outputNum = Number(outputAmountFormatted);
        const exchangeRate = inputNum > 0 ? outputNum / inputNum : 0;

        // Price impact calculation for lpxCVX zap
        const [priceMap, targetAssetsPerShare] = await Promise.all([
          getTokenPrices([TOKENS.LPXCVX, underlyingToken || CVXCRV_ADDRESS]),
          getVaultAssetsPerShare(publicClient, vaultAddress as `0x${string}`),
        ]);

        const lpxCvxPrice = priceMap.get(TOKENS.LPXCVX.toLowerCase()) ?? null;
        const targetUnderlyingPrice = priceMap.get((underlyingToken || CVXCRV_ADDRESS).toLowerCase()) ?? null;

        const inputUsdValue = lpxCvxPrice !== null ? inputNum * lpxCvxPrice : null;
        const outputUnderlyingValue = targetAssetsPerShare !== null ? outputNum * targetAssetsPerShare : outputNum;
        const outputUsdValue = targetUnderlyingPrice !== null ? outputUnderlyingValue * targetUnderlyingPrice : null;
        const priceImpact = calculatePriceImpact(inputUsdValue, outputUsdValue);

        return {
          inputToken,
          inputAmount,
          outputAmount: outputAmountRaw,
          outputAmountFormatted,
          exchangeRate,
          inputUsdValue,
          outputUsdValue,
          priceImpact,
          gasEstimate: bundle.gas,
          tx: {
            to: bundle.tx.to,
            data: bundle.tx.data,
            value: bundle.tx.value,
          },
          route: [],
          routeInfo: bundle.routeInfo,
        };
      }

      // pxCVX input token → non-pxCVX yld vault (pxCVX → yspxCVX is direct deposit, handled by standard zap)
      // Route: pxCVX → wrap to lpxCVX → swap via Curve to CVX → route to target underlying → deposit
      // Note: pxCVX → yspxCVX is handled by standard zap since pxCVX is the underlying
      if (direction === "in" && inputToken && isPxCvxToken(inputToken.address) && !isPxCvxVault) {
        const bundle = await fetchPxCvxTokenZapInRoute({
          fromAddress: userAddress,
          vaultAddress,
          amountIn: amountInWei,
          slippage: slippage,
        });

        const outputAmountRaw = bundle.amountsOut[vaultAddress.toLowerCase()]
          || bundle.amountsOut[vaultAddress]
          || "0";
        const outputAmountFormatted = formatUnits(BigInt(outputAmountRaw), 18);

        const inputNum = Number(inputAmount);
        const outputNum = Number(outputAmountFormatted);
        const exchangeRate = inputNum > 0 ? outputNum / inputNum : 0;

        // Price impact calculation for pxCVX token zap
        const [priceMap, targetAssetsPerShare] = await Promise.all([
          getTokenPrices([TOKENS.PXCVX, underlyingToken || CVXCRV_ADDRESS]),
          getVaultAssetsPerShare(publicClient, vaultAddress as `0x${string}`),
        ]);

        const pxCvxPrice = priceMap.get(TOKENS.PXCVX.toLowerCase()) ?? null;
        const targetUnderlyingPrice = priceMap.get((underlyingToken || CVXCRV_ADDRESS).toLowerCase()) ?? null;

        const inputUsdValue = pxCvxPrice !== null ? inputNum * pxCvxPrice : null;
        const outputUnderlyingValue = targetAssetsPerShare !== null ? outputNum * targetAssetsPerShare : outputNum;
        const outputUsdValue = targetUnderlyingPrice !== null ? outputUnderlyingValue * targetUnderlyingPrice : null;
        const priceImpact = calculatePriceImpact(inputUsdValue, outputUsdValue);

        return {
          inputToken,
          inputAmount,
          outputAmount: outputAmountRaw,
          outputAmountFormatted,
          exchangeRate,
          inputUsdValue,
          outputUsdValue,
          priceImpact,
          gasEstimate: bundle.gas,
          tx: {
            to: bundle.tx.to,
            data: bundle.tx.data,
            value: bundle.tx.value,
          },
          route: [],
          routeInfo: bundle.routeInfo,
        };
      }

      // cvgCVX vault requires custom routing (no DEX liquidity)
      // Only for non-vault-to-vault zaps (regular token in/out)
      if (isCvgCvxVault) {
        if (direction === "in" && inputToken) {
          const bundle = await fetchCvgCvxZapInRoute({
            fromAddress: userAddress,
            vaultAddress,
            inputToken: inputToken.address,
            amountIn: amountInWei,
            slippage: slippage,

          });

          const outputAmountRaw = bundle.amountsOut[vaultAddress.toLowerCase()]
            || bundle.amountsOut[vaultAddress]
            || "0";
          const outputAmountFormatted = formatUnits(BigInt(outputAmountRaw), 18);

          const inputNum = Number(inputAmount);
          const outputNum = Number(outputAmountFormatted);
          const exchangeRate = inputNum > 0 ? outputNum / inputNum : 0;

          // Price impact calculation for cvgCVX (batched price fetch)
          const [priceMap, assetsPerShare] = await Promise.all([
            getTokenPrices([inputToken.address, TOKENS.CVGCVX]),
            getVaultAssetsPerShare(publicClient, vaultAddress as `0x${string}`),
          ]);
          const inputTokenPrice = priceMap.get(inputToken.address.toLowerCase()) ?? null;
          const cvgCvxPrice = priceMap.get(TOKENS.CVGCVX.toLowerCase()) ?? null;

          const inputUsdValue = inputTokenPrice !== null ? inputNum * inputTokenPrice : null;
          const outputCvgCvxValue = assetsPerShare !== null ? outputNum * assetsPerShare : outputNum;
          const outputUsdValue = cvgCvxPrice !== null ? outputCvgCvxValue * cvgCvxPrice : null;
          const priceImpact = calculatePriceImpact(inputUsdValue, outputUsdValue);

          return {
            inputToken,
            inputAmount,
            outputAmount: outputAmountRaw,
            outputAmountFormatted,
            exchangeRate,
            inputUsdValue,
            outputUsdValue,
            priceImpact,
            gasEstimate: bundle.gas,
            tx: {
              to: bundle.tx.to,
              data: bundle.tx.data,
              value: bundle.tx.value,
            },
            route: [],
            routeInfo: bundle.routeInfo,
          };
        }

        if (direction === "out" && outputToken) {
          const bundle = await fetchCvgCvxZapOutRoute({
            fromAddress: userAddress,
            vaultAddress,
            outputToken: outputToken.address,
            amountIn: amountInWei,
            slippage: slippage,

          });

          const outputAmountRaw = bundle.amountsOut[outputToken.address.toLowerCase()]
            || bundle.amountsOut[outputToken.address]
            || "0";
          const outputDecimals = outputToken.decimals ?? 18;
          const outputAmountFormatted = formatUnits(BigInt(outputAmountRaw), outputDecimals);

          const inputNum = Number(inputAmount);
          const outputNum = Number(outputAmountFormatted);
          const exchangeRate = inputNum > 0 ? outputNum / inputNum : 0;

          // Price impact calculation for cvgCVX (batched price fetch)
          const [priceMap, assetsPerShare] = await Promise.all([
            getTokenPrices([outputToken.address, TOKENS.CVGCVX]),
            getVaultAssetsPerShare(publicClient, vaultAddress as `0x${string}`),
          ]);
          const outputTokenPrice = priceMap.get(outputToken.address.toLowerCase()) ?? null;
          const cvgCvxPrice = priceMap.get(TOKENS.CVGCVX.toLowerCase()) ?? null;

          const inputCvgCvxValue = assetsPerShare !== null ? inputNum * assetsPerShare : inputNum;
          const inputUsdValue = cvgCvxPrice !== null ? inputCvgCvxValue * cvgCvxPrice : null;
          const outputUsdValue = outputTokenPrice !== null ? outputNum * outputTokenPrice : null;
          const priceImpact = calculatePriceImpact(inputUsdValue, outputUsdValue);

          // Intermediate amounts for the route display
          const cvgCvxAmountFmt = inputCvgCvxValue.toFixed(4);
          let cvxAmountFmt: string | undefined;
          try {
            const cvgCvxWei = parseUnits(inputCvgCvxValue.toFixed(18), 18).toString();
            const cvxOut = await getCvgCvxReverseSwapRate(cvgCvxWei);
            if (cvxOut > 0n) cvxAmountFmt = (Number(cvxOut) / 1e18).toFixed(4);
          } catch {
            // leave undefined
          }

          return {
            inputToken: {
              address: vaultAddress,
              symbol: vaultSymbol,
              name: vaultName,
              decimals: 18,
              chainId: 1,
              type: "defi",
            } as EnsoToken,
            inputAmount,
            outputAmount: outputAmountRaw,
            outputAmountFormatted,
            exchangeRate,
            inputUsdValue,
            outputUsdValue,
            priceImpact,
            gasEstimate: bundle.gas,
            tx: {
              to: bundle.tx.to,
              data: bundle.tx.data,
              value: bundle.tx.value,
            },
            route: [],
            routeInfo: {
              steps: [
                { tokenSymbol: vaultSymbol, action: "Redeem", description: `${vaultSymbol} for cvgCVX`, protocol: "yld" },
                { tokenSymbol: "cvgCVX", amount: cvgCvxAmountFmt, action: "Swap", description: "cvgCVX → CVX1 → CVX", protocol: "LiquidBoost" },
                { tokenSymbol: "CVX", amount: cvxAmountFmt, action: "Swap", description: `CVX for ${outputToken.symbol}`, protocol: "Enso" },
                { tokenSymbol: outputToken.symbol, action: "Receive", description: "tokens", protocol: "Enso" },
              ],
            },
          };
        }
      }

      // pxCVX vault requires custom routing (no DEX liquidity)
      // Only for non-vault-to-vault zaps (regular token in/out)
      if (isPxCvxVault) {
        if (direction === "in" && inputToken) {
          const bundle = await fetchPxCvxZapInRoute({
            fromAddress: userAddress,
            vaultAddress,
            inputToken: inputToken.address,
            amountIn: amountInWei,
            slippage: slippage,

          });

          const outputAmountRaw = bundle.amountsOut[vaultAddress.toLowerCase()]
            || bundle.amountsOut[vaultAddress]
            || "0";
          const outputAmountFormatted = formatUnits(BigInt(outputAmountRaw), 18);

          const inputNum = Number(inputAmount);
          const outputNum = Number(outputAmountFormatted);
          const exchangeRate = inputNum > 0 ? outputNum / inputNum : 0;

          // Price impact calculation for pxCVX (batched price fetch)
          const [priceMap, assetsPerShare] = await Promise.all([
            getTokenPrices([inputToken.address, TOKENS.PXCVX]),
            getVaultAssetsPerShare(publicClient, vaultAddress as `0x${string}`),
          ]);
          const inputTokenPrice = priceMap.get(inputToken.address.toLowerCase()) ?? null;
          const pxCvxPrice = priceMap.get(TOKENS.PXCVX.toLowerCase()) ?? null;

          const inputUsdValue = inputTokenPrice !== null ? inputNum * inputTokenPrice : null;
          const outputPxCvxValue = assetsPerShare !== null ? outputNum * assetsPerShare : outputNum;
          const outputUsdValue = pxCvxPrice !== null ? outputPxCvxValue * pxCvxPrice : null;
          const priceImpact = calculatePriceImpact(inputUsdValue, outputUsdValue);

          return {
            inputToken,
            inputAmount,
            outputAmount: outputAmountRaw,
            outputAmountFormatted,
            exchangeRate,
            inputUsdValue,
            outputUsdValue,
            priceImpact,
            gasEstimate: bundle.gas,
            tx: {
              to: bundle.tx.to,
              data: bundle.tx.data,
              value: bundle.tx.value,
            },
            route: [],
            routeInfo: bundle.routeInfo,
          };
        }

        if (direction === "out" && outputToken) {
          const bundle = await fetchPxCvxZapOutRoute({
            fromAddress: userAddress,
            vaultAddress,
            outputToken: outputToken.address,
            amountIn: amountInWei,
            slippage: slippage,
          });

          const outputAmountRaw = bundle.amountsOut[outputToken.address.toLowerCase()]
            || bundle.amountsOut[outputToken.address]
            || "0";
          const outputDecimals = outputToken.decimals ?? 18;
          const outputAmountFormatted = formatUnits(BigInt(outputAmountRaw), outputDecimals);

          const inputNum = Number(inputAmount);
          const outputNum = Number(outputAmountFormatted);
          const exchangeRate = inputNum > 0 ? outputNum / inputNum : 0;

          // Price impact calculation for pxCVX (batched price fetch)
          const [priceMap, assetsPerShare] = await Promise.all([
            getTokenPrices([outputToken.address, TOKENS.PXCVX]),
            getVaultAssetsPerShare(publicClient, vaultAddress as `0x${string}`),
          ]);
          const outputTokenPrice = priceMap.get(outputToken.address.toLowerCase()) ?? null;
          const pxCvxPrice = priceMap.get(TOKENS.PXCVX.toLowerCase()) ?? null;

          const inputPxCvxValue = assetsPerShare !== null ? inputNum * assetsPerShare : inputNum;
          const inputUsdValue = pxCvxPrice !== null ? inputPxCvxValue * pxCvxPrice : null;
          const outputUsdValue = outputTokenPrice !== null ? outputNum * outputTokenPrice : null;
          const priceImpact = calculatePriceImpact(inputUsdValue, outputUsdValue);

          const pxCvxAmountFmt = inputPxCvxValue.toFixed(4);
          let cvxAmountFmt: string | undefined;
          try {
            const pxCvxWei = parseUnits(inputPxCvxValue.toFixed(18), 18).toString();
            const cvxOut = await getLpxCvxToCvxSwapRate(pxCvxWei);
            if (cvxOut > 0n) cvxAmountFmt = (Number(cvxOut) / 1e18).toFixed(4);
          } catch {
            // leave undefined
          }

          return {
            inputToken: {
              address: vaultAddress,
              symbol: vaultSymbol,
              name: vaultName,
              decimals: 18,
              chainId: 1,
              type: "defi",
            } as EnsoToken,
            inputAmount,
            outputAmount: outputAmountRaw,
            outputAmountFormatted,
            exchangeRate,
            inputUsdValue,
            outputUsdValue,
            priceImpact,
            gasEstimate: bundle.gas,
            tx: {
              to: bundle.tx.to,
              data: bundle.tx.data,
              value: bundle.tx.value,
            },
            route: [],
            routeInfo: {
              steps: [
                { tokenSymbol: vaultSymbol, action: "Redeem", description: `${vaultSymbol} for pxCVX`, protocol: "yld" },
                { tokenSymbol: "pxCVX", amount: pxCvxAmountFmt, action: "Swap", description: "pxCVX for CVX", protocol: "Curve" },
                { tokenSymbol: "CVX", amount: cvxAmountFmt, action: "Swap", description: `CVX for ${outputToken.symbol}`, protocol: "Enso" },
                { tokenSymbol: outputToken.symbol, action: "Receive", description: "tokens", protocol: "Enso" },
              ],
            },
          };
        }
      }

      // Zap Out to regular token (ETH, USDC, etc.)
      // Bundle: redeem from vault → swap cvxCRV to output token
      if (direction === "out" && outputToken) {
        const bundle = await fetchZapOutRoute({
          fromAddress: userAddress,
          vaultAddress,
          outputToken: outputToken.address,
          amountIn: amountInWei,
          slippage: slippage,
        });

        // Get output amount from amountsOut (keyed by token address)
        const outputAmountRaw = bundle.amountsOut[outputToken.address.toLowerCase()]
          || bundle.amountsOut[outputToken.address]
          || "0";
        const outputDecimals = outputToken.decimals ?? 18;
        const outputAmountFormatted = formatUnits(BigInt(outputAmountRaw), outputDecimals);

        // Calculate exchange rate
        const inputNum = Number(inputAmount);
        const outputNum = Number(outputAmountFormatted);
        const exchangeRate = inputNum > 0 ? outputNum / inputNum : 0;

        // Calculate real price impact from USD values
        // Input: vault shares × assetsPerShare × cvxCRV price
        // Output: output token amount × output token price (batched price fetch)
        const [priceMap, assetsPerShare] = await Promise.all([
          getTokenPrices([outputToken.address, CVXCRV_ADDRESS]),
          getVaultAssetsPerShare(publicClient, vaultAddress as `0x${string}`),
        ]);
        const outputTokenPrice = priceMap.get(outputToken.address.toLowerCase()) ?? null;
        const cvxCrvPrice = priceMap.get(CVXCRV_ADDRESS.toLowerCase()) ?? null;

        // Vault shares are worth (shares × assetsPerShare) in cvxCRV
        const inputCvxCrvValue = assetsPerShare !== null ? inputNum * assetsPerShare : inputNum;
        const inputUsdValue = cvxCrvPrice !== null ? inputCvxCrvValue * cvxCrvPrice : null;
        const outputUsdValue = outputTokenPrice !== null ? outputNum * outputTokenPrice : null;
        const priceImpact = calculatePriceImpact(inputUsdValue, outputUsdValue);

        const quote: ZapQuote = {
          inputToken: {
            address: vaultAddress,
            symbol: vaultSymbol,
            name: vaultName,
            decimals: 18,
            chainId: 1,
            type: "defi",
          } as EnsoToken,
          inputAmount,
          outputAmount: outputAmountRaw,
          outputAmountFormatted,
          exchangeRate,
          inputUsdValue,
          outputUsdValue,
          priceImpact,
          gasEstimate: bundle.gas,
          tx: {
            to: bundle.tx.to,
            data: bundle.tx.data,
            value: bundle.tx.value,
          },
          route: [],
          routeInfo: (() => {
            // Calculate intermediate underlying amount: input shares × assetsPerShare
            const intermediateAmount = assetsPerShare !== null
              ? (inputNum * assetsPerShare).toFixed(4)
              : undefined;
            // Use custom route info with correct messaging (don't merge with hops)
            return buildZapOutRouteInfo(outputToken, vaultAddress, underlying, bundle.amountsOut, intermediateAmount);
          })(),
        };

        return quote;
      }

      // Zap In from regular token (ETH, USDC, etc.)
      // Bundle: swap input token to cvxCRV → deposit into vault
      if (direction === "in" && inputToken) {
        const bundle = await fetchZapInRoute({
          fromAddress: userAddress,
          vaultAddress,
          inputToken: inputToken.address,
          amountIn: amountInWei,
          slippage: slippage,
        });

        // Get output amount from amountsOut (keyed by token address)
        const outputAmountRaw = bundle.amountsOut[vaultAddress.toLowerCase()]
          || bundle.amountsOut[vaultAddress]
          || "0";
        const outputDecimals = 18; // Vault shares are 18 decimals
        const outputAmountFormatted = formatUnits(BigInt(outputAmountRaw), outputDecimals);

        // Calculate exchange rate
        const inputNum = Number(inputAmount);
        const outputNum = Number(outputAmountFormatted);
        const exchangeRate = inputNum > 0 ? outputNum / inputNum : 0;

        // Calculate real price impact from USD values
        // Input: input token amount × input token price
        // Output: vault shares × assetsPerShare × cvxCRV price (batched price fetch)
        const [priceMap, assetsPerShare] = await Promise.all([
          getTokenPrices([inputToken.address, CVXCRV_ADDRESS]),
          getVaultAssetsPerShare(publicClient, vaultAddress as `0x${string}`),
        ]);
        const inputTokenPrice = priceMap.get(inputToken.address.toLowerCase()) ?? null;
        const cvxCrvPrice = priceMap.get(CVXCRV_ADDRESS.toLowerCase()) ?? null;

        const inputUsdValue = inputTokenPrice !== null ? inputNum * inputTokenPrice : null;
        // Vault shares are worth (shares × assetsPerShare) in cvxCRV
        const outputCvxCrvValue = assetsPerShare !== null ? outputNum * assetsPerShare : outputNum;
        const outputUsdValue = cvxCrvPrice !== null ? outputCvxCrvValue * cvxCrvPrice : null;
        const priceImpact = calculatePriceImpact(inputUsdValue, outputUsdValue);

        const quote: ZapQuote = {
          inputToken: inputToken,
          inputAmount,
          outputAmount: outputAmountRaw,
          outputAmountFormatted,
          exchangeRate,
          inputUsdValue,
          outputUsdValue,
          priceImpact,
          gasEstimate: bundle.gas,
          tx: {
            to: bundle.tx.to,
            data: bundle.tx.data,
            value: bundle.tx.value,
          },
          route: [],
          routeInfo: buildZapInRouteInfo(inputToken, vaultAddress, underlying, outputAmountRaw, assetsPerShare),
        };

        return quote;
      }

      // Fallback - should not reach here
      return null;
    },
    enabled,
    staleTime: 15 * 1000, // 15 seconds - quotes are time-sensitive
    refetchInterval: enabled ? 30 * 1000 : false, // Refresh quote every 30 seconds
    retry: 1,
  });

  // Validate quote with eth_call on quote refresh (dev only)
  // - Mainnet: use debug trace API (DEBUG_RPC_URL) for detailed traces
  // - VNet: use publicClient.call() directly (goes to VNet RPC via Frame)
  const prevTxDataRef = useRef<string | null>(null);
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    if (!data?.tx || !userAddress || !publicClient) return;

    // Only run when tx data changes (not on every render)
    const txKey = `${data.tx.to}-${data.tx.data}`;
    if (prevTxDataRef.current === txKey) return;
    prevTxDataRef.current = txKey;

    if (isTestNetwork) {
      // Test network: use publicClient.call() directly (goes to test RPC)
      publicClient
        .call({
          account: userAddress,
          to: data.tx.to as `0x${string}`,
          data: data.tx.data as `0x${string}`,
          value: data.tx.value ? BigInt(data.tx.value) : 0n,
        })
        .then((result) => {
          console.log("[TestNet] eth_call SUCCESS", { data: result.data });
        })
        .catch((error: Error) => {
          console.log("[TestNet] eth_call FAILED:", error.message);
          console.warn(
            "[TestNet] Note: Test forks don't stay in sync with mainnet. " +
            "Enso quotes are based on current mainnet state, which may differ from your fork's state. " +
            "If this failure seems unexpected, try creating a fresher fork."
          );
        });
    } else {
      // Mainnet: call debug trace API for detailed traces
      fetch("/api/debug-trace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: userAddress,
          to: data.tx.to,
          data: data.tx.data,
          value: data.tx.value ? `0x${BigInt(data.tx.value).toString(16)}` : "0x0",
        }),
      })
        .then((res) => res.json() as Promise<{
          success: boolean;
          ethCallSuccess?: boolean;
          error?: string;
          debugInfo?: {
            ethCallError?: { message?: string; code?: number };
            trace?: { error?: string; revertReason?: string; from?: string; to?: string };
            failingCall?: { to?: string; error?: string; revertReason?: string; functionSelector?: string };
            fullTrace?: unknown;
          };
        }>)
        .then((result) => {
          if (!result.success) {
            if (result.error !== "DEBUG_RPC_URL not configured") {
              console.log("[Debug RPC] API error:", result.error);
            }
          } else if (result.ethCallSuccess) {
            console.log("[Debug RPC] eth_call SUCCESS");
          } else if (result.debugInfo) {
            console.log("[Debug RPC] eth_call FAILED:", result.debugInfo.ethCallError);
            if (result.debugInfo.trace) {
              console.log("[Debug RPC] Trace result:", result.debugInfo.trace);
            }
            if (result.debugInfo.failingCall) {
              console.log("[Debug RPC] Failing call:", result.debugInfo.failingCall);
            }
            if (result.debugInfo.fullTrace) {
              console.log("[Debug RPC] Full trace (copy to .json file for analysis):");
              console.log(JSON.stringify(result.debugInfo.fullTrace, null, 2));
            }
          }
        })
        .catch(() => {
          // Silently ignore - debug trace is optional
        });
    }
  }, [data?.tx, userAddress, isTestNetwork, publicClient]);

  return {
    quote: data,
    isLoading: isLoading || isFetching,
    error: error as Error | null,
    refetch,
  };
}
