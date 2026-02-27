// Curve LlamaLend bundle functions using Enso API
// For creating loans, borrowing, repaying, and managing collateral

import type { EnsoBundleAction, EnsoBundleResponse } from "@/types/enso";
import { CURVE_CONTROLLERS, VAULTS, EXTERNAL_VAULT_CONFIG, TOKENS, PIREX, LLAMA_AIRFORCE, TANGENT } from "@/config/vaults";
import { calculateMinDy } from "@/lib/curve";
import { getLpxCvxToCvxSwapRate, ENSO_SHORTCUTS, ENSO_ROUTER_EXECUTOR, fetchRoute, CVX_HYBRID_ZAPPER, computeHybridZapParams, buildHybridZapperActions } from "@/lib/enso";
import { previewRedeem, getCurveGetDy } from "@/lib/curve/rpc";
import { CRVUSD_ADDRESS, ZAPPER_V3_ADDRESS } from "@/lib/zapper";
import { decodeFunctionData } from "viem";

const CRVUSD = CRVUSD_ADDRESS;

// Vault info for repay routing
export interface VaultInfo {
  address: string;
  underlying: string;
  underlyingSymbol: string;
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
      interface: vaultInterface,
    };
  }

  return null;
}

// Max int256 as string (2^255 - 1) - JavaScript can't handle this as a number
const MAX_INT256 = "57896044618658097711785492504343953926634992332820282019728792003956564819967";

// ABI fragments for Controller functions
const CONTROLLER_CREATE_LOAN_ABI = "function create_loan(uint256 collateral, uint256 debt, uint256 N)";
const CONTROLLER_ADD_COLLATERAL_ABI = "function add_collateral(uint256 collateral, address _for)";
// remove_collateral ABI - single param (no use_eth on this controller)
const CONTROLLER_REMOVE_COLLATERAL_ABI = "function remove_collateral(uint256 collateral)";
// remove_collateral ABI - 2-param version for router mode (msg.sender != user)
const CONTROLLER_REMOVE_COLLATERAL_FOR_ABI = "function remove_collateral(uint256 collateral, address _for)";
// Repay ABI - uses 3-param overload (no use_eth on this controller)
const CONTROLLER_REPAY_ABI = "function repay(uint256 _d_debt, address _for, int256 max_active_band)";
// Repay ABI - 2-param version (for Enso bundle direct call)
const CONTROLLER_REPAY_2ARG_ABI = "function repay(uint256 _d_debt, address _for)";
const CONTROLLER_BORROW_MORE_ABI = "function borrow_more(uint256 collateral, uint256 debt)";
const CONTROLLER_LIQUIDATE_ABI = "function liquidate(address user, uint256 min_x)";

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

/**
 * Create a new loan with collateral
 * Deposits collateral and borrows crvUSD
 */
export async function fetchCreateLoanBundle(params: {
  fromAddress: string;
  vaultAddress: `0x${string}`;
  collateralAmount: string;
  debtAmount: string;
  bands: number;
}): Promise<EnsoBundleResponse> {
  const controllerAddress = CURVE_CONTROLLERS[params.vaultAddress as keyof typeof CURVE_CONTROLLERS];
  if (!controllerAddress) {
    throw new Error(`No controller found for vault ${params.vaultAddress}`);
  }

  const actions: EnsoBundleAction[] = [
    // 1. Approve vault tokens to controller
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: params.vaultAddress,
        spender: controllerAddress,
        amount: params.collateralAmount,
      },
    },
    // 2. Create loan on controller
    {
      protocol: "enso",
      action: "call",
      args: {
        address: controllerAddress.toLowerCase(),
        method: "create_loan",
        abi: CONTROLLER_CREATE_LOAN_ABI,
        args: [params.collateralAmount, params.debtAmount, params.bands],
      },
    },
  ];

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
  });
}

/**
 * Add collateral to an existing loan
 */
export async function fetchAddCollateralBundle(params: {
  fromAddress: string;
  vaultAddress: `0x${string}`;
  collateralAmount: string;
}): Promise<EnsoBundleResponse> {
  const controllerAddress = CURVE_CONTROLLERS[params.vaultAddress as keyof typeof CURVE_CONTROLLERS];
  if (!controllerAddress) {
    throw new Error(`No controller found for vault ${params.vaultAddress}`);
  }

  const actions: EnsoBundleAction[] = [
    // 1. Approve vault tokens to controller
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: params.vaultAddress,
        spender: controllerAddress,
        amount: params.collateralAmount,
      },
    },
    // 2. Add collateral
    {
      protocol: "enso",
      action: "call",
      args: {
        address: controllerAddress.toLowerCase(),
        method: "add_collateral",
        abi: CONTROLLER_ADD_COLLATERAL_ABI,
        args: [params.collateralAmount, params.fromAddress],
      },
    },
  ];

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
  });
}

/**
 * Remove collateral from an existing loan
 */
export async function fetchRemoveCollateralBundle(params: {
  fromAddress: string;
  vaultAddress: `0x${string}`;
  collateralAmount: string;
}): Promise<EnsoBundleResponse> {
  const controllerAddress = CURVE_CONTROLLERS[params.vaultAddress as keyof typeof CURVE_CONTROLLERS];
  if (!controllerAddress) {
    throw new Error(`No controller found for vault ${params.vaultAddress}`);
  }

  const actions: EnsoBundleAction[] = [
    {
      protocol: "enso",
      action: "call",
      args: {
        address: controllerAddress.toLowerCase(),
        method: "remove_collateral",
        abi: CONTROLLER_REMOVE_COLLATERAL_ABI,
        args: [params.collateralAmount],
      },
    },
  ];

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
  });
}

// NOTE: Direct crvUSD borrow (no swap) is handled as a direct contract call
// in useCurveLendingActions.borrowMore(), not via Enso bundle.
// borrow_more(collateral, debt) requires msg.sender to be the loan owner.

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

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
  });
}

/**
 * Repay crvUSD debt AND withdraw collateral in a single Enso bundle.
 * Uses `call` actions (not `curve-lending/repay`) for controller.repay() + controller.remove_collateral().
 *
 * Prerequisites (checked by useCurveLendingActions.repayAndWithdraw):
 * - crvUSD.approve(ENSO_SHORTCUTS, repayAmount) — for Enso to pull crvUSD
 * - controller.approve(ENSO_SHORTCUTS, true) — for 2-arg remove_collateral
 */
export async function fetchRepayAndWithdrawBundle(params: {
  fromAddress: string;
  vaultAddress: `0x${string}`;
  repayAmount: string;      // crvUSD wei
  withdrawAmount: string;   // collateral wei
  closeLoan?: boolean;
  withdrawTokenOut?: string; // If different from collateral, swap after withdrawal
}): Promise<EnsoBundleResponse> {
  const controllerAddress = CURVE_CONTROLLERS[params.vaultAddress as keyof typeof CURVE_CONTROLLERS];
  if (!controllerAddress) {
    throw new Error(`No controller found for vault ${params.vaultAddress}`);
  }

  // When closing loan, pass max uint256 so interest accrual doesn't prevent closure
  const repayArg = params.closeLoan ? MAX_INT256 : params.repayAmount;

  const actions: EnsoBundleAction[] = [
    // 1. Approve crvUSD to controller
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: CRVUSD,
        spender: controllerAddress,
        amount: params.repayAmount,
      },
    },
    // 2. Repay debt
    {
      protocol: "enso",
      action: "call",
      args: {
        address: controllerAddress.toLowerCase(),
        method: "repay",
        abi: CONTROLLER_REPAY_2ARG_ABI,
        args: [repayArg, params.fromAddress],
      },
    },
    // 3. Remove collateral — 2-arg version sends to _for (user)
    {
      protocol: "enso",
      action: "call",
      args: {
        address: controllerAddress.toLowerCase(),
        method: "remove_collateral",
        abi: CONTROLLER_REMOVE_COLLATERAL_FOR_ABI,
        args: [params.withdrawAmount, params.fromAddress],
      },
    },
  ];

  // 4. If withdrawing to a different token, swap collateral → desired token
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

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
  });
}

/**
 * Repay debt using any token (swaps to crvUSD first via Enso routing)
 * For when user wants to repay with a token other than crvUSD
 *
 * If tokenIn is a yldfi vault token, it will:
 * 1. Redeem from vault to get underlying token
 * 2. Swap underlying to crvUSD
 * 3. Repay debt
 */
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

      return fetchBundle({
        fromAddress: params.fromAddress,
        actions,
        routingStrategy: "router",
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

      return fetchBundle({
        fromAddress: params.fromAddress,
        actions,
        routingStrategy: "router",
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

    return fetchBundle({
      fromAddress: params.fromAddress,
      actions,
      routingStrategy: "router",
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

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
  });
}

// ABI for decoding routeSingle from Enso route API responses.
// routeSingle(Token tokenIn, bytes data) where Token = (uint8 tokenType, bytes data)
const ROUTE_SINGLE_ABI = [{
  name: "routeSingle",
  type: "function",
  inputs: [
    { name: "tokenIn", type: "tuple", components: [
      { name: "tokenType", type: "uint8" },
      { name: "data", type: "bytes" },
    ]},
    { name: "data", type: "bytes" },
  ],
  outputs: [{ name: "", type: "bytes" }],
}] as const;

/**
 * Extract inner swap data from an Enso route response.
 *
 * The Enso route API returns routeSingle(Token tokenIn, bytes innerData) calldata.
 * routeSingle pulls tokenIn from the user BEFORE executing innerData.
 * We extract innerData to use with routeMulti([], innerData) which skips the pull.
 */
function extractInnerSwapData(routeTxData: string): `0x${string}` {
  const decoded = decodeFunctionData({
    abi: ROUTE_SINGLE_ABI,
    data: routeTxData as `0x${string}`,
  });
  if (!decoded.args) {
    throw new Error("Failed to decode routeSingle calldata — no args returned");
  }
  return decoded.args[1] as `0x${string}`;
}

/**
 * Borrow crvUSD and swap to any token in a single transaction.
 * Uses router mode with the 3-param borrow_more(collateral, debt, _for).
 *
 * Architecture:
 * The Enso ROUTER_EXECUTOR's routeSingle() pulls tokens from the user BEFORE
 * executing bundle commands. Since the user has 0 crvUSD before borrow_more,
 * the standard `route` action (which triggers routeSingle) fails.
 *
 * Solution: "Recursive routeMulti" pattern
 * 1. borrow_more(0, debt, user) — crvUSD sent to user
 * 2. transferFrom(user, ENSO_SHORTCUTS, debt) — move crvUSD into execution context
 * 3. ROUTER_EXECUTOR.routeMulti([], innerSwapData) — recursive call with empty tokensIn
 *    This bypasses the token pull (empty tokensIn) while executing the same swap
 *    commands that a standalone route would use.
 *
 * The recursive call works because:
 * - ENSO_SHORTCUTS calls ROUTER_EXECUTOR.routeMulti from inside the bundle
 * - routeMulti with empty tokensIn doesn't pull any tokens
 * - routeMulti calls _execute(data) → SHORTCUTS.executeShortcut(...)
 * - SHORTCUTS has no reentrancy guard and accepts calls from ROUTER_EXECUTOR
 * - The swap commands use crvUSD already in SHORTCUTS from the transferFrom
 *
 * CRITICAL: All addresses in `call` action `address` fields MUST be lowercase.
 *
 * Prerequisites (one-time, checked by useCurveLendingActions):
 * - controller.approve(ENSO_SHORTCUTS, true) — authorizes borrow_more on user's loan
 * - crvUSD.approve(ENSO_SHORTCUTS, maxUint256) — authorizes transferFrom to pull crvUSD
 */
export async function fetchBorrowAndSwapBundle(params: {
  fromAddress: string;
  vaultAddress: `0x${string}`;
  tokenOut: string; // Desired output token
  debtAmount: string; // crvUSD to borrow (wei)
  collateralAmount?: string; // Optional: vault token collateral to add (wei)
  slippage?: number; // Basis points (default 100 = 1%)
}): Promise<EnsoBundleResponse> {
  const controllerAddress = CURVE_CONTROLLERS[params.vaultAddress as keyof typeof CURVE_CONTROLLERS];
  if (!controllerAddress) {
    throw new Error(`No controller found for vault ${params.vaultAddress}`);
  }

  const slippage = (params.slippage ?? 100).toString();
  const actions: EnsoBundleAction[] = [];
  const vaultInfo = getVaultInfo(params.tokenOut);
  const hasCollateral = params.collateralAmount && params.collateralAmount !== "0";

  // If adding collateral: pull vault tokens from user to ENSO_SHORTCUTS, approve to controller
  if (hasCollateral) {
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: params.vaultAddress.toLowerCase(),
        method: "transferFrom",
        abi: "function transferFrom(address from, address to, uint256 amount) returns (bool)",
        args: [params.fromAddress, ENSO_SHORTCUTS, params.collateralAmount],
      },
    });
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: params.vaultAddress.toLowerCase(),
        method: "approve",
        abi: "function approve(address spender, uint256 amount) returns (bool)",
        args: [controllerAddress.toLowerCase(), params.collateralAmount],
      },
    });
  }

  // borrow_more — adds collateral (if any) and borrows crvUSD, sent to _for (user)
  actions.push({
    protocol: "enso",
    action: "call",
    args: {
      address: controllerAddress.toLowerCase(),
      method: "borrow_more",
      abi: "function borrow_more(uint256 collateral, uint256 debt, address _for)",
      args: [hasCollateral ? params.collateralAmount : "0", params.debtAmount, params.fromAddress],
    },
  });

  // Action 1: transferFrom — pull crvUSD from user to ENSO_SHORTCUTS
  // borrow_more sends crvUSD to user, but swap/deposit needs it in ENSO_SHORTCUTS
  actions.push({
    protocol: "enso",
    action: "call",
    args: {
      address: CRVUSD.toLowerCase(),
      method: "transferFrom",
      abi: "function transferFrom(address from, address to, uint256 amount) returns (bool)",
      args: [params.fromAddress, ENSO_SHORTCUTS, params.debtAmount],
    },
  });

  if (vaultInfo && vaultInfo.underlying.toLowerCase() === CRVUSD.toLowerCase()) {
    // Vault with crvUSD underlying (e.g., scrvUSD): deposit directly, no swap needed
    actions.push(
      {
        protocol: "enso",
        action: "call",
        args: {
          address: CRVUSD.toLowerCase(),
          method: "approve",
          abi: "function approve(address spender, uint256 amount) returns (bool)",
          args: [params.tokenOut.toLowerCase(), params.debtAmount],
        },
      },
      {
        protocol: "enso",
        action: "call",
        args: {
          address: params.tokenOut.toLowerCase(),
          method: "deposit",
          abi: "function deposit(uint256 assets, address receiver) returns (uint256)",
          args: [params.debtAmount, params.fromAddress],
        },
      },
    );
  } else if (vaultInfo) {
    // Vault token path: recursive routeMulti call + transferFrom + deposit.
    //
    // WHY recursive routeMulti: All `call` actions compile to `routeSingle` entry
    // point, which does NOT pull tokens from the user before executing. This is
    // critical because crvUSD is only minted by borrow_more INSIDE the bundle.
    //
    // WHY fromAddress=USER (not ZAPPER): Enso route API ignores `receiver` when
    // set to ENSO_SHORTCUTS (sends tokens to fromAddress instead). By using the
    // user's address as fromAddress, swap output goes to the user. We then
    // transferFrom the swap output from user to ENSO_SHORTCUTS for the deposit.
    //
    // PREREQUISITE: User must approve the swap target token for ENSO_SHORTCUTS
    // (e.g., cvxCRV.approve(ENSO_SHORTCUTS, maxUint256)). This is checked by
    // the borrowAndSwap hook alongside controller and crvUSD approvals.

    const isCvgCvxVault =
      vaultInfo.underlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();
    const isPxCvxVault =
      vaultInfo.underlying.toLowerCase() === TOKENS.PXCVX.toLowerCase();

    // Determine swap target: cvgCVX/pxCVX vault routes through CVX, others to underlying
    const swapTarget = (isCvgCvxVault || isPxCvxVault) ? TOKENS.CVX : vaultInfo.underlying;

    // Fetch standalone Enso route — output goes to user (fromAddress)
    const route = await fetchRoute({
      fromAddress: params.fromAddress,
      tokenIn: CRVUSD,
      tokenOut: swapTarget,
      amountIn: params.debtAmount,
      slippage,
    });

    // Extract inner swap data from routeSingle response
    const innerSwapData = extractInnerSwapData(route.tx.data);

    // Recursive routeMulti: execute swap without pulling tokens
    // Output tokens go to user's wallet (fromAddress in route)
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: ENSO_ROUTER_EXECUTOR.toLowerCase(),
        method: "routeMulti",
        abi: "function routeMulti((uint8,bytes)[] tokensIn, bytes data) payable returns (bytes)",
        args: [[], innerSwapData],
      },
    });

    // Get swap output balance in user's wallet
    const swapBalIdx = actions.length;
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: swapTarget.toLowerCase(),
        method: "balanceOf",
        abi: "function balanceOf(address account) returns (uint256)",
        args: [params.fromAddress],
      },
    });

    // Transfer swap output from user to ENSO_SHORTCUTS for deposit
    // Requires: swapTarget.approve(ENSO_SHORTCUTS, maxUint256) from user
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: swapTarget.toLowerCase(),
        method: "transferFrom",
        abi: "function transferFrom(address from, address to, uint256 amount) returns (bool)",
        args: [params.fromAddress, ENSO_SHORTCUTS, { useOutputOfCallAt: swapBalIdx }],
      },
    });

    if ((isCvgCvxVault || isPxCvxVault) && CVX_HYBRID_ZAPPER) {
      // Use HybridZapper for optimal swap/mint split
      const type = isCvgCvxVault ? "cvgCvx" as const : "pxCvx" as const;
      const zapParams = await computeHybridZapParams(route.amountOut, type, params.slippage ?? 100);
      const zapActions = buildHybridZapperActions({
        type,
        cvxAmountRef: { useOutputOfCallAt: swapBalIdx },
        ...zapParams,
        vaultAddress: params.tokenOut,
        depositReceiver: params.fromAddress,
        actionsOffset: actions.length,
      });
      actions.push(...zapActions);
    } else if (isCvgCvxVault) {
      // Fallback: CVX → CVX1 (1:1 mint) → cvgCVX (Curve pool) → vault deposit
      actions.push({
        protocol: "enso", action: "call",
        args: { address: TOKENS.CVX.toLowerCase(), method: "approve", abi: "function approve(address spender, uint256 amount) returns (bool)", args: [TOKENS.CVX1.toLowerCase(), { useOutputOfCallAt: swapBalIdx }] },
      });
      actions.push({
        protocol: "enso", action: "call",
        args: { address: TOKENS.CVX1.toLowerCase(), method: "mint", abi: "function mint(address to, uint256 amount)", args: [ENSO_SHORTCUTS, { useOutputOfCallAt: swapBalIdx }] },
      });
      actions.push({
        protocol: "enso", action: "call",
        args: { address: TOKENS.CVX1.toLowerCase(), method: "approve", abi: "function approve(address spender, uint256 amount) returns (bool)", args: [TANGENT.CVX1_CVGCVX_POOL.toLowerCase(), { useOutputOfCallAt: swapBalIdx }] },
      });
      actions.push({
        protocol: "enso", action: "call",
        args: { address: TANGENT.CVX1_CVGCVX_POOL.toLowerCase(), method: "exchange", abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)", args: [0, 1, { useOutputOfCallAt: swapBalIdx }, "0"] },
      });
      const cvgCvxBalIdx = actions.length;
      actions.push({
        protocol: "enso", action: "call",
        args: { address: TOKENS.CVGCVX.toLowerCase(), method: "balanceOf", abi: "function balanceOf(address account) returns (uint256)", args: [ENSO_SHORTCUTS] },
      });
      actions.push({
        protocol: "enso", action: "call",
        args: { address: TOKENS.CVGCVX.toLowerCase(), method: "approve", abi: "function approve(address spender, uint256 amount) returns (bool)", args: [params.tokenOut.toLowerCase(), { useOutputOfCallAt: cvgCvxBalIdx }] },
      });
      actions.push({
        protocol: "enso", action: "call",
        args: { address: params.tokenOut.toLowerCase(), method: "deposit", abi: "function deposit(uint256 assets, address receiver) returns (uint256)", args: [{ useOutputOfCallAt: cvgCvxBalIdx }, params.fromAddress] },
      });
    } else if (isPxCvxVault) {
      // Fallback: CVX → pxCVX (Pirex mint) → vault deposit
      actions.push({
        protocol: "enso", action: "call",
        args: { address: TOKENS.CVX.toLowerCase(), method: "approve", abi: "function approve(address spender, uint256 amount) returns (bool)", args: [PIREX.PIREX_CVX.toLowerCase(), { useOutputOfCallAt: swapBalIdx }] },
      });
      actions.push({
        protocol: "enso", action: "call",
        args: {
          address: PIREX.PIREX_CVX.toLowerCase(),
          method: "deposit",
          abi: "function deposit(uint256 assets, address receiver, bool shouldCompound, address developer)",
          args: [{ useOutputOfCallAt: swapBalIdx }, ENSO_SHORTCUTS, "false", "0x0000000000000000000000000000000000000000"],
        },
      });
      const pxCvxBalIdx = actions.length;
      actions.push({
        protocol: "enso", action: "call",
        args: { address: TOKENS.PXCVX.toLowerCase(), method: "balanceOf", abi: "function balanceOf(address account) returns (uint256)", args: [ENSO_SHORTCUTS] },
      });
      actions.push({
        protocol: "enso", action: "call",
        args: { address: TOKENS.PXCVX.toLowerCase(), method: "approve", abi: "function approve(address spender, uint256 amount) returns (bool)", args: [params.tokenOut.toLowerCase(), { useOutputOfCallAt: pxCvxBalIdx }] },
      });
      actions.push({
        protocol: "enso", action: "call",
        args: { address: params.tokenOut.toLowerCase(), method: "deposit", abi: "function deposit(uint256 assets, address receiver) returns (uint256)", args: [{ useOutputOfCallAt: pxCvxBalIdx }, params.fromAddress] },
      });
    } else {
      // Regular vault token (ycvxCRV, yscvxCRV, etc.)
      // Underlying is now in ENSO_SHORTCUTS from the transferFrom above

      // Approve underlying → vault
      actions.push({
        protocol: "enso",
        action: "call",
        args: {
          address: vaultInfo.underlying.toLowerCase(),
          method: "approve",
          abi: "function approve(address spender, uint256 amount) returns (bool)",
          args: [params.tokenOut.toLowerCase(), { useOutputOfCallAt: swapBalIdx }],
        },
      });

      // Deposit underlying → vault
      actions.push({
        protocol: "enso",
        action: "call",
        args: {
          address: params.tokenOut.toLowerCase(),
          method: "deposit",
          abi: "function deposit(uint256 assets, address receiver) returns (uint256)",
          args: [{ useOutputOfCallAt: swapBalIdx }, params.fromAddress],
        },
      });
    }
  } else {
    // Non-vault ERC20 token: use recursive routeMulti pattern
    // This works because the swap output goes directly to the user (no deposit needed)

    // Fetch standalone Enso route for the swap calldata
    const route = await fetchRoute({
      fromAddress: ZAPPER_V3_ADDRESS,
      tokenIn: CRVUSD,
      tokenOut: params.tokenOut,
      amountIn: params.debtAmount,
      slippage,
      receiver: params.fromAddress,
    });

    // Extract inner swap data from routeSingle response
    const innerSwapData = extractInnerSwapData(route.tx.data);

    // Action 2: Recursive routeMulti — execute swap without pulling tokens
    // ENSO_SHORTCUTS calls ROUTER_EXECUTOR.routeMulti([], innerSwapData)
    // → routeMulti skips token pull (empty tokensIn) → executes swap commands
    // → swap uses crvUSD already in SHORTCUTS from transferFrom
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: ENSO_ROUTER_EXECUTOR.toLowerCase(),
        method: "routeMulti",
        abi: "function routeMulti((uint8,bytes)[] tokensIn, bytes data) payable returns (bytes)",
        args: [[], innerSwapData],
      },
    });
  }

  // skipQuote for vault token paths that use routeMulti + deposit after the swap.
  // Enso's simulation can't trace through recursive routeMulti, so balanceOf/approve/deposit
  // would fail. skipQuote bypasses Enso's sim; our Tenderly/eth_call sim validates instead.
  // NOT needed for: scrvUSD (literal amounts, no routeMulti), ERC20 (no deposit after swap).
  const needsSkipQuote =
    vaultInfo && vaultInfo.underlying.toLowerCase() !== CRVUSD.toLowerCase();

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
    skipQuote: needsSkipQuote || undefined,
  });
}

/**
 * Self-liquidate to close position and recover remaining collateral
 * Used when in soft-liquidation to exit the position
 */
export async function fetchSelfLiquidateBundle(params: {
  fromAddress: string;
  vaultAddress: `0x${string}`;
  minCollateralOut: string; // Minimum collateral to receive (slippage protection)
}): Promise<EnsoBundleResponse> {
  const controllerAddress = CURVE_CONTROLLERS[params.vaultAddress as keyof typeof CURVE_CONTROLLERS];
  if (!controllerAddress) {
    throw new Error(`No controller found for vault ${params.vaultAddress}`);
  }

  const actions: EnsoBundleAction[] = [
    {
      protocol: "enso",
      action: "call",
      args: {
        address: controllerAddress.toLowerCase(),
        method: "liquidate",
        abi: CONTROLLER_LIQUIDATE_ABI,
        args: [params.fromAddress, params.minCollateralOut],
      },
    },
  ];

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
  });
}

/**
 * Create a new loan with any input token.
 * Swaps tokenIn → vault token first, then creates the loan.
 *
 * For vault token inputs (e.g., yscvgCVX → ycvxCRV lending):
 * - Redeem source vault → underlying
 * - For cvgCVX underlying: Curve swap cvgCVX → CVX1 → CVX, then route CVX → target vault
 * - For pxCVX underlying: wrap → lpxCVX → CVX → route → target vault
 * - For standard vaults: route underlying → target vault
 * - Then approve + create_loan as normal
 */
export async function fetchCreateLoanWithSwapBundle(params: {
  fromAddress: string;
  vaultAddress: `0x${string}`;
  tokenIn: string;
  amountIn: string; // wei
  debtAmount: string;
  bands: number;
  slippage?: number;
}): Promise<EnsoBundleResponse> {
  const controllerAddress = CURVE_CONTROLLERS[params.vaultAddress as keyof typeof CURVE_CONTROLLERS];
  if (!controllerAddress) {
    throw new Error(`No controller found for vault ${params.vaultAddress}`);
  }

  const slippage = (params.slippage ?? 100).toString();
  const vaultInfo = getVaultInfo(params.tokenIn);

  if (vaultInfo) {
    const isPxCvxUnderlying = vaultInfo.underlying.toLowerCase() === TOKENS.PXCVX.toLowerCase();
    const isCvgCvxUnderlying = vaultInfo.underlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();
    // cvgCVX path uses HybridZapper — skip Enso simulation (same as fetchCvgCvxZapOutRoute)
    const needsSkipQuote = isCvgCvxUnderlying;

    const actions: EnsoBundleAction[] = [];

    // Step 1: Redeem from source vault
    if (vaultInfo.interface === "ucrv") {
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

    if (isPxCvxUnderlying) {
      // pxCVX → lpxCVX (wrap) → CVX (Curve swap) → route to target vault
      const estimatedPxCvx = await previewRedeem(vaultInfo.address, params.amountIn);
      const estimatedLpxCvx = estimatedPxCvx;
      const expectedCvx = await getLpxCvxToCvxSwapRate(estimatedLpxCvx);
      if (expectedCvx === 0n) throw new Error("Failed to estimate lpxCVX→CVX swap output");
      const slippageBps = params.slippage ?? 100;
      const minDyCvx = calculateMinDy(expectedCvx, slippageBps);

      actions.push(
        { protocol: "erc20", action: "approve", args: { token: TOKENS.PXCVX, spender: PIREX.LPXCVX, amount: { useOutputOfCallAt: 0 } } },
        { protocol: "enso", action: "call", args: { address: PIREX.LPXCVX.toLowerCase(), method: "wrap", abi: "function wrap(uint256 amount)", args: [{ useOutputOfCallAt: 0 }] } },
        { protocol: "erc20", action: "approve", args: { token: PIREX.LPXCVX, spender: PIREX.LPXCVX_CVX_POOL, amount: { useOutputOfCallAt: 0 } } },
        { protocol: "enso", action: "call", args: { address: PIREX.LPXCVX_CVX_POOL.toLowerCase(), method: "exchange", abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) returns (uint256)", args: [String(PIREX.POOL_INDEX.LPXCVX), String(PIREX.POOL_INDEX.CVX), { useOutputOfCallAt: 0 }, minDyCvx] } },
      );
      const routeIdx = actions.length;
      actions.push({
        protocol: "enso",
        action: "route",
        args: { tokenIn: TOKENS.CVX, tokenOut: params.vaultAddress, amountIn: { useOutputOfCallAt: routeIdx - 1 }, slippage },
      });
      actions.push(
        { protocol: "erc20", action: "approve", args: { token: params.vaultAddress, spender: controllerAddress, amount: { useOutputOfCallAt: routeIdx } } },
        { protocol: "enso", action: "call", args: { address: controllerAddress.toLowerCase(), method: "create_loan", abi: CONTROLLER_CREATE_LOAN_ABI, args: [{ useOutputOfCallAt: routeIdx }, params.debtAmount, params.bands] } },
      );
    } else if (isCvgCvxUnderlying) {
      // cvgCVX → CVX1 (Curve pool) → CVX (unwrap via HybridZapper) → route to target vault
      // Uses call/routeMulti([], innerSwapData) pattern instead of route action because:
      // - route action with skipQuote:true can't resolve useOutputOfCallAt (422 error)
      // - route action with concrete amountIn adds CVX to outer token pull list (user has no CVX)
      const estimatedUnderlying = await previewRedeem(vaultInfo.address, params.amountIn);
      const expectedCvx1 = await getCurveGetDy(TANGENT.CVX1_CVGCVX_POOL, 1, 0, estimatedUnderlying);
      if (!expectedCvx1 || expectedCvx1 === 0n) throw new Error("cvgCVX → CVX1 swap rate unavailable");
      const slippageBps = params.slippage ?? 100;
      const minDy = calculateMinDy(expectedCvx1, slippageBps);

      // Pre-fetch CVX → vaultAddress route for inner swap data
      // fromAddress=user so Enso API accepts (ENSO_SHORTCUTS as fromAddress returns 500)
      // Route output goes to user, then transferFrom pulls it to ENSO_SHORTCUTS
      // PREREQUISITE: User must approve vaultAddress for ENSO_SHORTCUTS
      const cvxRoute = await fetchRoute({
        fromAddress: params.fromAddress,
        tokenIn: TOKENS.CVX,
        tokenOut: params.vaultAddress,
        amountIn: expectedCvx1.toString(), // CVX1→CVX is 1:1
        slippage,
      });
      const innerSwapData = extractInnerSwapData(cvxRoute.tx.data);

      // approve cvgCVX → Curve pool
      actions.push({ protocol: "erc20", action: "approve", args: { token: TOKENS.CVGCVX, spender: TANGENT.CVX1_CVGCVX_POOL, amount: { useOutputOfCallAt: 0 } } });
      // exchange cvgCVX → CVX1
      const exchangeIdx = actions.length;
      actions.push({ protocol: "enso", action: "call", args: { address: TANGENT.CVX1_CVGCVX_POOL.toLowerCase(), method: "exchange", abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)", args: [1, 0, { useOutputOfCallAt: 0 }, minDy.toString()] } });
      // transfer CVX1 to HybridZapper (expects CVX1 in its balance)
      actions.push({ protocol: "erc20", action: "transfer", args: { token: TOKENS.CVX1, receiver: CVX_HYBRID_ZAPPER, amount: { useOutputOfCallAt: exchangeIdx } } });
      // unwrap CVX1 → CVX via HybridZapper (sends CVX to ENSO_SHORTCUTS where routeMulti inner data expects it)
      actions.push({ protocol: "enso", action: "call", args: { address: CVX_HYBRID_ZAPPER, method: "unwrapCvx1ToCvx", abi: "function unwrapCvx1ToCvx(uint256 amount, address receiver) returns (uint256)", args: [{ useOutputOfCallAt: exchangeIdx }, ENSO_SHORTCUTS] } });
      // Recursive routeMulti: swap CVX (already in ENSO_SHORTCUTS) → vault token → user
      // call action doesn't add CVX to Enso's outer token pull list (unlike route action)
      actions.push({ protocol: "enso", action: "call", args: { address: ENSO_ROUTER_EXECUTOR.toLowerCase(), method: "routeMulti", abi: "function routeMulti((uint8,bytes)[] tokensIn, bytes data) payable returns (bytes)", args: [[], innerSwapData] } });
      // Get vault token balance from user's wallet (route output destination)
      const balIdx = actions.length;
      actions.push({ protocol: "enso", action: "call", args: { address: params.vaultAddress.toLowerCase(), method: "balanceOf", abi: "function balanceOf(address account) returns (uint256)", args: [params.fromAddress] } });
      // Transfer vault tokens from user to ENSO_SHORTCUTS for create_loan
      // Requires: vaultAddress.approve(ENSO_SHORTCUTS, maxUint256) from user
      actions.push({ protocol: "enso", action: "call", args: { address: params.vaultAddress.toLowerCase(), method: "transferFrom", abi: "function transferFrom(address from, address to, uint256 amount) returns (bool)", args: [params.fromAddress, ENSO_SHORTCUTS, { useOutputOfCallAt: balIdx }] } });
      // approve + create_loan using transferred balance
      actions.push(
        { protocol: "erc20", action: "approve", args: { token: params.vaultAddress, spender: controllerAddress, amount: { useOutputOfCallAt: balIdx } } },
        { protocol: "enso", action: "call", args: { address: controllerAddress.toLowerCase(), method: "create_loan", abi: CONTROLLER_CREATE_LOAN_ABI, args: [{ useOutputOfCallAt: balIdx }, params.debtAmount, params.bands] } },
      );
    } else {
      // Standard vault: underlying → route to target vault
      const routeIdx = actions.length;
      actions.push({
        protocol: "enso",
        action: "route",
        args: { tokenIn: vaultInfo.underlying, tokenOut: params.vaultAddress, amountIn: { useOutputOfCallAt: 0 }, slippage },
      });
      actions.push(
        { protocol: "erc20", action: "approve", args: { token: params.vaultAddress, spender: controllerAddress, amount: { useOutputOfCallAt: routeIdx } } },
        { protocol: "enso", action: "call", args: { address: controllerAddress.toLowerCase(), method: "create_loan", abi: CONTROLLER_CREATE_LOAN_ABI, args: [{ useOutputOfCallAt: routeIdx }, params.debtAmount, params.bands] } },
      );
    }

    return fetchBundle({
      fromAddress: params.fromAddress,
      actions,
      routingStrategy: "router",
      skipQuote: needsSkipQuote,
    });
  }

  // Non-vault token: simple route → approve → create_loan
  const actions: EnsoBundleAction[] = [
    // 1. Route input token → vault token
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.tokenIn,
        tokenOut: params.vaultAddress,
        amountIn: params.amountIn,
        slippage,
      },
    },
    // 2. Approve vault tokens to controller
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: params.vaultAddress,
        spender: controllerAddress,
        amount: { useOutputOfCallAt: 0 },
      },
    },
    // 3. Create loan on controller
    {
      protocol: "enso",
      action: "call",
      args: {
        address: controllerAddress.toLowerCase(),
        method: "create_loan",
        abi: CONTROLLER_CREATE_LOAN_ABI,
        args: [{ useOutputOfCallAt: 0 }, params.debtAmount, params.bands],
      },
    },
  ];

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
  });
}

/**
 * Add collateral to an existing loan, swapping from any token to vault token first.
 * tokenIn → route to vaultToken → approve → add_collateral
 */
export async function fetchAddCollateralWithSwapBundle(params: {
  fromAddress: string;
  vaultAddress: `0x${string}`;
  tokenIn: string;
  amountIn: string; // wei
  slippage?: number;
}): Promise<EnsoBundleResponse> {
  const controllerAddress = CURVE_CONTROLLERS[params.vaultAddress as keyof typeof CURVE_CONTROLLERS];
  if (!controllerAddress) {
    throw new Error(`No controller found for vault ${params.vaultAddress}`);
  }

  const slippage = (params.slippage ?? 100).toString();

  const actions: EnsoBundleAction[] = [
    // 1. Route input token → vault token
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.tokenIn,
        tokenOut: params.vaultAddress,
        amountIn: params.amountIn,
        slippage,
      },
    },
    // 2. Approve vault tokens to controller
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: params.vaultAddress,
        spender: controllerAddress,
        amount: { useOutputOfCallAt: 0 },
      },
    },
    // 3. Add collateral
    {
      protocol: "enso",
      action: "call",
      args: {
        address: controllerAddress.toLowerCase(),
        method: "add_collateral",
        abi: CONTROLLER_ADD_COLLATERAL_ABI,
        args: [{ useOutputOfCallAt: 0 }, params.fromAddress],
      },
    },
  ];

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
  });
}

/**
 * Swap any token to vault collateral and borrow additional crvUSD in one Enso bundle.
 *
 * Route: tokenIn → vaultToken (route) → approve to controller → borrow_more(swappedAmount, debtAmount)
 *
 * Uses delegate mode so msg.sender = user for borrow_more (which checks msg.sender's loan).
 * The user needs ERC20 approval of tokenIn to ENSO_SHORTCUTS.
 */
export async function fetchBorrowWithSwapCollateralBundle(params: {
  fromAddress: string;
  vaultAddress: `0x${string}`;
  tokenIn: string;
  amountIn: string; // wei of input token
  debtAmount: string; // wei of crvUSD to borrow
  slippage?: number;
}): Promise<EnsoBundleResponse> {
  const controllerAddress = CURVE_CONTROLLERS[params.vaultAddress as keyof typeof CURVE_CONTROLLERS];
  if (!controllerAddress) {
    throw new Error(`No controller found for vault ${params.vaultAddress}`);
  }

  const slippage = (params.slippage ?? 100).toString();

  const actions: EnsoBundleAction[] = [
    // 1. Route input token → vault token (collateral)
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.tokenIn,
        tokenOut: params.vaultAddress,
        amountIn: params.amountIn,
        slippage,
      },
    },
    // 2. Approve vault tokens to controller
    {
      protocol: "erc20",
      action: "approve",
      args: {
        token: params.vaultAddress,
        spender: controllerAddress,
        amount: { useOutputOfCallAt: 0 },
      },
    },
    // 3. borrow_more(collateral, debt) — adds swapped collateral + borrows crvUSD
    {
      protocol: "enso",
      action: "call",
      args: {
        address: controllerAddress.toLowerCase(),
        method: "borrow_more",
        abi: CONTROLLER_BORROW_MORE_ABI,
        args: [{ useOutputOfCallAt: 0 }, params.debtAmount],
      },
    },
  ];

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "delegate",
  });
}

/**
 * Remove collateral from an existing loan and swap vault token to any output token.
 *
 * Uses the 2-arg remove_collateral(amount, _for) overload in router mode.
 * ENSO_SHORTCUTS is msg.sender and must be approved on the controller by the user.
 * The controller sends collateral to _for (user), then we pull it back via transferFrom
 * and swap using the recursive routeMulti pattern (same as fetchBorrowAndSwapBundle).
 *
 * Prerequisites (checked by useCurveLendingActions.removeCollateralAndSwap):
 * - controller.approve(ENSO_SHORTCUTS, true) — authorizes remove_collateral on user's loan
 * - vaultToken.approve(ENSO_SHORTCUTS, amount) — authorizes transferFrom to pull collateral
 */
export async function fetchRemoveCollateralAndSwapBundle(params: {
  fromAddress: string;
  vaultAddress: `0x${string}`;
  collateralAmount: string; // wei
  tokenOut: string;
  slippage?: number;
}): Promise<EnsoBundleResponse> {
  const controllerAddress = CURVE_CONTROLLERS[params.vaultAddress as keyof typeof CURVE_CONTROLLERS];
  if (!controllerAddress) {
    throw new Error(`No controller found for vault ${params.vaultAddress}`);
  }

  const slippage = (params.slippage ?? 100).toString();

  // Fetch standalone Enso route for vault token → output token
  // fromAddress=ZAPPER_V3_ADDRESS so tokens are treated as coming from ENSO_SHORTCUTS context
  // receiver=user so output goes directly to user
  const route = await fetchRoute({
    fromAddress: ZAPPER_V3_ADDRESS,
    tokenIn: params.vaultAddress,
    tokenOut: params.tokenOut,
    amountIn: params.collateralAmount,
    slippage,
    receiver: params.fromAddress,
  });

  // Extract inner swap data from routeSingle response
  const innerSwapData = extractInnerSwapData(route.tx.data);

  const actions: EnsoBundleAction[] = [
    // 1. Remove collateral using 2-arg version: remove_collateral(amount, _for)
    //    msg.sender = ENSO_SHORTCUTS (approved on controller by user)
    //    _for = user → controller sends collateral to user's wallet
    {
      protocol: "enso",
      action: "call",
      args: {
        address: controllerAddress.toLowerCase(),
        method: "remove_collateral",
        abi: "function remove_collateral(uint256 collateral, address _for)",
        args: [params.collateralAmount, params.fromAddress],
      },
    },
    // 2. Pull vault tokens from user to ENSO_SHORTCUTS for the swap
    //    Requires: vaultToken.approve(ENSO_SHORTCUTS, amount) from user
    {
      protocol: "enso",
      action: "call",
      args: {
        address: params.vaultAddress.toLowerCase(),
        method: "transferFrom",
        abi: "function transferFrom(address from, address to, uint256 amount) returns (bool)",
        args: [params.fromAddress, ENSO_SHORTCUTS, params.collateralAmount],
      },
    },
    // 3. Recursive routeMulti — swap vault token → output token without pulling tokens
    //    routeMulti with empty tokensIn skips the token pull, uses tokens already in ENSO_SHORTCUTS
    {
      protocol: "enso",
      action: "call",
      args: {
        address: ENSO_ROUTER_EXECUTOR.toLowerCase(),
        method: "routeMulti",
        abi: "function routeMulti((uint8,bytes)[] tokensIn, bytes data) payable returns (bytes)",
        args: [[], innerSwapData],
      },
    },
  ];

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
    skipQuote: true, // routeMulti breaks Enso's simulation
  });
}

/**
 * Create a new loan and swap the borrowed crvUSD to any output token.
 *
 * After create_loan in router mode, crvUSD goes to msg.sender (ENSO_SHORTCUTS).
 * We use the recursive routeMulti pattern to swap it without pulling from user.
 *
 * Supports two input modes:
 * - tokenIn undefined: vaultToken is the input (direct collateral)
 * - tokenIn specified: swap tokenIn → vaultToken first, then create loan
 *
 * Supports vault token outputs (e.g., scrvUSD, yscvgCVX, yspxCVX):
 * - crvUSD-underlying vault (scrvUSD): approve + deposit directly (no swap)
 * - cvgCVX vault: routeMulti(crvUSD→CVX) → transferFrom → HybridZapper(CVX→cvgCVX) → deposit
 * - pxCVX vault: routeMulti(crvUSD→CVX) → transferFrom → HybridZapper(CVX→pxCVX) → deposit
 * - Standard vault: routeMulti(crvUSD→underlying) → transferFrom → approve + deposit
 * - Non-vault: routeMulti sends directly to user (existing behavior)
 *
 * Also supports vault token inputs with output swap (e.g., yscvgCVX → create loan → receive scrvUSD):
 * Uses the same redeem + swap pattern as fetchCreateLoanWithSwapBundle.
 */
export async function fetchCreateLoanWithOutputSwapBundle(params: {
  fromAddress: string;
  vaultAddress: `0x${string}`;
  tokenIn?: string; // If different from vault, swap input first
  amountIn: string; // Wei amount of tokenIn (or vault token)
  debtAmount: string; // crvUSD to borrow (wei)
  bands: number;
  tokenOut: string; // Token to receive (swap crvUSD → this)
  slippage?: number; // Basis points (default 100 = 1%)
}): Promise<EnsoBundleResponse> {
  const controllerAddress = CURVE_CONTROLLERS[params.vaultAddress as keyof typeof CURVE_CONTROLLERS];
  if (!controllerAddress) {
    throw new Error(`No controller found for vault ${params.vaultAddress}`);
  }

  const slippage = (params.slippage ?? 100).toString();
  const actions: EnsoBundleAction[] = [];
  const hasInputSwap = !!params.tokenIn;
  const inputVaultInfo = hasInputSwap ? getVaultInfo(params.tokenIn!) : null;
  const outputVaultInfo = getVaultInfo(params.tokenOut);
  let inputUsesHybridZapper = false;

  // ===== INPUT SIDE: Get vault tokens into ENSO_SHORTCUTS =====
  if (hasInputSwap && inputVaultInfo) {
    // Vault token input: redeem to underlying, then convert to target vault token
    const isPxCvxUnderlying = inputVaultInfo.underlying.toLowerCase() === TOKENS.PXCVX.toLowerCase();
    const isCvgCvxUnderlying = inputVaultInfo.underlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();

    // Step 1: Redeem from source vault
    if (inputVaultInfo.interface === "ucrv") {
      actions.push({ protocol: "enso", action: "call", args: { address: inputVaultInfo.address.toLowerCase(), method: "withdraw", abi: "function withdraw(address _to, uint256 _shares)", args: [params.fromAddress, params.amountIn] } });
    } else if (inputVaultInfo.interface === "beefy") {
      actions.push({ protocol: "enso", action: "call", args: { address: inputVaultInfo.address.toLowerCase(), method: "withdraw", abi: "function withdraw(uint256 _shares)", args: [params.amountIn] } });
    } else {
      actions.push({ protocol: "erc4626", action: "redeem", args: { tokenIn: params.tokenIn!, tokenOut: inputVaultInfo.underlying, amountIn: params.amountIn, primaryAddress: params.tokenIn! } });
    }

    // Track the action index that holds the vault token amount
    let vaultTokenAmountIdx: number;

    if (isPxCvxUnderlying) {
      const estimatedPxCvx = await previewRedeem(inputVaultInfo.address, params.amountIn);
      const expectedCvx = await getLpxCvxToCvxSwapRate(estimatedPxCvx);
      if (expectedCvx === 0n) throw new Error("Failed to estimate lpxCVX→CVX swap output");
      const minDyCvx = calculateMinDy(expectedCvx, params.slippage ?? 100);
      actions.push(
        { protocol: "erc20", action: "approve", args: { token: TOKENS.PXCVX, spender: PIREX.LPXCVX, amount: { useOutputOfCallAt: 0 } } },
        { protocol: "enso", action: "call", args: { address: PIREX.LPXCVX.toLowerCase(), method: "wrap", abi: "function wrap(uint256 amount)", args: [{ useOutputOfCallAt: 0 }] } },
        { protocol: "erc20", action: "approve", args: { token: PIREX.LPXCVX, spender: PIREX.LPXCVX_CVX_POOL, amount: { useOutputOfCallAt: 0 } } },
        { protocol: "enso", action: "call", args: { address: PIREX.LPXCVX_CVX_POOL.toLowerCase(), method: "exchange", abi: "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) returns (uint256)", args: [String(PIREX.POOL_INDEX.LPXCVX), String(PIREX.POOL_INDEX.CVX), { useOutputOfCallAt: 0 }, minDyCvx] } },
      );
      vaultTokenAmountIdx = actions.length;
      actions.push({ protocol: "enso", action: "route", args: { tokenIn: TOKENS.CVX, tokenOut: params.vaultAddress, amountIn: { useOutputOfCallAt: vaultTokenAmountIdx - 1 }, slippage } });
    } else if (isCvgCvxUnderlying) {
      // Same pattern as fetchCreateLoanWithSwapBundle cvgCVX path
      // Uses call/routeMulti([], innerSwapData) to avoid route action's token pull issue
      inputUsesHybridZapper = true;
      const estimatedUnderlying = await previewRedeem(inputVaultInfo.address, params.amountIn);
      const expectedCvx1 = await getCurveGetDy(TANGENT.CVX1_CVGCVX_POOL, 1, 0, estimatedUnderlying);
      if (!expectedCvx1 || expectedCvx1 === 0n) throw new Error("cvgCVX → CVX1 swap rate unavailable");
      const minDy = calculateMinDy(expectedCvx1, params.slippage ?? 100);

      // Pre-fetch CVX → vaultAddress route for inner swap data
      // fromAddress=user so Enso API accepts; route output goes to user, then transferFrom
      const cvxRoute = await fetchRoute({
        fromAddress: params.fromAddress,
        tokenIn: TOKENS.CVX,
        tokenOut: params.vaultAddress,
        amountIn: expectedCvx1.toString(),
        slippage,
      });
      const innerSwapData = extractInnerSwapData(cvxRoute.tx.data);

      actions.push({ protocol: "erc20", action: "approve", args: { token: TOKENS.CVGCVX, spender: TANGENT.CVX1_CVGCVX_POOL, amount: { useOutputOfCallAt: 0 } } });
      const exchangeIdx = actions.length;
      actions.push({ protocol: "enso", action: "call", args: { address: TANGENT.CVX1_CVGCVX_POOL.toLowerCase(), method: "exchange", abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)", args: [1, 0, { useOutputOfCallAt: 0 }, minDy.toString()] } });
      actions.push({ protocol: "erc20", action: "transfer", args: { token: TOKENS.CVX1, receiver: CVX_HYBRID_ZAPPER, amount: { useOutputOfCallAt: exchangeIdx } } });
      actions.push({ protocol: "enso", action: "call", args: { address: CVX_HYBRID_ZAPPER, method: "unwrapCvx1ToCvx", abi: "function unwrapCvx1ToCvx(uint256 amount, address receiver) returns (uint256)", args: [{ useOutputOfCallAt: exchangeIdx }, ENSO_SHORTCUTS] } });
      // Recursive routeMulti: CVX (in ENSO_SHORTCUTS) → vault token → user
      actions.push({ protocol: "enso", action: "call", args: { address: ENSO_ROUTER_EXECUTOR.toLowerCase(), method: "routeMulti", abi: "function routeMulti((uint8,bytes)[] tokensIn, bytes data) payable returns (bytes)", args: [[], innerSwapData] } });
      // Get vault token balance from user, transfer to ENSO_SHORTCUTS for create_loan
      vaultTokenAmountIdx = actions.length;
      actions.push({ protocol: "enso", action: "call", args: { address: params.vaultAddress.toLowerCase(), method: "balanceOf", abi: "function balanceOf(address account) returns (uint256)", args: [params.fromAddress] } });
      actions.push({ protocol: "enso", action: "call", args: { address: params.vaultAddress.toLowerCase(), method: "transferFrom", abi: "function transferFrom(address from, address to, uint256 amount) returns (bool)", args: [params.fromAddress, ENSO_SHORTCUTS, { useOutputOfCallAt: vaultTokenAmountIdx }] } });
    } else {
      // Standard vault: route underlying → target vault
      vaultTokenAmountIdx = actions.length;
      actions.push({ protocol: "enso", action: "route", args: { tokenIn: inputVaultInfo.underlying, tokenOut: params.vaultAddress, amountIn: { useOutputOfCallAt: 0 }, slippage } });
    }

    // Approve vault tokens to controller + create loan
    actions.push({ protocol: "erc20", action: "approve", args: { token: params.vaultAddress, spender: controllerAddress, amount: { useOutputOfCallAt: vaultTokenAmountIdx } } });
    actions.push({ protocol: "enso", action: "call", args: { address: controllerAddress.toLowerCase(), method: "create_loan", abi: CONTROLLER_CREATE_LOAN_ABI, args: [{ useOutputOfCallAt: vaultTokenAmountIdx }, params.debtAmount, params.bands] } });
  } else if (hasInputSwap) {
    // Non-vault input token: simple route → approve → create_loan
    actions.push({ protocol: "enso", action: "route", args: { tokenIn: params.tokenIn!, tokenOut: params.vaultAddress, amountIn: params.amountIn, slippage } });
    actions.push({ protocol: "erc20", action: "approve", args: { token: params.vaultAddress, spender: controllerAddress, amount: { useOutputOfCallAt: 0 } } });
    actions.push({ protocol: "enso", action: "call", args: { address: controllerAddress.toLowerCase(), method: "create_loan", abi: CONTROLLER_CREATE_LOAN_ABI, args: [{ useOutputOfCallAt: 0 }, params.debtAmount, params.bands] } });
  } else {
    // Direct vault token collateral: approve → create_loan
    actions.push({ protocol: "erc20", action: "approve", args: { token: params.vaultAddress, spender: controllerAddress, amount: params.amountIn } });
    actions.push({ protocol: "enso", action: "call", args: { address: controllerAddress.toLowerCase(), method: "create_loan", abi: CONTROLLER_CREATE_LOAN_ABI, args: [params.amountIn, params.debtAmount, params.bands] } });
  }

  // ===== OUTPUT SIDE: Convert crvUSD (in ENSO_SHORTCUTS) to desired output token =====
  let needsSkipQuote = true; // default for routeMulti-based paths

  if (outputVaultInfo && outputVaultInfo.underlying.toLowerCase() === CRVUSD.toLowerCase()) {
    // crvUSD-underlying vault (e.g., scrvUSD): approve + deposit directly, no swap
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: CRVUSD.toLowerCase(),
        method: "approve",
        abi: "function approve(address spender, uint256 amount) returns (bool)",
        args: [params.tokenOut.toLowerCase(), params.debtAmount],
      },
    });
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: params.tokenOut.toLowerCase(),
        method: "deposit",
        abi: "function deposit(uint256 assets, address receiver) returns (uint256)",
        args: [params.debtAmount, params.fromAddress],
      },
    });
    needsSkipQuote = inputUsesHybridZapper; // only skip if input uses HybridZapper
  } else if (outputVaultInfo) {
    // Vault token output: route crvUSD → underlying (or CVX for cvgCVX), then deposit
    // Mirrors fetchBorrowAndSwapBundle vault token path
    const isCvgCvxVault =
      outputVaultInfo.underlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();
    const isPxCvxVault =
      outputVaultInfo.underlying.toLowerCase() === TOKENS.PXCVX.toLowerCase();
    // For cvgCVX/pxCVX vaults, route to CVX first; for others, route to underlying
    const swapTarget = (isCvgCvxVault || isPxCvxVault) ? TOKENS.CVX : outputVaultInfo.underlying;

    // Route crvUSD → swapTarget (output goes to user, not ENSO_SHORTCUTS)
    const route = await fetchRoute({
      fromAddress: params.fromAddress,
      tokenIn: CRVUSD,
      tokenOut: swapTarget,
      amountIn: params.debtAmount,
      slippage,
    });
    const innerSwapData = extractInnerSwapData(route.tx.data);

    // Recursive routeMulti: swap crvUSD already in ENSO_SHORTCUTS
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: ENSO_ROUTER_EXECUTOR.toLowerCase(),
        method: "routeMulti",
        abi: "function routeMulti((uint8,bytes)[] tokensIn, bytes data) payable returns (bytes)",
        args: [[], innerSwapData],
      },
    });

    // Get swap output balance from user's wallet
    const swapBalIdx = actions.length;
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: swapTarget.toLowerCase(),
        method: "balanceOf",
        abi: "function balanceOf(address account) returns (uint256)",
        args: [params.fromAddress],
      },
    });

    // Transfer swap output from user to ENSO_SHORTCUTS for deposit
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: swapTarget.toLowerCase(),
        method: "transferFrom",
        abi: "function transferFrom(address from, address to, uint256 amount) returns (bool)",
        args: [params.fromAddress, ENSO_SHORTCUTS, { useOutputOfCallAt: swapBalIdx }],
      },
    });

    if ((isCvgCvxVault || isPxCvxVault) && CVX_HYBRID_ZAPPER) {
      // Use HybridZapper for optimal swap/mint split
      const type = isCvgCvxVault ? "cvgCvx" as const : "pxCvx" as const;
      const zapParams = await computeHybridZapParams(route.amountOut, type, params.slippage ?? 100);
      const zapActions = buildHybridZapperActions({
        type,
        cvxAmountRef: { useOutputOfCallAt: swapBalIdx },
        ...zapParams,
        vaultAddress: params.tokenOut,
        depositReceiver: params.fromAddress,
        actionsOffset: actions.length,
      });
      actions.push(...zapActions);
    } else if (isCvgCvxVault) {
      // Fallback without HybridZapper: CVX → CVX1 (mint) → cvgCVX (Curve exchange) → vault deposit
      actions.push({
        protocol: "enso", action: "call",
        args: { address: TOKENS.CVX.toLowerCase(), method: "approve", abi: "function approve(address spender, uint256 amount) returns (bool)", args: [TOKENS.CVX1.toLowerCase(), { useOutputOfCallAt: swapBalIdx }] },
      });
      actions.push({
        protocol: "enso", action: "call",
        args: { address: TOKENS.CVX1.toLowerCase(), method: "mint", abi: "function mint(address to, uint256 amount)", args: [ENSO_SHORTCUTS, { useOutputOfCallAt: swapBalIdx }] },
      });
      actions.push({
        protocol: "enso", action: "call",
        args: { address: TOKENS.CVX1.toLowerCase(), method: "approve", abi: "function approve(address spender, uint256 amount) returns (bool)", args: [TANGENT.CVX1_CVGCVX_POOL.toLowerCase(), { useOutputOfCallAt: swapBalIdx }] },
      });
      actions.push({
        protocol: "enso", action: "call",
        args: { address: TANGENT.CVX1_CVGCVX_POOL.toLowerCase(), method: "exchange", abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)", args: [0, 1, { useOutputOfCallAt: swapBalIdx }, "0"] },
      });
      const cvgCvxBalIdx = actions.length;
      actions.push({
        protocol: "enso", action: "call",
        args: { address: TOKENS.CVGCVX.toLowerCase(), method: "balanceOf", abi: "function balanceOf(address account) returns (uint256)", args: [ENSO_SHORTCUTS] },
      });
      actions.push({
        protocol: "enso", action: "call",
        args: { address: TOKENS.CVGCVX.toLowerCase(), method: "approve", abi: "function approve(address spender, uint256 amount) returns (bool)", args: [params.tokenOut.toLowerCase(), { useOutputOfCallAt: cvgCvxBalIdx }] },
      });
      actions.push({
        protocol: "enso", action: "call",
        args: { address: params.tokenOut.toLowerCase(), method: "deposit", abi: "function deposit(uint256 assets, address receiver) returns (uint256)", args: [{ useOutputOfCallAt: cvgCvxBalIdx }, params.fromAddress] },
      });
    } else if (isPxCvxVault) {
      // Fallback without HybridZapper: CVX → pxCVX (Pirex mint) → vault deposit
      actions.push({
        protocol: "enso", action: "call",
        args: { address: TOKENS.CVX.toLowerCase(), method: "approve", abi: "function approve(address spender, uint256 amount) returns (bool)", args: [PIREX.PIREX_CVX.toLowerCase(), { useOutputOfCallAt: swapBalIdx }] },
      });
      actions.push({
        protocol: "enso", action: "call",
        args: {
          address: PIREX.PIREX_CVX.toLowerCase(),
          method: "deposit",
          abi: "function deposit(uint256 assets, address receiver, bool shouldCompound, address developer)",
          args: [{ useOutputOfCallAt: swapBalIdx }, ENSO_SHORTCUTS, "false", "0x0000000000000000000000000000000000000000"],
        },
      });
      const pxCvxBalIdx = actions.length;
      actions.push({
        protocol: "enso", action: "call",
        args: { address: TOKENS.PXCVX.toLowerCase(), method: "balanceOf", abi: "function balanceOf(address account) returns (uint256)", args: [ENSO_SHORTCUTS] },
      });
      actions.push({
        protocol: "enso", action: "call",
        args: { address: TOKENS.PXCVX.toLowerCase(), method: "approve", abi: "function approve(address spender, uint256 amount) returns (bool)", args: [params.tokenOut.toLowerCase(), { useOutputOfCallAt: pxCvxBalIdx }] },
      });
      actions.push({
        protocol: "enso", action: "call",
        args: { address: params.tokenOut.toLowerCase(), method: "deposit", abi: "function deposit(uint256 assets, address receiver) returns (uint256)", args: [{ useOutputOfCallAt: pxCvxBalIdx }, params.fromAddress] },
      });
    } else {
      // Standard vault: approve underlying → vault deposit
      actions.push({
        protocol: "enso", action: "call",
        args: { address: outputVaultInfo.underlying.toLowerCase(), method: "approve", abi: "function approve(address spender, uint256 amount) returns (bool)", args: [params.tokenOut.toLowerCase(), { useOutputOfCallAt: swapBalIdx }] },
      });
      actions.push({
        protocol: "enso", action: "call",
        args: { address: params.tokenOut.toLowerCase(), method: "deposit", abi: "function deposit(uint256 assets, address receiver) returns (uint256)", args: [{ useOutputOfCallAt: swapBalIdx }, params.fromAddress] },
      });
    }
  } else {
    // Non-vault ERC20 output: routeMulti crvUSD → tokenOut directly to user
    const route = await fetchRoute({
      fromAddress: ZAPPER_V3_ADDRESS,
      tokenIn: CRVUSD,
      tokenOut: params.tokenOut,
      amountIn: params.debtAmount,
      slippage,
      receiver: params.fromAddress,
    });
    const innerSwapData = extractInnerSwapData(route.tx.data);
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: ENSO_ROUTER_EXECUTOR.toLowerCase(),
        method: "routeMulti",
        abi: "function routeMulti((uint8,bytes)[] tokensIn, bytes data) payable returns (bytes)",
        args: [[], innerSwapData],
      },
    });
  }

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
    skipQuote: needsSkipQuote || undefined,
  });
}

// Export controller addresses for use in other modules
export { CURVE_CONTROLLERS, CRVUSD };
