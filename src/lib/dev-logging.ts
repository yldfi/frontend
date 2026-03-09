/**
 * Dev-only logging utilities for transaction debugging.
 * Snapshots user position state + token balances before/after transactions.
 * All functions are no-ops in production builds.
 */
import { formatUnits } from "viem";
import { DEFISAVER_CURVE_VIEW, CURVE_VIEW_ABI } from "@/lib/zapper";
import { CRVUSD_ADDRESS } from "@/config/addresses";

// Minimal ABI for balance/symbol/decimals reads
const BALANCE_ABI = [{
  name: "balanceOf", type: "function", stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
}, {
  name: "symbol", type: "function", stateMutability: "view",
  inputs: [], outputs: [{ name: "", type: "string" }],
}, {
  name: "decimals", type: "function", stateMutability: "view",
  inputs: [], outputs: [{ name: "", type: "uint8" }],
}] as const;

interface PositionSnapshot {
  collateral: bigint;
  stablecoin: bigint;
  debt: bigint;
  N: number;
  health: number; // percentage
  priceHigh: bigint;
  priceLow: bigint;
  hasLoan: boolean;
}

interface BalanceEntry {
  balance: bigint;
  symbol: string;
  decimals: number;
}

export interface TxSnapshot {
  position: PositionSnapshot | null;
  balances: Map<string, BalanceEntry>;
  timestamp: number;
}

type PublicClient = {
  readContract: (args: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) => Promise<unknown>;
  getBalance: (args: { address: `0x${string}` }) => Promise<bigint>;
};

/**
 * Snapshot the user's lending position + relevant token balances.
 * Returns null silently on errors (best-effort, never blocks tx flow).
 */
export async function snapshotTx(
  publicClient: PublicClient,
  userAddress: `0x${string}`,
  controllerAddress: `0x${string}` | null,
  extraTokens: string[] = [],
): Promise<TxSnapshot> {
  if (process.env.NODE_ENV !== "development") {
    return { position: null, balances: new Map(), timestamp: Date.now() };
  }

  const timestamp = Date.now();

  // Snapshot position (if controller provided)
  let position: PositionSnapshot | null = null;
  if (controllerAddress) {
    try {
      const userData = await publicClient.readContract({
        address: DEFISAVER_CURVE_VIEW,
        abi: CURVE_VIEW_ABI,
        functionName: "userData",
        args: [controllerAddress, userAddress],
      }) as {
        loanExists: boolean;
        marketCollateralAmount: bigint;
        curveUsdCollateralAmount: bigint;
        debtAmount: bigint;
        N: bigint;
        health: bigint;
        priceHigh: bigint;
        priceLow: bigint;
      };

      position = {
        collateral: userData.marketCollateralAmount,
        stablecoin: userData.curveUsdCollateralAmount,
        debt: userData.debtAmount,
        N: Number(userData.N),
        health: Number(userData.health) / 1e16,
        priceHigh: userData.priceHigh,
        priceLow: userData.priceLow,
        hasLoan: userData.loanExists,
      };
    } catch {
      // Position read failed — user may not have a loan
    }
  }

  // Snapshot balances
  const balances = new Map<string, BalanceEntry>();
  const tokens = new Set(["native", CRVUSD_ADDRESS.toLowerCase()]);
  for (const t of extraTokens) {
    if (t && t !== "0x0000000000000000000000000000000000000000") {
      tokens.add(t.toLowerCase());
    }
  }

  try {
    const entries = [...tokens];
    const results = await Promise.all(
      entries.map(async (t): Promise<BalanceEntry> => {
        if (t === "native") {
          const bal = await publicClient.getBalance({ address: userAddress });
          return { balance: bal, symbol: "ETH", decimals: 18 };
        }
        const [bal, symbol, decimals] = await Promise.all([
          publicClient.readContract({ address: t as `0x${string}`, abi: BALANCE_ABI, functionName: "balanceOf", args: [userAddress] }) as Promise<bigint>,
          publicClient.readContract({ address: t as `0x${string}`, abi: BALANCE_ABI, functionName: "symbol" }).catch(() => t.slice(0, 10)) as Promise<string>,
          publicClient.readContract({ address: t as `0x${string}`, abi: BALANCE_ABI, functionName: "decimals" }).catch(() => 18) as Promise<number>,
        ]);
        return { balance: bal, symbol, decimals: Number(decimals) };
      })
    );
    for (let i = 0; i < entries.length; i++) {
      balances.set(entries[i], results[i]);
    }
  } catch { /* best effort */ }

  return { position, balances, timestamp };
}

/**
 * Log before/after snapshots as a formatted diff table.
 */
export function logTxDiff(label: string, before: TxSnapshot, after: TxSnapshot): void {
  if (process.env.NODE_ENV !== "development") return;

  const lines: string[] = [];
  const elapsed = after.timestamp - before.timestamp;

  // Position diff
  if (before.position || after.position) {
    const b = before.position;
    const a = after.position;
    lines.push("  Position:");

    if (b && a) {
      const fmt18 = (v: bigint) => formatUnits(v, 18);
      const diff = (bv: bigint, av: bigint) => {
        const d = av - bv;
        return d === 0n ? "" : ` (${d > 0n ? "+" : ""}${fmt18(d)})`;
      };
      lines.push(`    Collateral: ${fmt18(b.collateral)} → ${fmt18(a.collateral)}${diff(b.collateral, a.collateral)}`);
      if (b.stablecoin > 0n || a.stablecoin > 0n) {
        lines.push(`    Stablecoin: ${fmt18(b.stablecoin)} → ${fmt18(a.stablecoin)}${diff(b.stablecoin, a.stablecoin)}`);
      }
      lines.push(`    Debt:       ${fmt18(b.debt)} → ${fmt18(a.debt)}${diff(b.debt, a.debt)}`);
      lines.push(`    Health:     ${b.health.toFixed(2)}% → ${a.health.toFixed(2)}%`);
      lines.push(`    Bands:      ${b.N}`);
    } else if (!b && a?.hasLoan) {
      lines.push(`    New loan: collateral=${formatUnits(a.collateral, 18)} debt=${formatUnits(a.debt, 18)} health=${a.health.toFixed(2)}% N=${a.N}`);
    } else if (b?.hasLoan && !a?.hasLoan) {
      lines.push(`    Loan closed (was: collateral=${formatUnits(b.collateral, 18)} debt=${formatUnits(b.debt, 18)})`);
    }
  }

  // Balance diff
  if (before.balances.size > 0) {
    lines.push("  Balances:");
    for (const [token, bEntry] of before.balances) {
      const aEntry = after.balances.get(token);
      if (!aEntry) continue;
      const d = aEntry.balance - bEntry.balance;
      const dec = bEntry.decimals;
      const sym = bEntry.symbol;
      const sign = d > 0n ? "+" : "";
      lines.push(`    ${sym}: ${formatUnits(bEntry.balance, dec)} → ${formatUnits(aEntry.balance, dec)} (${sign}${formatUnits(d, dec)})`);
    }
  }

  console.log(`[${label}] (${elapsed}ms)\n${lines.join("\n")}`);
}
