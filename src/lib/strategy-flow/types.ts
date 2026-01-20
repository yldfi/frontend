/**
 * Types for Yearn V3 Strategy Flow Visualization
 *
 * These types represent the extracted flow configuration from a strategy contract
 * that can be used to generate animated diagrams.
 */

export interface TokenInfo {
  symbol: string;
  address: string;
}

export interface YieldSourceInfo {
  name: string;
  contractName: string | null; // Actual contract name from Etherscan
  address: string;
  depositFn: string;
  withdrawFn: string;
  claimFn: string | null;
  balanceFn: string;
}

export interface RewardsInfo {
  tokens: string[];
  isSameAsAsset: boolean;
}

export type CompoundingMechanism = "auction" | "direct" | "none";

export interface AuctionInfo {
  address: string | null;
  enabled: boolean;
}

export interface StrategyFlowConfig {
  // Contract identity
  name: string;
  address: string;
  compiler: string | null;

  // Asset layer
  asset: TokenInfo;

  // Yield source layer
  yieldSource: YieldSourceInfo;

  // Rewards layer
  rewards: RewardsInfo;

  // Compounding layer
  compounding: {
    mechanism: CompoundingMechanism;
    auction: AuctionInfo | null;
  };

  // Keeper info (read from chain)
  keeper: {
    address: string | null;
    isPermissionless: boolean; // true if 0x52605BbF54845f520a3E94792d019f62407db2f8
  };

  // Inheritance info
  inherits: {
    baseStrategy: boolean;
    auctionSwapper: boolean;
  };

  // Raw extracted code snippets (for detailed view)
  codeSnippets: {
    deployFunds: string | null;
    freeFunds: string | null;
    harvestAndReport: string | null;
    claimRewards: string | null;
  };
}

export interface ParsedStrategy {
  success: boolean;
  config: StrategyFlowConfig | null;
  errors: string[];
  warnings: string[];
}

// Flow step types for animation
export type FlowStepType =
  | "deposit"
  | "stake"
  | "earn"
  | "report"
  | "claim"
  | "auction"
  | "receive"
  | "compound"
  | "restake"
  | "withdraw"
  | "exit";

export interface FlowStep {
  id: FlowStepType;
  label: string;
  description: string;
  actor: "user" | "keeper" | "taker" | "strategy" | "yield_source";
  isOptional: boolean;
}

export interface StrategyFlow {
  config: StrategyFlowConfig;
  steps: FlowStep[];
  cycleSteps: FlowStepType[]; // Steps that form the main cycle
  exitSteps: FlowStepType[]; // Steps for withdrawal/exit
}
