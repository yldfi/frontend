// Curve LlamaLend bundle functions using Enso API
// For creating loans, borrowing, repaying, and managing collateral

import type { EnsoBundleAction, EnsoBundleResponse } from "@/types/enso";
import { CURVE_CONTROLLERS } from "@/config/vaults";

// crvUSD token address
const CRVUSD = "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E";

// ABI fragments for Controller functions
const CONTROLLER_CREATE_LOAN_ABI = "function create_loan(uint256 collateral, uint256 debt, uint256 N)";
const CONTROLLER_ADD_COLLATERAL_ABI = "function add_collateral(uint256 collateral, address _for)";
const CONTROLLER_REMOVE_COLLATERAL_ABI = "function remove_collateral(uint256 collateral, bool use_eth)";
const CONTROLLER_BORROW_MORE_ABI = "function borrow_more(uint256 collateral, uint256 debt)";
const CONTROLLER_REPAY_ABI = "function repay(uint256 _d_debt, address _for, int256 max_active_band, bool use_eth)";

// Import the fetchBundle function from enso.ts
// We'll use dynamic import to avoid circular dependencies
async function fetchBundle(params: {
  fromAddress: string;
  actions: EnsoBundleAction[];
  receiver?: string;
  routingStrategy?: "router" | "delegate";
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
        address: controllerAddress,
        method: "create_loan",
        abi: CONTROLLER_CREATE_LOAN_ABI,
        args: [params.collateralAmount, params.debtAmount, params.bands],
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
        address: controllerAddress,
        method: "add_collateral",
        abi: CONTROLLER_ADD_COLLATERAL_ABI,
        args: [params.collateralAmount, params.fromAddress],
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
        address: controllerAddress,
        method: "remove_collateral",
        abi: CONTROLLER_REMOVE_COLLATERAL_ABI,
        args: [params.collateralAmount, false], // use_eth = false
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
 * Borrow more crvUSD against existing collateral
 * Optionally add more collateral at the same time
 */
export async function fetchBorrowMoreBundle(params: {
  fromAddress: string;
  vaultAddress: `0x${string}`;
  additionalCollateral: string;
  additionalDebt: string;
}): Promise<EnsoBundleResponse> {
  const controllerAddress = CURVE_CONTROLLERS[params.vaultAddress as keyof typeof CURVE_CONTROLLERS];
  if (!controllerAddress) {
    throw new Error(`No controller found for vault ${params.vaultAddress}`);
  }

  const actions: EnsoBundleAction[] = [];

  // If adding collateral, approve first
  if (BigInt(params.additionalCollateral) > 0n) {
    actions.push({
      protocol: "erc20",
      action: "approve",
      args: {
        token: params.vaultAddress,
        spender: controllerAddress,
        amount: params.additionalCollateral,
      },
    });
  }

  // Borrow more
  actions.push({
    protocol: "enso",
    action: "call",
    args: {
      address: controllerAddress,
      method: "borrow_more",
      abi: CONTROLLER_BORROW_MORE_ABI,
      args: [params.additionalCollateral, params.additionalDebt],
    },
  });

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "delegate",
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
  const controllerAddress = CURVE_CONTROLLERS[params.vaultAddress as keyof typeof CURVE_CONTROLLERS];
  if (!controllerAddress) {
    throw new Error(`No controller found for vault ${params.vaultAddress}`);
  }

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
        address: controllerAddress,
        method: "repay",
        abi: CONTROLLER_REPAY_ABI,
        args: [
          params.repayAmount,
          params.fromAddress,
          params.maxActiveBand ?? 2 ** 255 - 1, // max int256
          false, // use_eth
        ],
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
 * Sequential leverage: deposit collateral, borrow, swap to more collateral, add
 * This achieves ~1.5-2x leverage in a single transaction without flash loans
 */
export async function fetchSequentialLeverageBundle(params: {
  fromAddress: string;
  vaultAddress: `0x${string}`;
  underlyingToken: `0x${string}`; // e.g., cvxCRV for ycvxCRV
  initialCollateral: string;
  borrowAmount: string;
  bands: number;
  slippage: string;
  isNewLoan: boolean;
}): Promise<EnsoBundleResponse> {
  const controllerAddress = CURVE_CONTROLLERS[params.vaultAddress as keyof typeof CURVE_CONTROLLERS];
  if (!controllerAddress) {
    throw new Error(`No controller found for vault ${params.vaultAddress}`);
  }

  const actions: EnsoBundleAction[] = [];

  // 1. Approve initial collateral to controller
  actions.push({
    protocol: "erc20",
    action: "approve",
    args: {
      token: params.vaultAddress,
      spender: controllerAddress,
      amount: params.initialCollateral,
    },
  });

  // 2. Create loan or borrow more
  if (params.isNewLoan) {
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: controllerAddress,
        method: "create_loan",
        abi: CONTROLLER_CREATE_LOAN_ABI,
        args: [params.initialCollateral, params.borrowAmount, params.bands],
      },
    });
  } else {
    actions.push({
      protocol: "enso",
      action: "call",
      args: {
        address: controllerAddress,
        method: "borrow_more",
        abi: CONTROLLER_BORROW_MORE_ABI,
        args: [params.initialCollateral, params.borrowAmount],
      },
    });
  }

  // 3. Swap borrowed crvUSD to underlying token (e.g., cvxCRV)
  actions.push({
    protocol: "enso",
    action: "route",
    args: {
      tokenIn: CRVUSD,
      tokenOut: params.underlyingToken,
      amountIn: params.borrowAmount,
      slippage: params.slippage,
    },
  });

  // 4. Deposit underlying to vault
  actions.push({
    protocol: "erc4626",
    action: "deposit",
    args: {
      tokenIn: params.underlyingToken,
      tokenOut: params.vaultAddress,
      amountIn: { useOutputOfCallAt: 2 }, // Use output from swap
      primaryAddress: params.vaultAddress,
    },
  });

  // 5. Approve new vault shares to controller
  actions.push({
    protocol: "erc20",
    action: "approve",
    args: {
      token: params.vaultAddress,
      spender: controllerAddress,
      amount: { useOutputOfCallAt: 3 }, // Use output from deposit
    },
  });

  // 6. Add new collateral
  actions.push({
    protocol: "enso",
    action: "call",
    args: {
      address: controllerAddress,
      method: "add_collateral",
      abi: CONTROLLER_ADD_COLLATERAL_ABI,
      args: [{ useOutputOfCallAt: 3 }, params.fromAddress],
    },
  });

  return fetchBundle({
    fromAddress: params.fromAddress,
    actions,
    routingStrategy: "delegate",
  });
}

// Export controller addresses for use in other modules
export { CURVE_CONTROLLERS, CRVUSD };
