/**
 * Yearn V3 Strategy Source Code Parser
 *
 * Parses Solidity source code to extract strategy flow configuration.
 * Works with contracts that inherit from BaseStrategy and optionally AuctionSwapper.
 */

import type {
  StrategyFlowConfig,
  ParsedStrategy,
  YieldSourceInfo,
  RewardsInfo,
  CompoundingMechanism,
  FlowStep,
  StrategyFlow,
  FlowStepType,
} from "./types";

/**
 * Parse a Yearn V3 strategy contract source code
 */
export function parseStrategySource(
  source: string,
  contractAddress: string,
  contractName: string | null,
  compiler: string | null
): ParsedStrategy {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // Find the main contract definition
    const mainContract = findMainContract(source, contractName);
    if (!mainContract) {
      errors.push("Could not find main contract definition");
      return { success: false, config: null, errors, warnings };
    }

    // Check inheritance
    const inheritsBaseStrategy = checkInheritance(source, mainContract.name, "BaseStrategy");
    const inheritsAuctionSwapper = checkInheritance(source, mainContract.name, "AuctionSwapper");

    // Also check for custom auction implementation (like PxCVXCompounder)
    const hasCustomAuction = detectCustomAuction(source, mainContract.body);

    if (!inheritsBaseStrategy) {
      warnings.push("Contract does not appear to inherit from BaseStrategy");
    }

    // Extract yield source info
    const yieldSource = extractYieldSource(source, mainContract.body);

    // Extract asset info
    const asset = extractAsset(source, mainContract.body);

    // Extract code snippets
    const codeSnippets = {
      deployFunds: extractFunction(source, "_deployFunds"),
      freeFunds: extractFunction(source, "_freeFunds"),
      harvestAndReport: extractFunction(source, "_harvestAndReport"),
      claimRewards: extractFunction(source, "_claimRewards") || extractFunction(source, "claimRewards"),
    };

    // Determine rewards
    const rewards = extractRewards(source, mainContract.body, codeSnippets, asset.symbol);

    // Determine compounding mechanism
    const compounding = determineCompounding(
      inheritsAuctionSwapper || hasCustomAuction,
      rewards,
      source
    );

    const config: StrategyFlowConfig = {
      name: mainContract.name,
      address: contractAddress,
      compiler,
      asset,
      yieldSource,
      rewards,
      compounding,
      keeper: {
        address: null, // Will be populated from chain data
        isPermissionless: false,
      },
      inherits: {
        baseStrategy: inheritsBaseStrategy,
        auctionSwapper: inheritsAuctionSwapper || hasCustomAuction,
      },
      codeSnippets,
    };

    return { success: true, config, errors, warnings };
  } catch (error) {
    errors.push(`Parse error: ${error instanceof Error ? error.message : "Unknown error"}`);
    return { success: false, config: null, errors, warnings };
  }
}

/**
 * Find the main contract definition in the source
 */
function findMainContract(
  source: string,
  expectedName: string | null
): { name: string; body: string; inheritance: string } | null {
  // Pattern to match contract definitions with inheritance
  const contractPattern = /contract\s+(\w+)\s+is\s+([^{]+)\s*\{/g;
  const contracts: Array<{ name: string; body: string; inheritance: string; index: number }> = [];

  let match;
  while ((match = contractPattern.exec(source)) !== null) {
    const name = match[1];
    const inheritance = match[2].trim();
    const startIndex = match.index + match[0].length;

    // Find matching closing brace
    let braceCount = 1;
    let endIndex = startIndex;
    for (let i = startIndex; i < source.length && braceCount > 0; i++) {
      if (source[i] === "{") braceCount++;
      if (source[i] === "}") braceCount--;
      endIndex = i;
    }

    const body = source.slice(startIndex, endIndex);
    contracts.push({ name, body, inheritance, index: match.index });
  }

  // If we have an expected name, find that contract
  if (expectedName) {
    const found = contracts.find((c) => c.name === expectedName);
    if (found) return found;
  }

  // Otherwise find the contract that inherits BaseStrategy
  const strategyContract = contracts.find(
    (c) => c.inheritance.includes("BaseStrategy") || c.inheritance.includes("AuctionSwapper")
  );

  return strategyContract || contracts[contracts.length - 1] || null;
}

/**
 * Check if a contract inherits from a specific base
 */
function checkInheritance(source: string, contractName: string, baseName: string): boolean {
  const pattern = new RegExp(`contract\\s+${contractName}\\s+is\\s+[^{]*\\b${baseName}\\b`);
  return pattern.test(source);
}

/**
 * Detect custom auction implementation (strategies that don't inherit AuctionSwapper)
 */
function detectCustomAuction(source: string, _contractBody: string): boolean {
  // Check for auction state variable + kickAuction function
  const hasAuctionVar = /address\s+public\s+(?:immutable\s+)?auction\b/.test(source);
  const hasKickAuction = /function\s+kickAuction/.test(source);
  const hasAuctionTrigger = /function\s+auctionTrigger/.test(source);

  return hasAuctionVar && (hasKickAuction || hasAuctionTrigger);
}

/**
 * Extract yield source information from contract
 */
function extractYieldSource(source: string, _contractBody: string): YieldSourceInfo {
  // Look for constant declarations that are likely yield sources
  // Patterns match: TYPE public constant NAME = TYPE(0x...)
  const constantPatterns = [
    // Standard pattern with interface prefix I
    /(I\w+)\s+public\s+constant\s+(\w+)\s*=\s*\w+\((0x[a-fA-F0-9]{40})\)/g,
    // Without I prefix
    /(\w+)\s+public\s+constant\s+(\w+)\s*=\s*\w+\((0x[a-fA-F0-9]{40})\)/g,
    // Immutable variables
    /(I?\w+)\s+public\s+immutable\s+(\w+)/g,
  ];

  let yieldSourceName = "YieldSource";
  let yieldSourceAddress = "0x0000000000000000000000000000000000000000";
  let found = false;

  for (const pattern of constantPatterns) {
    if (found) break;
    pattern.lastIndex = 0; // Reset regex state

    let match;
    while ((match = pattern.exec(source)) !== null) {
      const typeName = match[1];
      const varName = match[2];
      const address = match[3];

      // Skip common non-yield-source types
      if (
        typeName.toLowerCase().includes("erc20") ||
        typeName.toLowerCase() === "ierc20" ||
        varName.toLowerCase() === "asset" ||
        varName.toLowerCase() === "auction"
      ) {
        continue;
      }

      // Likely yield source candidates - check type name and var name
      const typeNameLower = typeName.toLowerCase();
      const varNameLower = varName.toLowerCase();

      const isYieldSource =
        typeNameLower.includes("staking") ||
        typeNameLower.includes("wrapper") ||
        typeNameLower.includes("pool") ||
        typeNameLower.includes("vault") ||
        typeNameLower.includes("pirex") ||
        typeNameLower.includes("pxcvx") ||
        varNameLower.includes("staking") ||
        varNameLower.includes("wrapper") ||
        varNameLower.includes("pirex") ||
        varName === varName.toUpperCase(); // All caps like PXCVX, WRAPPER, STAKING

      if (isYieldSource) {
        yieldSourceName = varName;
        if (address) yieldSourceAddress = address;
        found = true;
        break;
      }
    }
  }

  // Extract function calls from _deployFunds to determine deposit function
  const deployFunds = extractFunction(source, "_deployFunds") || "";
  const depositFnMatch = deployFunds.match(/(\w+)\.(stake|deposit|supply|mint|redeem)\s*\(/);
  const depositFn = depositFnMatch ? depositFnMatch[2] : "deposit";

  // Check for pass-through strategies (no active deployment)
  const isPassThrough = deployFunds.includes("/*_amount*/") ||
    deployFunds.trim().match(/function\s+_deployFunds[^{]*\{\s*\}/);

  // Extract from _freeFunds to determine withdraw function
  const freeFunds = extractFunction(source, "_freeFunds") || "";
  const withdrawFnMatch = freeFunds.match(/(\w+)\.(withdraw|unstake|redeem|remove)\s*\(/);
  const withdrawFn = withdrawFnMatch ? withdrawFnMatch[2] : "withdraw";

  // Look for claim function in _harvestAndReport, _claimRewards, or helper functions
  // Search the entire source since claim logic may be in helper functions like _claimEpochRewards
  const claimFnMatch = source.match(
    /(\w+)\.(getReward|claimReward|claim|harvest|claimCvgCvxRewards|claimAll|claimVotiumRewards|redeemSnapshotRewards)\s*\(/
  );
  const claimFn = claimFnMatch ? claimFnMatch[2] : null;
  const claimContractName = claimFnMatch ? claimFnMatch[1] : null;

  // For pass-through strategies, use the claim function's target contract address
  // (e.g., PIREX_CVX for redeemSnapshotRewards) instead of the first constant found
  let claimContractAddress: string | null = null;
  if (isPassThrough && claimContractName) {
    const addrPattern = new RegExp(
      claimContractName + "\\s*[=:]\\s*[^(]*\\(?(0x[a-fA-F0-9]{40})\\)?",
      "i"
    );
    const addrMatch = source.match(addrPattern);
    if (addrMatch) {
      claimContractAddress = addrMatch[1];
    }
  }

  // Determine balance function
  const balanceFn = "balanceOf";

  return {
    name: isPassThrough ? "Direct Holding" : yieldSourceName,
    contractName: null, // Will be fetched separately if needed
    address: isPassThrough && claimContractAddress ? claimContractAddress : yieldSourceAddress,
    depositFn: isPassThrough ? "hold" : depositFn,
    withdrawFn: isPassThrough ? "transfer" : withdrawFn,
    claimFn,
    balanceFn,
  };
}

/**
 * Extract asset information
 */
function extractAsset(
  source: string,
  _contractBody: string
): { symbol: string; address: string } {
  // Look for common asset patterns in constructor or state
  const assetSymbols = [
    { pattern: /pxCVX|PXCVX/i, symbol: "pxCVX" },
    { pattern: /cvxCRV/i, symbol: "cvxCRV" },
    { pattern: /cvgCVX/i, symbol: "cvgCVX" },
    { pattern: /yCRV/i, symbol: "yCRV" },
    { pattern: /yPRISMA/i, symbol: "yPRISMA" },
    { pattern: /wstETH/i, symbol: "wstETH" },
    { pattern: /stETH/i, symbol: "stETH" },
    { pattern: /WETH/i, symbol: "WETH" },
    { pattern: /\bDAI\b/, symbol: "DAI" },
    { pattern: /\bUSDC\b/, symbol: "USDC" },
    { pattern: /\bUSDT\b/, symbol: "USDT" },
  ];

  // Check constructor for asset requirement
  const constructorMatch = source.match(/require\s*\(\s*_asset\s*==\s*address\s*\(\s*(\w+)\s*\)/);
  if (constructorMatch) {
    const varName = constructorMatch[1];
    // Look up what this constant/variable refers to
    for (const { pattern, symbol } of assetSymbols) {
      if (pattern.test(varName)) {
        return { symbol, address: "" };
      }
    }
  }

  for (const { pattern, symbol } of assetSymbols) {
    if (pattern.test(source)) {
      return { symbol, address: "" };
    }
  }

  return { symbol: "ASSET", address: "" };
}

/**
 * Extract function body from source code
 */
function extractFunction(source: string, functionName: string): string | null {
  // Match function definition
  const pattern = new RegExp(
    `function\\s+${functionName}\\s*\\([^)]*\\)[^{]*\\{`,
    "g"
  );

  const match = pattern.exec(source);
  if (!match) return null;

  const startIndex = match.index + match[0].length;

  // Find matching closing brace
  let braceCount = 1;
  let endIndex = startIndex;
  for (let i = startIndex; i < source.length && braceCount > 0; i++) {
    if (source[i] === "{") braceCount++;
    if (source[i] === "}") braceCount--;
    endIndex = i;
  }

  return source.slice(match.index, endIndex + 1);
}

/**
 * Extract rewards information
 */
function extractRewards(
  source: string,
  _contractBody: string,
  codeSnippets: { harvestAndReport: string | null; claimRewards: string | null },
  assetSymbol: string
): RewardsInfo {
  const combined =
    (codeSnippets.harvestAndReport || "") + (codeSnippets.claimRewards || "");

  // Check for common reward tokens in the source
  const rewardTokens: string[] = [];
  const assetLower = assetSymbol.toLowerCase();

  // Order matters - check derivative tokens before base tokens
  const tokenPatterns = [
    { pattern: /\bcvgCVX\b/i, symbol: "cvgCVX" },
    { pattern: /\bpxCVX\b/i, symbol: "pxCVX" },
    { pattern: /\bcvxCRV\b/i, symbol: "cvxCRV" },
    { pattern: /\bcrvUSD\b/i, symbol: "crvUSD" },
    { pattern: /\b3CRV\b|threeCrv/i, symbol: "3CRV" },
    { pattern: /\bCRV\b/, symbol: "CRV" },
    { pattern: /\bCVX\b/, symbol: "CVX" },
    { pattern: /\bFXS\b/, symbol: "FXS" },
    { pattern: /\bPRISMA\b/i, symbol: "PRISMA" },
    { pattern: /Votium/i, symbol: "Votium bribes" },
  ];

  // Check for Votium-style multi-reward pattern
  const hasVotium = source.toLowerCase().includes("votium");
  if (hasVotium) {
    rewardTokens.push("Votium bribes (various)");
  }

  // Check the natspec/comments for reward mentions (more reliable than code)
  const natspecMatch = source.match(/@notice.*?(?:earns?|rewards?|compounds?)([^.@*]+)/i);
  const natspecRewards = natspecMatch ? natspecMatch[1].toLowerCase() : "";

  // Check claim function and harvest function for reward mentions
  for (const { pattern, symbol } of tokenPatterns) {
    if (pattern.test(combined) || pattern.test(source)) {
      // Skip the asset token itself - it's what takers PAY in auction, not a reward being sold
      // Exception: direct compounding strategies where rewards ARE the asset
      if (symbol.toLowerCase() === assetLower) {
        // For direct compounding, add the asset as the reward
        // But for auction-based strategies, skip it
        continue;
      }

      // Skip base tokens (CVX, CRV) if their derivatives are the actual asset/reward
      // This catches cases like cvgCVX strategy where CVX appears in code but isn't the actual reward
      if (symbol === "CVX" && (
        rewardTokens.includes("cvgCVX") ||
        rewardTokens.includes("pxCVX") ||
        natspecRewards.includes("cvgcvx") ||
        assetLower === "cvgcvx" ||
        assetLower === "pxcvx"
      )) {
        continue;
      }
      // Skip CRV only if cvxCRV is already in rewardTokens (showing both would be redundant)
      // Note: DO NOT skip CRV when asset is cvxCRV - you actually EARN CRV from staking cvxCRV
      // Also don't use natspec check here - natspec often mentions cvxCRV as the TARGET asset, not a reward
      if (symbol === "CRV" && rewardTokens.includes("cvxCRV")) {
        continue;
      }

      // Skip 3CRV when crvUSD is present (legacy token replaced by crvUSD)
      if (symbol === "3CRV" && (rewardTokens.includes("crvUSD") || /\bcrvUSD\b/i.test(source))) {
        continue;
      }

      if (!rewardTokens.includes(symbol) && !symbol.includes("Votium")) {
        rewardTokens.push(symbol);
      }
    }
  }

  // Check if rewards are same as asset (direct compounding)
  const claimFn = codeSnippets.claimRewards || codeSnippets.harvestAndReport || "";
  const claimsSameAsAsset =
    claimFn.toLowerCase().includes(assetSymbol.toLowerCase() + "reward") ||
    claimFn.toLowerCase().includes("claim" + assetSymbol.toLowerCase());

  // If no rewards found, add generic placeholder
  if (rewardTokens.length === 0) {
    rewardTokens.push(assetSymbol);
  }

  const isSameAsAsset =
    claimsSameAsAsset ||
    (rewardTokens.length === 1 &&
      rewardTokens[0].toLowerCase() === assetSymbol.toLowerCase());

  return {
    tokens: rewardTokens,
    isSameAsAsset,
  };
}

/**
 * Determine compounding mechanism
 */
function determineCompounding(
  hasAuction: boolean,
  rewards: RewardsInfo,
  source: string
): {
  mechanism: CompoundingMechanism;
  auction: { address: string | null; enabled: boolean } | null;
} {
  if (hasAuction) {
    // Extract auction address if present
    const auctionMatch = source.match(/auction\s*=\s*(0x[a-fA-F0-9]{40})/);
    // Also check for factory-deployed auction
    return {
      mechanism: "auction",
      auction: {
        address: auctionMatch ? auctionMatch[1] : null,
        enabled: true,
      },
    };
  }

  if (rewards.isSameAsAsset) {
    return {
      mechanism: "direct",
      auction: null,
    };
  }

  return {
    mechanism: "none",
    auction: null,
  };
}

/**
 * Generate flow steps from config
 */
export function generateFlowSteps(config: StrategyFlowConfig): StrategyFlow {
  const steps: FlowStep[] = [];

  // Common steps for all strategies
  steps.push({
    id: "deposit",
    label: "DEPOSIT",
    description: `User deposits ${config.asset.symbol} to Strategy`,
    actor: "user",
    isOptional: false,
  });

  steps.push({
    id: "stake",
    label: config.yieldSource.depositFn === "hold" ? "HOLD" : "STAKE",
    description: config.yieldSource.depositFn === "hold"
      ? `Strategy holds ${config.asset.symbol} directly`
      : `Strategy calls ${config.yieldSource.name}.${config.yieldSource.depositFn}()`,
    actor: "strategy",
    isOptional: false,
  });

  steps.push({
    id: "earn",
    label: "EARN",
    description: `Earns ${config.rewards.tokens.slice(0, 3).join(", ")}${config.rewards.tokens.length > 3 ? "..." : ""} rewards`,
    actor: "yield_source",
    isOptional: false,
  });

  steps.push({
    id: "report",
    label: "REPORT",
    description: "Keeper calls report() to trigger harvest",
    actor: "keeper",
    isOptional: false,
  });

  if (config.yieldSource.claimFn) {
    steps.push({
      id: "claim",
      label: "CLAIM",
      description: `Claims rewards via ${config.yieldSource.claimFn}()`,
      actor: "strategy",
      isOptional: false,
    });
  }

  // Auction steps (only for auction-based strategies)
  if (config.compounding.mechanism === "auction") {
    steps.push({
      id: "auction",
      label: "AUCTION",
      description: `Dutch auction sells rewards for ${config.asset.symbol}`,
      actor: "strategy",
      isOptional: false,
    });

    steps.push({
      id: "receive",
      label: "RECEIVE",
      description: `Taker pays ${config.asset.symbol}, receives reward tokens`,
      actor: "taker",
      isOptional: false,
    });
  }

  steps.push({
    id: "compound",
    label: "COMPOUND",
    description:
      config.compounding.mechanism === "direct"
        ? `${config.asset.symbol} rewards immediately available`
        : config.compounding.mechanism === "auction"
        ? `${config.asset.symbol} from auction sits idle`
        : "Rewards accumulated",
    actor: "strategy",
    isOptional: false,
  });

  steps.push({
    id: "restake",
    label: "RE-STAKE",
    description: `Next report re-deploys idle ${config.asset.symbol}`,
    actor: "strategy",
    isOptional: false,
  });

  // Withdrawal steps
  steps.push({
    id: "withdraw",
    label: "WITHDRAW",
    description: `User redeems shares for ${config.asset.symbol}`,
    actor: "user",
    isOptional: true,
  });

  steps.push({
    id: "exit",
    label: "EXIT",
    description: `User receives ${config.asset.symbol}`,
    actor: "user",
    isOptional: true,
  });

  // Define cycle and exit steps
  let cycleSteps: FlowStepType[];

  if (config.compounding.mechanism === "auction") {
    cycleSteps = config.yieldSource.claimFn
      ? ["deposit", "stake", "earn", "report", "claim", "auction", "receive", "compound", "restake"]
      : ["deposit", "stake", "earn", "report", "auction", "receive", "compound", "restake"];
  } else {
    cycleSteps = config.yieldSource.claimFn
      ? ["deposit", "stake", "earn", "report", "claim", "compound", "restake"]
      : ["deposit", "stake", "earn", "report", "compound", "restake"];
  }

  const exitSteps: FlowStepType[] = ["withdraw", "exit"];

  return {
    config,
    steps,
    cycleSteps,
    exitSteps,
  };
}
