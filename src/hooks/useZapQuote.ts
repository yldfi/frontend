"use client";

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient } from "wagmi";
import { parseUnits, formatUnits } from "viem";
import { fetchZapInRoute, fetchZapOutRoute, fetchVaultToVaultRoute, fetchCvgCvxZapInRoute, fetchCvgCvxZapOutRoute, fetchPxCvxZapInRoute, fetchPxCvxZapOutRoute, fetchTokenPrices, CVXCRV_ADDRESS, isYldfiVault, getTokenSymbol } from "@/lib/enso";
import { TOKENS, getVaultByAddress } from "@/config/vaults";
import { useTenderly } from "@/contexts/TenderlyContext";
import type { EnsoToken, ZapQuote, ZapDirection, RouteInfo, RouteStep } from "@/types/enso";

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
      protocol: "yld_fi",
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
      protocol: "yld_fi",
      amount: targetUnderlyingAmount,
    });
  } else {
    steps.push({
      tokenSymbol: sourceUnderlyingSymbol,
      action: "Deposit",
      description: `${sourceUnderlyingSymbol} into ${targetSymbol}`,
      protocol: "yld_fi",
      amount: sourceUnderlyingAmount,
    });
  }

  steps.push({
    tokenSymbol: targetSymbol,
    action: "Receive",
    description: `${targetSymbol} shares`,
    protocol: "yld_fi",
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
      protocol: "yld_fi",
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
      protocol: "yld_fi",
      amount: underlyingAmount,
    });
  }

  steps.push({
    tokenSymbol: vaultSymbol,
    action: "Receive",
    description: `${vaultSymbol} shares`,
    protocol: "yld_fi",
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
      protocol: "yld_fi",
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
    protocol: outputToken.address.toLowerCase() === underlyingAddress.toLowerCase() ? "yld_fi" : "Enso",
  });

  return { steps };
}

// ERC4626 ABI for convertToAssets
const ERC4626_ABI = [
  {
    inputs: [{ name: "shares", type: "uint256" }],
    name: "convertToAssets",
    outputs: [{ name: "assets", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

interface UseZapQuoteParams {
  inputToken: EnsoToken | null;
  outputToken: EnsoToken | null;
  inputAmount: string;
  direction: ZapDirection;
  vaultAddress: string;
  underlyingToken?: string; // Vault's underlying token address
  slippage?: string; // basis points, default "100" = 1%
  underlyingTokenPrice?: number; // For illiquid tokens like cvgCVX
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
async function getTokenPrice(address: string): Promise<number | null> {
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
 * Get vault's assets per share (exchange rate)
 * Returns how many underlying tokens (cvxCRV) each share is worth
 */
async function getVaultAssetsPerShare(
  publicClient: ReturnType<typeof usePublicClient>,
  vaultAddress: `0x${string}`
): Promise<number | null> {
  if (!publicClient) return null;
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
    return null;
  }
}

export function useZapQuote({
  inputToken,
  outputToken,
  inputAmount,
  direction,
  vaultAddress,
  underlyingToken,
  slippage = "100",
}: UseZapQuoteParams) {
  const { address: userAddress } = useAccount();
  const publicClient = usePublicClient();
  const { isTenderlyVNet } = useTenderly();

  // Check if vault uses cvgCVX or pxCVX as underlying (requires custom routing)
  const isCvgCvxVault = underlyingToken?.toLowerCase() === TOKENS.CVGCVX.toLowerCase();
  const isPxCvxVault = underlyingToken?.toLowerCase() === TOKENS.PXCVX.toLowerCase();

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
    !!userAddress &&
    !!tokenIn &&
    !!tokenOut &&
    amountInWei !== "0" &&
    (direction === "in" ? !!inputToken : !!outputToken);

  // Check if this is a vault-to-vault zap
  // Zap Out: current vault → another yld_fi vault
  // Zap In: another yld_fi vault → current vault
  const isVaultToVaultOut = direction === "out" && outputToken && isYldfiVault(outputToken.address);
  const isVaultToVaultIn = direction === "in" && inputToken && isYldfiVault(inputToken.address);
  const isVaultToVault = isVaultToVaultOut || isVaultToVaultIn;

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["zap-quote", tokenIn, tokenOut, amountInWei, slippage, userAddress, isVaultToVault, vaultAddress, inputToken?.address, isCvgCvxVault, isPxCvxVault],
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
          slippage,
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
        const sourceUnderlyingToken = underlyingToken || CVXCRV_ADDRESS;
        const targetVaultConfig = getVaultByAddress(outputToken.address);
        const targetUnderlyingToken = targetVaultConfig?.assetAddress || CVXCRV_ADDRESS;

        const [sourceUnderlyingPrice, targetUnderlyingPrice, sourceAssetsPerShare, targetAssetsPerShare] = await Promise.all([
          getTokenPrice(sourceUnderlyingToken),
          getTokenPrice(targetUnderlyingToken),
          getVaultAssetsPerShare(publicClient, vaultAddress as `0x${string}`),
          getVaultAssetsPerShare(publicClient, outputToken.address as `0x${string}`),
        ]);

        const inputUnderlyingValue = sourceAssetsPerShare !== null ? inputNum * sourceAssetsPerShare : inputNum;
        const inputUsdValue = sourceUnderlyingPrice !== null ? inputUnderlyingValue * sourceUnderlyingPrice : null;
        const outputUnderlyingValue = targetAssetsPerShare !== null ? outputNum * targetAssetsPerShare : outputNum;
        const outputUsdValue = targetUnderlyingPrice !== null ? outputUnderlyingValue * targetUnderlyingPrice : null;
        const priceImpact = calculatePriceImpact(inputUsdValue, outputUsdValue);

        return {
          inputToken: {
            address: vaultAddress,
            symbol: "Vault Shares",
            name: "Vault Shares",
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
          slippage,
        });

        const outputAmountRaw = bundle.amountsOut[vaultAddress.toLowerCase()]
          || bundle.amountsOut[vaultAddress]
          || "0";
        const outputAmountFormatted = formatUnits(BigInt(outputAmountRaw), 18);

        const inputNum = Number(inputAmount);
        const outputNum = Number(outputAmountFormatted);
        const exchangeRate = inputNum > 0 ? outputNum / inputNum : 0;

        // Get underlying token prices for BOTH vaults (they may have different underlying tokens)
        const sourceVaultConfig = getVaultByAddress(inputToken.address);
        const sourceUnderlyingToken = sourceVaultConfig?.assetAddress || CVXCRV_ADDRESS;
        const targetUnderlyingToken = underlyingToken || CVXCRV_ADDRESS;

        const [sourceUnderlyingPrice, targetUnderlyingPrice, sourceAssetsPerShare, targetAssetsPerShare] = await Promise.all([
          getTokenPrice(sourceUnderlyingToken),
          getTokenPrice(targetUnderlyingToken),
          getVaultAssetsPerShare(publicClient, inputToken.address as `0x${string}`),
          getVaultAssetsPerShare(publicClient, vaultAddress as `0x${string}`),
        ]);

        const inputUnderlyingValue = sourceAssetsPerShare !== null ? inputNum * sourceAssetsPerShare : inputNum;
        const inputUsdValue = sourceUnderlyingPrice !== null ? inputUnderlyingValue * sourceUnderlyingPrice : null;
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

      // cvgCVX vault requires custom routing (no DEX liquidity)
      // Only for non-vault-to-vault zaps (regular token in/out)
      if (isCvgCvxVault) {
        if (direction === "in" && inputToken) {
          const bundle = await fetchCvgCvxZapInRoute({
            fromAddress: userAddress,
            vaultAddress,
            inputToken: inputToken.address,
            amountIn: amountInWei,
            slippage,
          });

          const outputAmountRaw = bundle.amountsOut[vaultAddress.toLowerCase()]
            || bundle.amountsOut[vaultAddress]
            || "0";
          const outputAmountFormatted = formatUnits(BigInt(outputAmountRaw), 18);

          const inputNum = Number(inputAmount);
          const outputNum = Number(outputAmountFormatted);
          const exchangeRate = inputNum > 0 ? outputNum / inputNum : 0;

          // Price impact calculation for cvgCVX
          const [inputTokenPrice, cvgCvxPrice, assetsPerShare] = await Promise.all([
            getTokenPrice(inputToken.address),
            getTokenPrice(TOKENS.CVGCVX),
            getVaultAssetsPerShare(publicClient, vaultAddress as `0x${string}`),
          ]);

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
            slippage,
          });

          const outputAmountRaw = bundle.amountsOut[outputToken.address.toLowerCase()]
            || bundle.amountsOut[outputToken.address]
            || "0";
          const outputDecimals = outputToken.decimals ?? 18;
          const outputAmountFormatted = formatUnits(BigInt(outputAmountRaw), outputDecimals);

          const inputNum = Number(inputAmount);
          const outputNum = Number(outputAmountFormatted);
          const exchangeRate = inputNum > 0 ? outputNum / inputNum : 0;

          // Price impact calculation for cvgCVX
          const [outputTokenPrice, cvgCvxPrice, assetsPerShare] = await Promise.all([
            getTokenPrice(outputToken.address),
            getTokenPrice(TOKENS.CVGCVX),
            getVaultAssetsPerShare(publicClient, vaultAddress as `0x${string}`),
          ]);

          const inputCvgCvxValue = assetsPerShare !== null ? inputNum * assetsPerShare : inputNum;
          const inputUsdValue = cvgCvxPrice !== null ? inputCvgCvxValue * cvgCvxPrice : null;
          const outputUsdValue = outputTokenPrice !== null ? outputNum * outputTokenPrice : null;
          const priceImpact = calculatePriceImpact(inputUsdValue, outputUsdValue);

          const vault = getVaultByAddress(vaultAddress);
          const vaultSymbol = vault?.symbol || "Vault";
          return {
            inputToken: {
              address: vaultAddress,
              symbol: "Vault Shares",
              name: "Vault Shares",
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
                { tokenSymbol: vaultSymbol, action: "Redeem", description: `${vaultSymbol} for cvgCVX`, protocol: "yld_fi" },
                { tokenSymbol: "cvgCVX", action: "Swap", description: "cvgCVX for CVX", protocol: "Curve" },
                { tokenSymbol: "CVX", action: "Swap", description: `CVX for ${outputToken.symbol}`, protocol: "Enso" },
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
            slippage,
          });

          const outputAmountRaw = bundle.amountsOut[vaultAddress.toLowerCase()]
            || bundle.amountsOut[vaultAddress]
            || "0";
          const outputAmountFormatted = formatUnits(BigInt(outputAmountRaw), 18);

          const inputNum = Number(inputAmount);
          const outputNum = Number(outputAmountFormatted);
          const exchangeRate = inputNum > 0 ? outputNum / inputNum : 0;

          // Price impact calculation for pxCVX
          const [inputTokenPrice, pxCvxPrice, assetsPerShare] = await Promise.all([
            getTokenPrice(inputToken.address),
            getTokenPrice(TOKENS.PXCVX),
            getVaultAssetsPerShare(publicClient, vaultAddress as `0x${string}`),
          ]);

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
            slippage,
          });

          const outputAmountRaw = bundle.amountsOut[outputToken.address.toLowerCase()]
            || bundle.amountsOut[outputToken.address]
            || "0";
          const outputDecimals = outputToken.decimals ?? 18;
          const outputAmountFormatted = formatUnits(BigInt(outputAmountRaw), outputDecimals);

          const inputNum = Number(inputAmount);
          const outputNum = Number(outputAmountFormatted);
          const exchangeRate = inputNum > 0 ? outputNum / inputNum : 0;

          // Price impact calculation for pxCVX
          const [outputTokenPrice, pxCvxPrice, assetsPerShare] = await Promise.all([
            getTokenPrice(outputToken.address),
            getTokenPrice(TOKENS.PXCVX),
            getVaultAssetsPerShare(publicClient, vaultAddress as `0x${string}`),
          ]);

          const inputPxCvxValue = assetsPerShare !== null ? inputNum * assetsPerShare : inputNum;
          const inputUsdValue = pxCvxPrice !== null ? inputPxCvxValue * pxCvxPrice : null;
          const outputUsdValue = outputTokenPrice !== null ? outputNum * outputTokenPrice : null;
          const priceImpact = calculatePriceImpact(inputUsdValue, outputUsdValue);

          const vault = getVaultByAddress(vaultAddress);
          const vaultSymbol = vault?.symbol || "Vault";
          return {
            inputToken: {
              address: vaultAddress,
              symbol: "Vault Shares",
              name: "Vault Shares",
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
                { tokenSymbol: vaultSymbol, action: "Redeem", description: `${vaultSymbol} for pxCVX`, protocol: "yld_fi" },
                { tokenSymbol: "pxCVX", action: "Swap", description: "pxCVX for CVX", protocol: "Curve" },
                { tokenSymbol: "CVX", action: "Swap", description: `CVX for ${outputToken.symbol}`, protocol: "Enso" },
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
          slippage,
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
        // Output: output token amount × output token price
        const [outputTokenPrice, cvxCrvPrice, assetsPerShare] = await Promise.all([
          getTokenPrice(outputToken.address),
          getTokenPrice(CVXCRV_ADDRESS),
          getVaultAssetsPerShare(publicClient, vaultAddress as `0x${string}`),
        ]);

        // Vault shares are worth (shares × assetsPerShare) in cvxCRV
        const inputCvxCrvValue = assetsPerShare !== null ? inputNum * assetsPerShare : inputNum;
        const inputUsdValue = cvxCrvPrice !== null ? inputCvxCrvValue * cvxCrvPrice : null;
        const outputUsdValue = outputTokenPrice !== null ? outputNum * outputTokenPrice : null;
        const priceImpact = calculatePriceImpact(inputUsdValue, outputUsdValue);

        const quote: ZapQuote = {
          inputToken: {
            address: vaultAddress,
            symbol: "Vault Shares",
            name: "Vault Shares",
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
          slippage,
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
        // Output: vault shares × assetsPerShare × cvxCRV price
        const [inputTokenPrice, cvxCrvPrice, assetsPerShare] = await Promise.all([
          getTokenPrice(inputToken.address),
          getTokenPrice(CVXCRV_ADDRESS),
          getVaultAssetsPerShare(publicClient, vaultAddress as `0x${string}`),
        ]);

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

    if (isTenderlyVNet) {
      // VNet: use publicClient.call() directly (goes to VNet RPC)
      publicClient
        .call({
          account: userAddress,
          to: data.tx.to as `0x${string}`,
          data: data.tx.data as `0x${string}`,
          value: data.tx.value ? BigInt(data.tx.value) : 0n,
        })
        .then((result) => {
          console.log("[VNet] eth_call SUCCESS", { data: result.data });
        })
        .catch((error: Error) => {
          console.log("[VNet] eth_call FAILED:", error.message);
          console.warn(
            "[VNet] Note: VNets fork from mainnet but don't stay in sync. " +
            "Enso quotes are based on current mainnet state, which may differ from your VNet's forked state. " +
            "If this failure seems unexpected, try creating a fresher VNet fork."
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
  }, [data?.tx, userAddress, isTenderlyVNet, publicClient]);

  return {
    quote: data,
    isLoading: isLoading || isFetching,
    error: error as Error | null,
    refetch,
  };
}
