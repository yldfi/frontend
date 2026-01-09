/**
 * RouteDisplay Component
 *
 * Displays the route path for zap operations with:
 * - Vertical step-by-step layout
 * - Token pills with icons
 * - Action descriptions (Swap, Mint, Deposit, etc.)
 * - Protocol names
 */

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type { RouteInfo, RouteStep } from "@/types/enso";
import { VAULTS } from "@/config/vaults";

interface RouteDisplayProps {
  routeInfo?: RouteInfo;
  inputSymbol?: string;
  outputSymbol?: string;
  inputAmount?: string;
  outputAmount?: string;
  isLoading?: boolean;
}

// Token logo paths (local files in /public/tokens/)
const TOKEN_LOGOS: Record<string, string> = {
  eth: "/tokens/eth.png",
  weth: "/tokens/weth.png",
  cvx: "/tokens/cvx.png",
  cvxcrv: "/tokens/cvxcrv.png",
  crv: "/tokens/crv.png",
  cvgcvx: "/tokens/cvgcvx.png",
  pxcvx: "/tokens/pxcvx.png",
  usdc: "/tokens/usdc.png",
  usdt: "/tokens/usdt.png",
  dai: "/tokens/dai.png",
  crvusd: "/tokens/crvusd.png",
};

// Get logo URL for a token symbol - checks TOKEN_LOGOS first, then VAULTS config
function getTokenLogo(symbol: string): string | undefined {
  // Check hardcoded logos first (case-insensitive)
  const normalized = symbol.toLowerCase();
  if (TOKEN_LOGOS[normalized]) {
    return TOKEN_LOGOS[normalized];
  }
  // Check vault config by symbol (case-insensitive)
  const vault = Object.values(VAULTS).find(
    (v) => v.symbol.toLowerCase() === normalized
  );
  return vault?.logoSmall;
}

// Protocol styles - use foreground color for all protocols to match UI
const PROTOCOL_STYLES: Record<string, string> = {
  Enso: "text-[var(--foreground)]",
  Curve: "text-[var(--foreground)]",
  Convex: "text-[var(--foreground)]",
  "yld_fi": "text-[var(--foreground)]",
  Pirex: "text-[var(--foreground)]",
};

// Protocol links - map protocol names to their websites (from Enso docs)
const PROTOCOL_LINKS: Record<string, string> = {
  // DEX Aggregators
  "enso": "https://enso.build",
  "odos": "https://odos.xyz",
  "1inch": "https://1inch.io",
  "0x": "https://0x.org",
  "openocean": "https://openocean.finance",
  "paraswap": "https://paraswap.io",
  "cowswap": "https://cow.fi",
  "cow swap": "https://cow.fi",
  "matcha": "https://matcha.xyz",
  "bebop": "https://bebop.xyz",
  "hashflow": "https://hashflow.com",
  "dodo": "https://dodoex.io",
  "woofi": "https://fi.woo.org",
  "fly": "https://fly.trade",
  "barter": "https://barterswap.xyz",
  // DEXs (from Enso docs)
  "uniswap": "https://uniswap.org",
  "sushiswap": "https://sushi.com",
  "sushi": "https://sushi.com",
  "balancer": "https://balancer.fi",
  "curve": "https://curve.fi",
  "velodrome": "https://velodrome.finance",
  "aerodrome": "https://aerodrome.finance",
  "camelot": "https://camelot.exchange",
  "trader joe": "https://traderjoexyz.com",
  "traderjoe": "https://traderjoexyz.com",
  "pancakeswap": "https://pancakeswap.finance",
  "shibaswap": "https://shibaswap.com",
  "kyberswap": "https://kyberswap.com",
  "kyber": "https://kyberswap.com",
  "bancor": "https://bancor.network",
  "maverick": "https://mav.xyz",
  "syncswap": "https://syncswap.xyz",
  "quickswap": "https://quickswap.exchange",
  "baseswap": "https://baseswap.fi",
  "ramses": "https://ramses.exchange",
  "thena": "https://thena.fi",
  "solidly": "https://solidly.exchange",
  "chronos": "https://chronos.exchange",
  "fraxswap": "https://frax.finance",
  // Lending & Borrowing (from Enso docs)
  "aave": "https://aave.com",
  "compound": "https://compound.finance",
  "euler": "https://euler.finance",
  "morpho": "https://morpho.org",
  "spark": "https://spark.fi",
  "radiant": "https://radiant.capital",
  "zerolend": "https://zerolend.xyz",
  "venus": "https://venus.io",
  "fluid": "https://fluid.instadapp.io",
  "dolomite": "https://dolomite.io",
  "silo": "https://silo.finance",
  "exactly": "https://exactly.finance",
  "gearbox": "https://gearbox.fi",
  "iron bank": "https://ib.xyz",
  "ironbank": "https://ib.xyz",
  "benqi": "https://benqi.fi",
  "moonwell": "https://moonwell.fi",
  // Yield & Vaults (from Enso docs)
  "yearn": "https://yearn.fi",
  "beefy": "https://beefy.com",
  "convex": "https://convexfinance.com",
  "tokemak": "https://tokemak.xyz",
  "pendle": "https://pendle.finance",
  "sommelier": "https://sommelier.finance",
  "steer": "https://steer.finance",
  "mellow": "https://mellow.finance",
  "idle": "https://idle.finance",
  "harvest": "https://harvest.finance",
  "inverse": "https://inverse.finance",
  "aura": "https://aura.finance",
  // Liquid Staking (from Enso docs)
  "lido": "https://lido.fi",
  "rocket pool": "https://rocketpool.net",
  "rocketpool": "https://rocketpool.net",
  "stakestone": "https://stakestone.io",
  "bedrock": "https://bedrock.technology",
  "etherfi": "https://ether.fi",
  "ether.fi": "https://ether.fi",
  "swell": "https://swellnetwork.io",
  "renzo": "https://renzoprotocol.com",
  "kelp": "https://kelpdao.xyz",
  "kiln": "https://kiln.fi",
  "mantle": "https://mantle.xyz",
  "origin": "https://originprotocol.com",
  "symbiotic": "https://symbiotic.fi",
  "stakewise": "https://stakewise.io",
  "stader": "https://staderlabs.com",
  "eigenlayer": "https://eigenlayer.xyz",
  // Stablecoins & Derivatives (from Enso docs)
  "frax": "https://frax.finance",
  "ethena": "https://ethena.fi",
  "angle": "https://angle.money",
  "mstable": "https://mstable.org",
  "sky": "https://sky.money",
  "prisma": "https://prismafinance.com",
  "maker": "https://makerdao.com",
  // Other (from Enso docs)
  "gmx": "https://gmx.io",
  "gains": "https://gains.trade",
  "synthetix": "https://synthetix.io",
  "vertex": "https://vertexprotocol.com",
  "pooltogether": "https://pooltogether.com",
  // Bridges
  "stargate": "https://stargate.finance",
  "layerzero": "https://layerzero.network",
  "across": "https://across.to",
  "hop": "https://hop.exchange",
  // Other
  "pirex": "https://pirex.io",
  "weth": "https://weth.io",
};

// Protocol display names - proper casing for known protocols (from Enso docs)
const PROTOCOL_DISPLAY_NAMES: Record<string, string> = {
  // DEX Aggregators
  "enso": "Enso",
  "odos": "Odos",
  "1inch": "1inch",
  "0x": "0x",
  "openocean": "OpenOcean",
  "paraswap": "ParaSwap",
  "cowswap": "CoW Swap",
  "cow swap": "CoW Swap",
  "matcha": "Matcha",
  "bebop": "Bebop",
  "hashflow": "Hashflow",
  "dodo": "DODO",
  "woofi": "WOOFi",
  "fly": "Fly",
  "barter": "Barter",
  // DEXs
  "uniswap": "Uniswap",
  "uniswap_v2": "Uniswap V2",
  "uniswap_v3": "Uniswap V3",
  "sushiswap": "SushiSwap",
  "sushi": "Sushi",
  "balancer": "Balancer",
  "curve": "Curve",
  "velodrome": "Velodrome",
  "aerodrome": "Aerodrome",
  "camelot": "Camelot",
  "trader joe": "Trader Joe",
  "traderjoe": "Trader Joe",
  "pancakeswap": "PancakeSwap",
  "shibaswap": "ShibaSwap",
  "kyberswap": "KyberSwap",
  "kyber": "Kyber",
  "bancor": "Bancor",
  "maverick": "Maverick",
  "syncswap": "SyncSwap",
  "quickswap": "QuickSwap",
  "baseswap": "BaseSwap",
  "ramses": "Ramses",
  "thena": "Thena",
  "solidly": "Solidly",
  "chronos": "Chronos",
  "fraxswap": "Fraxswap",
  // Lending & Borrowing
  "aave": "Aave",
  "compound": "Compound",
  "euler": "Euler",
  "morpho": "Morpho",
  "spark": "Spark",
  "radiant": "Radiant",
  "zerolend": "ZeroLend",
  "venus": "Venus",
  "fluid": "Fluid",
  "dolomite": "Dolomite",
  "silo": "Silo",
  "exactly": "Exactly",
  "gearbox": "Gearbox",
  "iron bank": "Iron Bank",
  "ironbank": "Iron Bank",
  "benqi": "BENQI",
  "moonwell": "Moonwell",
  // Yield & Vaults
  "yearn": "Yearn",
  "beefy": "Beefy",
  "convex": "Convex",
  "tokemak": "Tokemak",
  "pendle": "Pendle",
  "sommelier": "Sommelier",
  "steer": "Steer",
  "mellow": "Mellow",
  "idle": "Idle",
  "harvest": "Harvest",
  "inverse": "Inverse",
  "aura": "Aura",
  // Liquid Staking
  "lido": "Lido",
  "rocket pool": "Rocket Pool",
  "rocketpool": "Rocket Pool",
  "stakestone": "StakeStone",
  "bedrock": "Bedrock",
  "etherfi": "Ether.fi",
  "ether.fi": "Ether.fi",
  "swell": "Swell",
  "renzo": "Renzo",
  "kelp": "Kelp",
  "kiln": "Kiln",
  "mantle": "Mantle",
  "origin": "Origin",
  "symbiotic": "Symbiotic",
  "stakewise": "StakeWise",
  "stader": "Stader",
  "eigenlayer": "EigenLayer",
  // Stablecoins & Derivatives
  "frax": "Frax",
  "ethena": "Ethena",
  "angle": "Angle",
  "mstable": "mStable",
  "sky": "Sky",
  "prisma": "Prisma",
  "maker": "Maker",
  // Other
  "gmx": "GMX",
  "gains": "Gains",
  "synthetix": "Synthetix",
  "vertex": "Vertex",
  "pooltogether": "PoolTogether",
  // Bridges
  "stargate": "Stargate",
  "layerzero": "LayerZero",
  "across": "Across",
  "hop": "Hop",
  // Other
  "pirex": "Pirex",
  "weth": "WETH",
  "yld_fi": "yld_fi",
};

// Get display name for a protocol (proper casing)
function getProtocolDisplayName(protocol: string): string {
  const normalized = protocol.toLowerCase();
  // Direct match
  if (PROTOCOL_DISPLAY_NAMES[normalized]) return PROTOCOL_DISPLAY_NAMES[normalized];
  // Partial match (e.g., "uniswap_v3" → "Uniswap V3")
  for (const [key, name] of Object.entries(PROTOCOL_DISPLAY_NAMES)) {
    if (normalized.includes(key)) {
      return name;
    }
  }
  // Fallback: capitalize first letter
  return protocol.charAt(0).toUpperCase() + protocol.slice(1);
}

// Get protocol link (case-insensitive lookup)
function getProtocolLink(protocol: string): string | undefined {
  const normalized = protocol.toLowerCase();
  // Direct match
  if (PROTOCOL_LINKS[normalized]) return PROTOCOL_LINKS[normalized];
  // Partial match (e.g., "uniswap_v3" → "uniswap")
  for (const [key, url] of Object.entries(PROTOCOL_LINKS)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return url;
    }
  }
  return undefined;
}

/**
 * Token icon component with fallback
 */
function TokenIcon({ symbol, size = 20 }: { symbol: string; size?: number }) {
  const [error, setError] = useState(false);
  const logoUrl = getTokenLogo(symbol);

  if (error || !logoUrl) {
    return (
      <div
        className="rounded-full flex items-center justify-center text-[10px] font-medium bg-[var(--muted)] text-[var(--muted-foreground)]"
        style={{ width: size, height: size }}
      >
        {symbol.slice(0, 2).toUpperCase()}
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={logoUrl}
      alt={symbol}
      width={size}
      height={size}
      className="rounded-full"
      onError={() => setError(true)}
    />
  );
}

/**
 * Token display component (icon + name + optional amount)
 */
function TokenDisplay({ symbol, amount }: { symbol: string; amount?: string }) {
  return (
    <div className="flex items-center gap-2">
      <TokenIcon symbol={symbol} size={18} />
      {amount && <span className="text-sm mono tabular-nums">{amount}</span>}
      <span className="text-sm font-medium">{symbol}</span>
    </div>
  );
}

/**
 * Route step row component - compact timeline style with stacked layout
 */
function RouteStepRow({ step, isLast }: { step: RouteStep; isLast: boolean }) {
  const protocolClass = PROTOCOL_STYLES[step.protocol] || "text-[var(--muted-foreground)]";
  const protocolLink = step.protocol ? getProtocolLink(step.protocol) : undefined;

  return (
    <div className="flex gap-2.5">
      {/* Left side: dot */}
      <div className="relative w-2 flex-shrink-0">
        <div className="w-1.5 h-1.5 rounded-full bg-[var(--muted-foreground)]/60 mt-[7px]" />
        {!isLast && (
          <div className="absolute left-[2.5px] top-[12px] bottom-[-8px] w-px bg-[var(--muted-foreground)]/30" />
        )}
      </div>

      {/* Right side: content - stacked layout */}
      <div className={isLast ? "" : "pb-3"}>
        {/* Token symbol and amount */}
        <TokenDisplay symbol={step.tokenSymbol} amount={step.amount} />
        {/* Action and protocol on second line */}
        {(step.action || step.protocol) && (
          <div className="text-xs text-[var(--muted-foreground)] mt-0.5">
            {step.action && <span className="opacity-70">{step.action}</span>}
            {step.description && (
              <span className="opacity-70"> {step.description}</span>
            )}
            {step.protocol && (
              <>
                {/* For yld_fi deposits with description, just add "vault" - description already has target */}
                {step.action?.toLowerCase() === "deposit" && step.protocol?.toLowerCase() === "yld_fi" && step.description ? (
                  <span className="opacity-70"> vault</span>
                ) : (
                  <>
                    <span className="opacity-70">
                      {" "}{step.action?.toLowerCase() === "deposit" ? "into" : "via"}{" "}
                    </span>
                    {step.action?.toLowerCase() === "deposit" && step.protocol?.toLowerCase() === "yld_fi" ? (
                      <><span className="font-medium">yld_fi</span> vault</>
                    ) : protocolLink ? (
                      <a
                        href={protocolLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium hover:text-[var(--accent)] transition-colors inline-flex items-center gap-0.5"
                      >
                        {getProtocolDisplayName(step.protocol)}
                        <ExternalLink size={10} className="opacity-50" />
                      </a>
                    ) : (
                      <span className={`font-medium ${protocolClass}`}>
                        {getProtocolDisplayName(step.protocol)}
                      </span>
                    )}
                  </>
                )}
              </>
            )}
            {step.bonusAmount && step.bonusSymbol && step.bonus !== undefined && step.bonus !== 0 && (
              <span
                className={`ml-1 ${step.bonus > 0 ? "text-green-500" : "text-red-500"}`}
                title={step.bonus > 0
                  ? "Swap bonus: You receive more tokens than 1:1 minting because the Curve pool is above peg"
                  : "Swap penalty: You receive fewer tokens than 1:1 minting. Consider waiting for better rates."
                }
              >
                {step.bonus > 0 ? "+" : ""}{step.bonusAmount} {step.bonusSymbol} vs mint
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Loading skeleton for route display
 */
function LoadingSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="flex items-center gap-3">
        <div className="h-8 w-24 bg-[var(--muted)] rounded-lg" />
        <div className="h-3 w-32 bg-[var(--muted)] rounded" />
      </div>
      <div className="flex justify-center py-1">
        <div className="h-4 w-4 bg-[var(--muted)] rounded" />
      </div>
      <div className="flex items-center gap-3">
        <div className="h-8 w-24 bg-[var(--muted)] rounded-lg" />
        <div className="h-3 w-32 bg-[var(--muted)] rounded" />
      </div>
    </div>
  );
}

/**
 * Fallback display when no route info is available
 */
function DirectRoute({ inputSymbol, outputSymbol, inputAmount, outputAmount }: { inputSymbol?: string; outputSymbol?: string; inputAmount?: string; outputAmount?: string }) {
  if (!inputSymbol || !outputSymbol) {
    return <span className="mono text-sm text-[var(--muted-foreground)]">Direct route</span>;
  }

  return (
    <div>
      {/* Input */}
      <div className="flex gap-2.5">
        <div className="relative w-2 flex-shrink-0">
          <div className="w-1.5 h-1.5 rounded-full bg-[var(--muted-foreground)]/60 mt-[7px]" />
          <div className="absolute left-[2.5px] top-[12px] bottom-[-8px] w-px bg-[var(--muted-foreground)]/30" />
        </div>
        <div className="pb-3">
          <TokenDisplay symbol={inputSymbol} amount={inputAmount} />
          <div className="text-xs text-[var(--muted-foreground)] mt-0.5 opacity-70">Direct swap</div>
        </div>
      </div>
      {/* Output */}
      <div className="flex gap-2.5">
        <div className="relative w-2 flex-shrink-0">
          <div className="w-1.5 h-1.5 rounded-full bg-[var(--muted-foreground)]/60 mt-[7px]" />
        </div>
        <div>
          <TokenDisplay symbol={outputSymbol} amount={outputAmount} />
        </div>
      </div>
    </div>
  );
}

/**
 * Legacy format display (for backward compatibility with tokens/protocols arrays)
 */
function LegacyRouteDisplay({ routeInfo }: { routeInfo: RouteInfo }) {
  const tokens = routeInfo.tokens || [];
  const protocols = routeInfo.protocols || [];

  return (
    <div>
      {tokens.map((token, index) => {
        const protocol = index < protocols.length ? protocols[index] : undefined;
        const protocolLink = protocol ? getProtocolLink(protocol) : undefined;
        const protocolClass = protocol ? (PROTOCOL_STYLES[protocol] || "text-[var(--muted-foreground)]") : "";
        const isLast = index === tokens.length - 1;

        return (
          <div key={index} className="flex gap-2.5">
            <div className="relative w-2 flex-shrink-0">
              <div className="w-1.5 h-1.5 rounded-full bg-[var(--muted-foreground)]/60 mt-[7px]" />
              {!isLast && (
                <div className="absolute left-[2.5px] top-[12px] bottom-[-8px] w-px bg-[var(--muted-foreground)]/30" />
              )}
            </div>
            <div className={isLast ? "" : "pb-3"}>
              <TokenDisplay symbol={token} />
              {protocol && (
                <div className="text-xs text-[var(--muted-foreground)] mt-0.5">
                  <span className="opacity-70">via </span>
                  {protocolLink ? (
                    <a
                      href={protocolLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium hover:text-[var(--accent)] transition-colors inline-flex items-center gap-0.5"
                    >
                      {getProtocolDisplayName(protocol)}
                      <ExternalLink size={10} className="opacity-50" />
                    </a>
                  ) : (
                    <span className={`font-medium ${protocolClass}`}>
                      {getProtocolDisplayName(protocol)}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function RouteDisplay({ routeInfo, inputSymbol, outputSymbol, inputAmount, outputAmount, isLoading }: RouteDisplayProps) {
  // Only show skeleton if loading AND no existing data to display
  if (isLoading && !routeInfo) {
    return <LoadingSkeleton />;
  }

  if (!routeInfo) {
    return <DirectRoute inputSymbol={inputSymbol} outputSymbol={outputSymbol} inputAmount={inputAmount} outputAmount={outputAmount} />;
  }

  // Use new steps format if available
  if (routeInfo.steps && routeInfo.steps.length > 0) {
    // Add amounts to first and last steps
    const stepsWithAmounts = routeInfo.steps.map((step, index) => {
      if (index === 0 && inputAmount) {
        return { ...step, amount: inputAmount };
      }
      if (index === routeInfo.steps.length - 1 && outputAmount) {
        return { ...step, amount: outputAmount };
      }
      return step;
    });

    return (
      <div className={`space-y-0 transition-opacity ${isLoading ? "opacity-50" : ""}`}>
        {stepsWithAmounts.map((step, index) => (
          <RouteStepRow
            key={index}
            step={step}
            isLast={index === stepsWithAmounts.length - 1}
          />
        ))}
      </div>
    );
  }

  // Fallback to legacy format (tokens/protocols arrays)
  if (routeInfo.tokens && routeInfo.tokens.length > 0) {
    return (
      <div className={`transition-opacity ${isLoading ? "opacity-50" : ""}`}>
        <LegacyRouteDisplay routeInfo={routeInfo} />
      </div>
    );
  }

  // No route info available
  return <DirectRoute inputSymbol={inputSymbol} outputSymbol={outputSymbol} inputAmount={inputAmount} outputAmount={outputAmount} />;
}
