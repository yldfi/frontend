// Curve LlamaLend bundle functions using Enso API
// For creating loans, borrowing, repaying, and managing collateral

import type { EnsoBundleAction, EnsoBundleResponse } from "@/types/enso";
import { CURVE_CONTROLLERS, VAULTS, EXTERNAL_VAULT_CONFIG, TOKENS, PIREX, LLAMA_AIRFORCE, TANGENT } from "@/config/vaults";
import { calculateMinDy } from "@/lib/curve";
import { getLpxCvxToCvxSwapRate, getCvgCvxReverseSwapRate, ENSO_SHORTCUTS, ENSO_ROUTER_EXECUTOR, fetchRoute, CVX_HYBRID_ZAPPER, computeHybridZapParams, buildHybridZapperActions } from "@/lib/enso";
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

// fetchBorrowAndSwapBundle removed — replaced by V3 borrowAndConvert/borrowAndDeposit
// fetchBorrowWithSwapCollateralBundle removed — replaced by V4 borrowMoreFromToken
// fetchRemoveCollateralAndSwapBundle removed — replaced by V3 removeCollateralAndConvert
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
    // Both cvgCVX and pxCVX paths use route action which Enso can simulate
    const needsSkipQuote = false;

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
      // cvgCVX → CVX1 (Curve StableSwap exchange) → CVX (HybridZapper unwrap) → route to target vault
      const estimatedCvgCvx = await previewRedeem(vaultInfo.address, params.amountIn);
      const expectedCvx1 = await getCvgCvxReverseSwapRate(estimatedCvgCvx.toString());
      if (expectedCvx1 === 0n) throw new Error("Failed to estimate cvgCVX→CVX1 swap output");
      const slippageBps = params.slippage ?? 100;
      const minDyCvx1 = calculateMinDy(expectedCvx1, slippageBps);

      // Action 1: approve cvgCVX → Curve pool
      actions.push({ protocol: "erc20", action: "approve", args: { token: TOKENS.CVGCVX, spender: TANGENT.CVX1_CVGCVX_POOL, amount: { useOutputOfCallAt: 0 } } });
      // Action 2: exchange cvgCVX → CVX1
      const exchangeIdx = actions.length;
      actions.push({ protocol: "enso", action: "call", args: { address: TANGENT.CVX1_CVGCVX_POOL.toLowerCase(), method: "exchange", abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)", args: [1, 0, { useOutputOfCallAt: 0 }, minDyCvx1.toString()] } });
      // Action 3: transfer CVX1 → HybridZapper
      actions.push({ protocol: "erc20", action: "transfer", args: { token: TOKENS.CVX1, receiver: CVX_HYBRID_ZAPPER!, amount: { useOutputOfCallAt: exchangeIdx } } });
      // Action 4: unwrap CVX1 → CVX
      const unwrapIdx = actions.length;
      actions.push({ protocol: "enso", action: "call", args: { address: CVX_HYBRID_ZAPPER!.toLowerCase(), method: "unwrapCvx1ToCvx", abi: "function unwrapCvx1ToCvx(uint256 amount, address receiver) returns (uint256)", args: [{ useOutputOfCallAt: exchangeIdx }, ENSO_SHORTCUTS] } });
      // Action 5: route CVX → target vault token
      const routeIdx = actions.length;
      actions.push({ protocol: "enso", action: "route", args: { tokenIn: TOKENS.CVX, tokenOut: params.vaultAddress, amountIn: { useOutputOfCallAt: unwrapIdx }, slippage } });
      actions.push(
        { protocol: "erc20", action: "approve", args: { token: params.vaultAddress, spender: controllerAddress, amount: { useOutputOfCallAt: routeIdx } } },
        { protocol: "enso", action: "call", args: { address: controllerAddress.toLowerCase(), method: "create_loan", abi: CONTROLLER_CREATE_LOAN_ABI, args: [{ useOutputOfCallAt: routeIdx }, params.debtAmount, params.bands] } },
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
 * - cvgCVX vault: route(crvUSD→CVX) → HybridZapper(CVX→cvgCVX) → deposit
 * - pxCVX vault: route(crvUSD→CVX) → HybridZapper(CVX→pxCVX) → deposit
 * - Standard vault: route(crvUSD→underlying) → approve + deposit
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
  const inputUsesHybridZapper = false;

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
      // cvgCVX → CVX1 (Curve StableSwap exchange) → CVX (HybridZapper unwrap) → route to target vault
      const estimatedCvgCvx = await previewRedeem(inputVaultInfo.address, params.amountIn);
      const expectedCvx1 = await getCvgCvxReverseSwapRate(estimatedCvgCvx.toString());
      if (expectedCvx1 === 0n) throw new Error("Failed to estimate cvgCVX→CVX1 swap output");
      const minDyCvx1 = calculateMinDy(expectedCvx1, params.slippage ?? 100);

      actions.push(
        { protocol: "erc20", action: "approve", args: { token: TOKENS.CVGCVX, spender: TANGENT.CVX1_CVGCVX_POOL, amount: { useOutputOfCallAt: 0 } } },
      );
      const exchangeIdx = actions.length;
      actions.push(
        { protocol: "enso", action: "call", args: { address: TANGENT.CVX1_CVGCVX_POOL.toLowerCase(), method: "exchange", abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)", args: [1, 0, { useOutputOfCallAt: 0 }, minDyCvx1.toString()] } },
        { protocol: "erc20", action: "transfer", args: { token: TOKENS.CVX1, receiver: CVX_HYBRID_ZAPPER!, amount: { useOutputOfCallAt: exchangeIdx } } },
      );
      const unwrapIdx = actions.length;
      actions.push(
        { protocol: "enso", action: "call", args: { address: CVX_HYBRID_ZAPPER!.toLowerCase(), method: "unwrapCvx1ToCvx", abi: "function unwrapCvx1ToCvx(uint256 amount, address receiver) returns (uint256)", args: [{ useOutputOfCallAt: exchangeIdx }, ENSO_SHORTCUTS] } },
      );
      vaultTokenAmountIdx = actions.length;
      actions.push({ protocol: "enso", action: "route", args: { tokenIn: TOKENS.CVX, tokenOut: params.vaultAddress, amountIn: { useOutputOfCallAt: unwrapIdx }, slippage } });
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
    // Vault token output: use route action (output stays in ENSO_SHORTCUTS), then deposit
    const isCvgCvxVault = outputVaultInfo.underlying.toLowerCase() === TOKENS.CVGCVX.toLowerCase();
    const isPxCvxVault = outputVaultInfo.underlying.toLowerCase() === TOKENS.PXCVX.toLowerCase();

    if (isCvgCvxVault || isPxCvxVault) {
      // Exotic vault: route crvUSD → CVX (stays in ENSO_SHORTCUTS), then HybridZapper → underlying → deposit
      const routeIdx = actions.length;
      actions.push({ protocol: "enso", action: "route", args: { tokenIn: CRVUSD, tokenOut: TOKENS.CVX, amountIn: params.debtAmount, slippage } });

      // Fetch CVX estimate for HybridZapper params
      const cvxEstimate = await fetchRoute({
        fromAddress: params.fromAddress,
        tokenIn: CRVUSD,
        tokenOut: TOKENS.CVX,
        amountIn: params.debtAmount,
        slippage,
      });

      const type = isCvgCvxVault ? "cvgCvx" as const : "pxCvx" as const;
      const zapParams = await computeHybridZapParams(cvxEstimate.amountOut, type, params.slippage ?? 100);
      const zapActions = buildHybridZapperActions({
        type,
        cvxAmountRef: { useOutputOfCallAt: routeIdx },
        ...zapParams,
        vaultAddress: params.tokenOut,
        depositReceiver: params.fromAddress,
        actionsOffset: actions.length,
      });
      actions.push(...zapActions);
    } else {
      // Standard vault: route crvUSD → underlying (stays in ENSO_SHORTCUTS), then approve + deposit
      const routeIdx = actions.length;
      actions.push({ protocol: "enso", action: "route", args: { tokenIn: CRVUSD, tokenOut: outputVaultInfo.underlying, amountIn: params.debtAmount, slippage } });
      actions.push({
        protocol: "enso", action: "call",
        args: { address: outputVaultInfo.underlying.toLowerCase(), method: "approve", abi: "function approve(address spender, uint256 amount) returns (bool)", args: [params.tokenOut.toLowerCase(), { useOutputOfCallAt: routeIdx }] },
      });
      actions.push({
        protocol: "enso", action: "call",
        args: { address: params.tokenOut.toLowerCase(), method: "deposit", abi: "function deposit(uint256 assets, address receiver) returns (uint256)", args: [{ useOutputOfCallAt: routeIdx }, params.fromAddress] },
      });
    }
    needsSkipQuote = inputUsesHybridZapper; // only skip if input side needs it
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
