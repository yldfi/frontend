// Curve LlamaLend bundle functions using Enso API
// Repay bundles only — loan creation, collateral, and leverage operations use the Zapper contract

import type { EnsoBundleAction, EnsoBundleResponse } from "@/types/enso";
import { CURVE_CONTROLLERS, VAULTS, EXTERNAL_VAULT_CONFIG, TOKENS, PIREX } from "@/config/vaults";
import { calculateMinDy } from "@/lib/curve";
import { getLpxCvxToCvxSwapRate } from "@/lib/enso";
import { previewRedeem } from "@/lib/curve/rpc";
import { CRVUSD_ADDRESS } from "@/config/addresses";

const CRVUSD = CRVUSD_ADDRESS;

function shouldUseIntentProxy(): boolean {
  return typeof window !== "undefined" && process.env.NODE_ENV !== "test";
}

// Vault info for repay routing
export interface VaultInfo {
  address: string;
  underlying: string;
  underlyingSymbol: string;
  underlyingDecimals: number;
  interface: "erc4626" | "ucrv" | "beefy";
}

// Check if an address is a yldfi vault or external vault and get its underlying token
export function getVaultInfo(tokenAddress: string): VaultInfo | null {
  const normalized = tokenAddress.toLowerCase();

  // Check yldfi vaults first
  for (const vault of Object.values(VAULTS)) {
    if (vault.address.toLowerCase() === normalized) {
      return {
        address: vault.address,
        underlying: vault.assetAddress,
        underlyingSymbol: vault.assetSymbol,
        underlyingDecimals: vault.assetDecimals,
        interface: "erc4626",
      };
    }
  }

  // Check external vaults (Union, Concentrator, Beefy)
  const externalVault = EXTERNAL_VAULT_CONFIG[normalized];
  if (externalVault) {
    // Map external vault interface to our VaultInfo interface
    let vaultInterface: "erc4626" | "ucrv" | "beefy" = "erc4626";
    if (externalVault.interface === "ucrv") {
      vaultInterface = "ucrv";
    } else if (externalVault.interface === "beefy") {
      vaultInterface = "beefy";
    }
    return {
      address: externalVault.address,
      underlying: externalVault.underlying,
      underlyingSymbol: externalVault.underlyingSymbol,
      underlyingDecimals: externalVault.underlyingDecimals,
      interface: vaultInterface,
    };
  }

  return null;
}

// remove_collateral ABI - 2-param version for router mode (msg.sender != user)
const CONTROLLER_REMOVE_COLLATERAL_FOR_ABI = "function remove_collateral(uint256 collateral, address _for)";

// Import the fetchBundle function from enso.ts
// We'll use dynamic import to avoid circular dependencies
async function fetchBundle(params: {
  fromAddress: string;
  actions: EnsoBundleAction[];
  receiver?: string;
  routingStrategy?: "router" | "delegate";
  skipQuote?: boolean;
}): Promise<EnsoBundleResponse> {
  const { fetchBundle: ensoFetchBundle } = await import("@/lib/enso");
  return ensoFetchBundle(params);
}

async function fetchRepayRouterBundle(params: {
  fromAddress: string;
  actions: EnsoBundleAction[];
}): Promise<EnsoBundleResponse> {
  // Repay bundles are built before the UI can request ERC20 allowance.
  // Keep approval and transaction simulation checks in the client flow.
  return fetchBundle({
    ...params,
    routingStrategy: "router",
    skipQuote: true,
  });
}

/**
 * Repay crvUSD debt
 * If repaying full amount, this closes the position
 */
export async function fetchRepayBundle(params: {
  fromAddress: string;
  vaultAddress: `0x${string}`;
  repayAmount: string;
  maxActiveBand?: number;
}): Promise<EnsoBundleResponse> {
  if (shouldUseIntentProxy()) {
    const { fetchEnsoIntent } = await import("@/lib/enso-intents");
    return fetchEnsoIntent<EnsoBundleResponse>({
      intent: "curveLendingRepay",
      fromAddress: params.fromAddress,
      vaultAddress: params.vaultAddress,
      amountIn: params.repayAmount,
      receiver: params.fromAddress,
    });
  }

  const controllerAddress = CURVE_CONTROLLERS[params.vaultAddress as keyof typeof CURVE_CONTROLLERS];
  if (!controllerAddress) {
    throw new Error(`No controller found for vault ${params.vaultAddress}`);
  }

  const actions: EnsoBundleAction[] = [
    // Repay debt using native curve-lending protocol action
    // This handles approval internally
    {
      protocol: "curve-lending",
      action: "repay",
      args: {
        tokenIn: CRVUSD,
        amountIn: params.repayAmount,
        primaryAddress: controllerAddress,
        onBehalfOf: params.fromAddress,
      },
    },
  ];

  return fetchRepayRouterBundle({
    fromAddress: params.fromAddress,
    actions,
  });
}


/**
 * Build direct repay actions (approve crvUSD to controller + call repay).
 * Used during soft-liquidation where Enso's `curve-lending/repay` action
 * calls `repay_extended()` which reverts (`assert ns[0] > cb.active_band`).
 * The controller's `repay()` function works fine during soft-liquidation.
 */
function buildDirectRepayActions(
  controllerAddress: string,
  fromAddress: string,
  crvUsdAmountRef: { useOutputOfCallAt: number },
): EnsoBundleAction[] {
  return [
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: CRVUSD,
        spender: controllerAddress,
        amount: crvUsdAmountRef,
      },
    },
    {
      protocol: "enso",
      action: "call",
      args: {
        address: controllerAddress.toLowerCase(),
        method: "repay",
        abi: "function repay(uint256 _d_debt, address _for)",
        args: [crvUsdAmountRef, fromAddress],
      },
    },
  ];
}

export async function fetchRepayWithSwapBundle(params: {
  fromAddress: string;
  vaultAddress: `0x${string}`;
  tokenIn: string; // Token to swap from
  amountIn: string; // Amount of tokenIn
  slippage?: number; // Slippage in basis points (default 100 = 1%)
  maxRepayAmount?: string; // Optional cap on repay amount (for closing loans)
  inSoftLiquidation?: boolean; // Use direct repay() call instead of curve-lending/repay
  withdrawAmount?: string; // Optional: collateral wei to withdraw after repay
  withdrawTokenOut?: string; // If different from collateral, swap after withdrawal
}): Promise<EnsoBundleResponse> {
  if (shouldUseIntentProxy()) {
    const { fetchEnsoIntent } = await import("@/lib/enso-intents");
    return fetchEnsoIntent<EnsoBundleResponse>({
      intent: "curveLendingRepayWithSwap",
      fromAddress: params.fromAddress,
      vaultAddress: params.vaultAddress,
      tokenIn: params.tokenIn,
      amountIn: params.amountIn,
      slippage: String(params.slippage ?? 100),
      inSoftLiquidation: params.inSoftLiquidation,
      receiver: params.fromAddress,
    });
  }

  const controllerAddress = CURVE_CONTROLLERS[params.vaultAddress as keyof typeof CURVE_CONTROLLERS];
  if (!controllerAddress) {
    throw new Error(`No controller found for vault ${params.vaultAddress}`);
  }

  const slippage = (params.slippage ?? 100).toString();

  // Check if tokenIn is a vault (yldfi or external) - if so, redeem first then swap underlying
  const vaultInfo = getVaultInfo(params.tokenIn);

  if (vaultInfo) {
    // Check if underlying is pxCVX - needs special routing via lpxCVX → CVX
    const isPxCvxUnderlying = vaultInfo.underlying.toLowerCase() === TOKENS.PXCVX.toLowerCase();

    if (isPxCvxUnderlying) {
      // pxCVX flow: redeem → wrap → swap lpxCVX→CVX → route CVX→crvUSD → repay
      // Estimate pxCVX output for slippage calculation
      const estimatedPxCvx = await previewRedeem(vaultInfo.address, params.amountIn);
      // lpxCVX wraps 1:1 from pxCVX
      const estimatedLpxCvx = estimatedPxCvx;
      // Get expected CVX output from Curve swap
      const expectedCvx = await getLpxCvxToCvxSwapRate(estimatedLpxCvx);
      if (expectedCvx === 0n) {
        throw new Error("Failed to estimate Curve lpxCVX→CVX swap output");
      }
      const slippageBps = params.slippage ?? 100;
      const minDyCvx = calculateMinDy(expectedCvx, slippageBps);

      const actions: EnsoBundleAction[] = [
        // Action 0: Redeem from vault to get pxCVX
        {
          protocol: "erc4626",
          action: "redeem",
          args: {
            tokenIn: params.tokenIn,
            tokenOut: TOKENS.PXCVX,
            amountIn: params.amountIn,
            primaryAddress: params.tokenIn,
          },
        },
        // Action 1: Approve pxCVX to lpxCVX contract for wrapping
        {
          protocol: "erc20",
          action: "approve",
          args: {
            token: TOKENS.PXCVX,
            spender: PIREX.LPXCVX,
            amount: { useOutputOfCallAt: 0 },
          },
        },
        // Action 2: Wrap pxCVX → lpxCVX (1:1 ratio)
        {
          protocol: "enso",
          action: "call",
          args: {
            address: PIREX.LPXCVX.toLowerCase(),
            method: "wrap",
            abi: "function wrap(uint256 amount)",
            args: [{ useOutputOfCallAt: 0 }],
          },
        },
        // Action 3: Approve lpxCVX to Curve pool for swap
        {
          protocol: "erc20",
          action: "approve",
          args: {
            token: PIREX.LPXCVX,
            spender: PIREX.LPXCVX_CVX_POOL,
            amount: { useOutputOfCallAt: 0 }, // Same as pxCVX (1:1 wrap)
          },
        },
        // Action 4: Swap lpxCVX → CVX on Curve pool
        {
          protocol: "enso",
          action: "call",
          args: {
            address: PIREX.LPXCVX_CVX_POOL.toLowerCase(),
            method: "exchange",
            abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) returns (uint256)",
            args: [
              String(PIREX.POOL_INDEX.LPXCVX), // i = 1 (lpxCVX)
              String(PIREX.POOL_INDEX.CVX), // j = 0 (CVX)
              { useOutputOfCallAt: 0 }, // dx = amount (same as pxCVX from redeem)
              minDyCvx, // min_dy with slippage protection
            ],
          },
        },
        // Action 5: Route CVX → crvUSD
        {
          protocol: "enso",
          action: "route",
          args: {
            tokenIn: TOKENS.CVX,
            tokenOut: CRVUSD,
            amountIn: { useOutputOfCallAt: 4 }, // Use output from Curve exchange
            slippage,
          },
        },
        // Action 6+: Repay debt
        ...(params.inSoftLiquidation
          ? buildDirectRepayActions(controllerAddress, params.fromAddress, { useOutputOfCallAt: 5 })
          : [{
              protocol: "curve-lending" as const,
              action: "repay" as const,
              args: {
                tokenIn: CRVUSD,
                amountIn: { useOutputOfCallAt: 5 },
                primaryAddress: controllerAddress,
                onBehalfOf: params.fromAddress,
              },
            }]),
      ];

      // Optional: withdraw collateral after repay
      if (params.withdrawAmount && params.withdrawAmount !== "0") {
        actions.push({
          protocol: "enso",
          action: "call",
          args: {
            address: controllerAddress.toLowerCase(),
            method: "remove_collateral",
            abi: CONTROLLER_REMOVE_COLLATERAL_FOR_ABI,
            args: [params.withdrawAmount, params.fromAddress],
          },
        });
        if (params.withdrawTokenOut && params.withdrawTokenOut.toLowerCase() !== params.vaultAddress.toLowerCase()) {
          actions.push({
            protocol: "enso",
            action: "route",
            args: {
              tokenIn: params.vaultAddress,
              tokenOut: params.withdrawTokenOut,
              amountIn: params.withdrawAmount,
            },
          });
        }
      }

      return fetchRepayRouterBundle({
        fromAddress: params.fromAddress,
        actions,
      });
    }

    // Standard vault token flow: redeem → swap underlying → repay
    const actions: EnsoBundleAction[] = [];

    // 1. Redeem from vault to get underlying token
    if (vaultInfo.interface === "ucrv") {
      // uCRV uses custom withdraw interface: withdraw(_to, _shares)
      actions.push({
        protocol: "enso",
        action: "call",
        args: {
          address: vaultInfo.address.toLowerCase(),
          method: "withdraw",
          abi: "function withdraw(address _to, uint256 _shares)",
          args: [params.fromAddress, params.amountIn],
        },
      });
    } else if (vaultInfo.interface === "beefy") {
      // Beefy uses withdraw(shares) - returns underlying to msg.sender (ENSO_SHORTCUTS)
      actions.push({
        protocol: "enso",
        action: "call",
        args: {
          address: vaultInfo.address.toLowerCase(),
          method: "withdraw",
          abi: "function withdraw(uint256 _shares)",
          args: [params.amountIn],
        },
      });
    } else {
      // Standard ERC4626 redeem
      actions.push({
        protocol: "erc4626",
        action: "redeem",
        args: {
          tokenIn: params.tokenIn,
          tokenOut: vaultInfo.underlying,
          amountIn: params.amountIn,
          primaryAddress: params.tokenIn,
        },
      });
    }

    // 2. If underlying is already crvUSD (e.g., scrvUSD), skip swap and repay directly
    if (vaultInfo.underlying.toLowerCase() === CRVUSD.toLowerCase()) {
      if (params.inSoftLiquidation) {
        // During soft-liquidation, use direct repay() call — curve-lending/repay uses
        // repay_extended() which reverts (assert ns[0] > cb.active_band)
        actions.push(...buildDirectRepayActions(controllerAddress, params.fromAddress, { useOutputOfCallAt: 0 }));
      } else {
        actions.push({
          protocol: "curve-lending",
          action: "repay",
          args: {
            tokenIn: CRVUSD,
            amountIn: { useOutputOfCallAt: 0 },
            primaryAddress: controllerAddress,
            onBehalfOf: params.fromAddress,
          },
        });
      }

      // Optional: withdraw collateral after repay
      if (params.withdrawAmount && params.withdrawAmount !== "0") {
        actions.push({
          protocol: "enso",
          action: "call",
          args: {
            address: controllerAddress.toLowerCase(),
            method: "remove_collateral",
            abi: CONTROLLER_REMOVE_COLLATERAL_FOR_ABI,
            args: [params.withdrawAmount, params.fromAddress],
          },
        });
        if (params.withdrawTokenOut && params.withdrawTokenOut.toLowerCase() !== params.vaultAddress.toLowerCase()) {
          actions.push({
            protocol: "enso",
            action: "route",
            args: {
              tokenIn: params.vaultAddress,
              tokenOut: params.withdrawTokenOut,
              amountIn: params.withdrawAmount,
            },
          });
        }
      }

      return fetchRepayRouterBundle({
        fromAddress: params.fromAddress,
        actions,
      });
    }

    // 3. Swap underlying to crvUSD
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: vaultInfo.underlying,
        tokenOut: CRVUSD,
        amountIn: { useOutputOfCallAt: 0 }, // Use output from redeem
        slippage,
      },
    });

    // 4. Repay debt
    if (params.inSoftLiquidation) {
      actions.push(...buildDirectRepayActions(controllerAddress, params.fromAddress, { useOutputOfCallAt: 1 }));
    } else {
      actions.push({
        protocol: "curve-lending",
        action: "repay",
        args: {
          tokenIn: CRVUSD,
          amountIn: { useOutputOfCallAt: 1 },
          primaryAddress: controllerAddress,
          onBehalfOf: params.fromAddress,
        },
      });
    }

    // Optional: withdraw collateral after repay
    if (params.withdrawAmount && params.withdrawAmount !== "0") {
      actions.push({
        protocol: "enso",
        action: "call",
        args: {
          address: controllerAddress.toLowerCase(),
          method: "remove_collateral",
          abi: CONTROLLER_REMOVE_COLLATERAL_FOR_ABI,
          args: [params.withdrawAmount, params.fromAddress],
        },
      });
      if (params.withdrawTokenOut && params.withdrawTokenOut.toLowerCase() !== params.vaultAddress.toLowerCase()) {
        actions.push({
          protocol: "enso",
          action: "route",
          args: {
            tokenIn: params.vaultAddress,
            tokenOut: params.withdrawTokenOut,
            amountIn: params.withdrawAmount,
          },
        });
      }
    }

    return fetchRepayRouterBundle({
      fromAddress: params.fromAddress,
      actions,
    });
  }

  // Regular token flow: swap → repay
  const actions: EnsoBundleAction[] = [
    // 1. Route/swap input token to crvUSD
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.tokenIn,
        tokenOut: CRVUSD,
        amountIn: params.amountIn,
        slippage,
      },
    },
  ];

  // 2. Repay debt
  if (params.inSoftLiquidation) {
    actions.push(...buildDirectRepayActions(controllerAddress, params.fromAddress, { useOutputOfCallAt: 0 }));
  } else {
    actions.push({
      protocol: "curve-lending",
      action: "repay",
      args: {
        tokenIn: CRVUSD,
        amountIn: { useOutputOfCallAt: 0 },
        primaryAddress: controllerAddress,
        onBehalfOf: params.fromAddress,
      },
    });
  }

  // Optional: withdraw collateral after repay
  if (params.withdrawAmount && params.withdrawAmount !== "0") {
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: controllerAddress.toLowerCase(),
        method: "remove_collateral",
        abi: CONTROLLER_REMOVE_COLLATERAL_FOR_ABI,
        args: [params.withdrawAmount, params.fromAddress],
      },
    });
    if (params.withdrawTokenOut && params.withdrawTokenOut.toLowerCase() !== params.vaultAddress.toLowerCase()) {
      actions.push({
        protocol: "enso",
        action: "route",
        args: {
          tokenIn: params.vaultAddress,
          tokenOut: params.withdrawTokenOut,
          amountIn: params.withdrawAmount,
        },
      });
    }
  }

  return fetchRepayRouterBundle({
    fromAddress: params.fromAddress,
    actions,
  });
}

export { CURVE_CONTROLLERS, CRVUSD };
