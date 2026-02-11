// Curve LlamaLend bundle functions using Enso API
// For creating loans, borrowing, repaying, and managing collateral

import type { EnsoBundleAction, EnsoBundleResponse } from "@/types/enso";
import { CURVE_CONTROLLERS, VAULTS, EXTERNAL_VAULT_CONFIG, TOKENS, PIREX, LLAMA_AIRFORCE, TANGENT } from "@/config/vaults";
import { calculateMinDy } from "@/lib/curve";
import { getLpxCvxToCvxSwapRate, ENSO_SHORTCUTS, ENSO_ROUTER_EXECUTOR, fetchRoute } from "@/lib/enso";
import { previewRedeem } from "@/lib/curve/rpc";
import { CRVUSD_ADDRESS, ZAPPER_ADDRESS } from "@/lib/zapper";
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
// Repay ABI - uses 3-param overload (no use_eth on this controller)
const CONTROLLER_REPAY_ABI = "function repay(uint256 _d_debt, address _for, int256 max_active_band)";
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
export async function fetchRepayWithSwapBundle(params: {
  fromAddress: string;
  vaultAddress: `0x${string}`;
  tokenIn: string; // Token to swap from
  amountIn: string; // Amount of tokenIn
  slippage?: number; // Slippage in basis points (default 100 = 1%)
  maxRepayAmount?: string; // Optional cap on repay amount (for closing loans)
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
        // Action 6: Repay debt
        {
          protocol: "curve-lending",
          action: "repay",
          args: {
            tokenIn: CRVUSD,
            amountIn: { useOutputOfCallAt: 5 }, // Use output from CVX→crvUSD route
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
    actions.push({
      protocol: "curve-lending",
      action: "repay",
      args: {
        tokenIn: CRVUSD,
        amountIn: { useOutputOfCallAt: 1 }, // Use output from swap
        primaryAddress: controllerAddress,
        onBehalfOf: params.fromAddress,
      },
    });

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
    // 2. Repay debt using native curve-lending protocol action
    {
      protocol: "curve-lending",
      action: "repay",
      args: {
        tokenIn: CRVUSD,
        amountIn: { useOutputOfCallAt: 0 }, // Use swapped amount for repay
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
  slippage?: number; // Basis points (default 100 = 1%)
}): Promise<EnsoBundleResponse> {
  const controllerAddress = CURVE_CONTROLLERS[params.vaultAddress as keyof typeof CURVE_CONTROLLERS];
  if (!controllerAddress) {
    throw new Error(`No controller found for vault ${params.vaultAddress}`);
  }

  const slippage = (params.slippage ?? 100).toString();
  const actions: EnsoBundleAction[] = [];
  const vaultInfo = getVaultInfo(params.tokenOut);

  // Action 0: borrow_more — borrows crvUSD, sent to _for (user's wallet, NOT msg.sender)
  actions.push({
    protocol: "enso",
    action: "call",
    args: {
      address: controllerAddress.toLowerCase(),
      method: "borrow_more",
      abi: "function borrow_more(uint256 collateral, uint256 debt, address _for)",
      args: ["0", params.debtAmount, params.fromAddress],
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

    // Determine swap target: cvgCVX vault routes through CVX, others to underlying
    const swapTarget = isCvgCvxVault ? TOKENS.CVX : vaultInfo.underlying;

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

    if (isCvgCvxVault) {
      // cvgCVX vault: CVX → CVX1 (1:1 mint) → cvgCVX (Curve pool) → vault deposit
      // CVX is now in ENSO_SHORTCUTS from the transferFrom above

      // Approve CVX → CVX1 wrapper
      actions.push({
        protocol: "enso",
        action: "call",
        args: {
          address: TOKENS.CVX.toLowerCase(),
          method: "approve",
          abi: "function approve(address spender, uint256 amount) returns (bool)",
          args: [TOKENS.CVX1.toLowerCase(), { useOutputOfCallAt: swapBalIdx }],
        },
      });

      // Mint CVX → CVX1 (to ENSO_SHORTCUTS for Curve exchange)
      actions.push({
        protocol: "enso",
        action: "call",
        args: {
          address: TOKENS.CVX1.toLowerCase(),
          method: "mint",
          abi: "function mint(address to, uint256 amount)",
          args: [ENSO_SHORTCUTS, { useOutputOfCallAt: swapBalIdx }],
        },
      });

      // Approve CVX1 → Curve pool
      actions.push({
        protocol: "enso",
        action: "call",
        args: {
          address: TOKENS.CVX1.toLowerCase(),
          method: "approve",
          abi: "function approve(address spender, uint256 amount) returns (bool)",
          args: [TANGENT.CVX1_CVGCVX_POOL.toLowerCase(), { useOutputOfCallAt: swapBalIdx }],
        },
      });

      // Exchange CVX1 → cvgCVX via Curve pool
      actions.push({
        protocol: "enso",
        action: "call",
        args: {
          address: TANGENT.CVX1_CVGCVX_POOL.toLowerCase(),
          method: "exchange",
          abi: "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
          args: [0, 1, { useOutputOfCallAt: swapBalIdx }, "0"],
        },
      });

      // Get cvgCVX balance for deposit
      const cvgCvxBalIdx = actions.length;
      actions.push({
        protocol: "enso",
        action: "call",
        args: {
          address: TOKENS.CVGCVX.toLowerCase(),
          method: "balanceOf",
          abi: "function balanceOf(address account) returns (uint256)",
          args: [ENSO_SHORTCUTS],
        },
      });

      // Approve cvgCVX → vault
      actions.push({
        protocol: "enso",
        action: "call",
        args: {
          address: TOKENS.CVGCVX.toLowerCase(),
          method: "approve",
          abi: "function approve(address spender, uint256 amount) returns (bool)",
          args: [params.tokenOut.toLowerCase(), { useOutputOfCallAt: cvgCvxBalIdx }],
        },
      });

      // Deposit cvgCVX → vault
      actions.push({
        protocol: "enso",
        action: "call",
        args: {
          address: params.tokenOut.toLowerCase(),
          method: "deposit",
          abi: "function deposit(uint256 assets, address receiver) returns (uint256)",
          args: [{ useOutputOfCallAt: cvgCvxBalIdx }, params.fromAddress],
        },
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
      fromAddress: ZAPPER_ADDRESS,
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
 * tokenIn → route to vaultToken → approve → create_loan
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
 * Remove collateral from an existing loan and swap vault token to any output token.
 * remove_collateral → route vaultToken → tokenOut
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

  const actions: EnsoBundleAction[] = [
    // 1. Remove collateral (vault tokens sent to msg.sender = ENSO_SHORTCUTS in router mode)
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
    // 2. Route vault token → desired output token
    {
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.vaultAddress,
        tokenOut: params.tokenOut,
        amountIn: { useOutputOfCallAt: 0 },
        slippage,
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
 * The output swap route uses fromAddress=ZAPPER_ADDRESS, receiver=user so
 * output tokens go directly to the user's wallet.
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

  if (hasInputSwap) {
    // Step 1: Route input token → vault token
    actions.push({
      protocol: "enso",
      action: "route",
      args: {
        tokenIn: params.tokenIn!,
        tokenOut: params.vaultAddress,
        amountIn: params.amountIn,
        slippage,
      },
    });
  }

  // Approve vault tokens to controller
  actions.push({
    protocol: "erc20",
    action: "approve",
    args: {
      token: params.vaultAddress,
      spender: controllerAddress,
      amount: hasInputSwap ? { useOutputOfCallAt: 0 } : params.amountIn,
    },
  });

  // Create loan — crvUSD goes to msg.sender (ENSO_SHORTCUTS in router mode)
  actions.push({
    protocol: "enso",
    action: "call",
    args: {
      address: controllerAddress.toLowerCase(),
      method: "create_loan",
      abi: CONTROLLER_CREATE_LOAN_ABI,
      args: [
        hasInputSwap ? { useOutputOfCallAt: 0 } : params.amountIn,
        params.debtAmount,
        params.bands,
      ],
    },
  });

  // Fetch route for crvUSD → tokenOut
  // fromAddress=ZAPPER_ADDRESS (tokens are in ENSO_SHORTCUTS, same as zapper patterns)
  // receiver=user so output goes directly to user
  const route = await fetchRoute({
    fromAddress: ZAPPER_ADDRESS,
    tokenIn: CRVUSD,
    tokenOut: params.tokenOut,
    amountIn: params.debtAmount,
    slippage,
    receiver: params.fromAddress,
  });

  // Extract inner swap data from routeSingle response
  const innerSwapData = extractInnerSwapData(route.tx.data);

  // Recursive routeMulti: swap crvUSD (already in ENSO_SHORTCUTS) without pulling tokens
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

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "router",
    skipQuote: true, // routeMulti breaks Enso's simulation
  });
}

// Export controller addresses for use in other modules
export { CURVE_CONTROLLERS, CRVUSD };
