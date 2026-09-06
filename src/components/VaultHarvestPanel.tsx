"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useAccount, useReadContract, useReadContracts, useWaitForTransactionReceipt } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { formatUnits, hexToString } from "viem";
import { AlertTriangle, CircleDot, ExternalLink, Gavel, Gift, Loader2, Zap } from "lucide-react";
import { toast } from "sonner";

import { useDirectWriteContract } from "@/hooks/useDirectWriteContract";
import { useTokenMetadata } from "@/hooks/useTokenMetadata";
import { useVaultCache } from "@/hooks/useVaultCache";
import {
  CVGCVX_STAKING,
  CVXCRV_WRAPPER,
  PERMISSIONLESS_KEEPER,
  getHarvestConfig,
  type HarvestConfig,
} from "@/config/harvest";
import { TOKENS } from "@/config/vaults";

const REPORT_TRIGGER_ABI = [{
  name: "strategyReportTrigger", type: "function", stateMutability: "view",
  inputs: [{ name: "strategy", type: "address" }],
  outputs: [{ name: "shouldReport", type: "bool" }, { name: "data", type: "bytes" }],
}] as const;
const CUSTOM_REPORT_TRIGGER_ABI = [{
  name: "reportTrigger", type: "function", stateMutability: "view",
  inputs: [{ name: "strategy", type: "address" }],
  outputs: [{ name: "shouldReport", type: "bool" }, { name: "data", type: "bytes" }],
}] as const;

const subscribeToAuctionPreview = () => () => {};
const getAuctionPreviewSnapshot = () =>
  process.env.NODE_ENV === "development" &&
  new URLSearchParams(window.location.search).get("auction-preview");
const getAuctionPreviewServerSnapshot = () => null;

const KEEPER_ABI = [{
  name: "report", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "strategy", type: "address" }], outputs: [{ name: "profit", type: "uint256" }, { name: "loss", type: "uint256" }],
}] as const;
const STRATEGY_ABI = [
  { name: "pendingRewards", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "kickable", type: "function", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "kickAuction", type: "function", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "getRewardTokensWithBalances", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }, { type: "uint256[]" }] },
  { name: "getKickableTokens", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }, { type: "uint256[]" }] },
  { name: "lastReport", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "profitMaxUnlockTime", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "auction", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "minAmountToSell", type: "function", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "tokenMinAmountToSell", type: "function", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const AUCTION_ABI = [
  { name: "isActive", type: "function", stateMutability: "view", inputs: [{ name: "from", type: "address" }], outputs: [{ type: "bool" }] },
  { name: "available", type: "function", stateMutability: "view", inputs: [{ name: "from", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "kicked", type: "function", stateMutability: "view", inputs: [{ name: "from", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "auctionLength", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "startingPrice", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "stepDuration", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "stepDecayRate", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    name: "auctions", type: "function", stateMutability: "view", inputs: [{ name: "from", type: "address" }],
    outputs: [{ name: "kicked", type: "uint64" }, { name: "scaler", type: "uint64" }, { name: "initialAvailable", type: "uint128" }],
  },
  { name: "getAmountNeeded", type: "function", stateMutability: "view", inputs: [{ name: "from", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "take", type: "function", stateMutability: "nonpayable", inputs: [{ name: "from", type: "address" }, { name: "maxAmount", type: "uint256" }, { name: "receiver", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;
const WRAPPER_ABI = [{
  name: "earned", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }],
  outputs: [{ type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] }],
}] as const;
const CVG_STAKING_ABI = [{
  name: "getAllClaimableAmounts", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "cvgAmount", type: "uint256" }, { name: "rewards", type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] }],
}] as const;

type TokenAmount = { token: `0x${string}`; amount: bigint };
type AuctionState = {
  active: boolean;
  available: bigint;
  startsAt: number | undefined;
  endsAt: number | undefined;
  likelySettlesAt: number | undefined;
  auctionRate: number | undefined;
  marketRate: number | undefined;
  takeAmount: bigint;
  takePayment: bigint;
  requiredPayment: bigint;
  paymentBalance: bigint;
  paymentAllowance: bigint;
};
const CVG_TOKEN = "0x97efFB790f2fbB701D88f89DB4521348A2B77be8" as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number; logo?: string }> = {
  [TOKENS.CVXCRV.toLowerCase()]: { symbol: "cvxCRV", decimals: 18, logo: "/tokens/cvxcrv.png" },
  [TOKENS.CVX.toLowerCase()]: { symbol: "CVX", decimals: 18, logo: "/tokens/cvx.png" },
  [TOKENS.CVGCVX.toLowerCase()]: { symbol: "cvgCVX", decimals: 18, logo: "/tokens/cvgcvx.png" },
  [CVG_TOKEN.toLowerCase()]: { symbol: "CVG", decimals: 18 },
  [TOKENS.PXCVX.toLowerCase()]: { symbol: "pxCVX", decimals: 18, logo: "/tokens/pxcvx.png" },
  ["0xf939e0a03fb07f59a73314e73794be0e57ac1b4e"]: { symbol: "crvUSD", decimals: 18, logo: "/tokens/crvusd.png" },
  ["0xd533a949740bb3306d119cc777fa900ba034cd52"]: { symbol: "CRV", decimals: 18 },
  ["0x6c3f90f043a72fa612cbac8115ee7e52bde6e490"]: { symbol: "3CRV", decimals: 18 },
};

function formatLocalDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zoneName = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "long" })
    .formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? timeZone;
  const abbreviation = zoneName.split(/\s+/).map((word) => word[0]).join("").toUpperCase();
  const formatted = date.toLocaleString(undefined, {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  return `${formatted} ${abbreviation}`;
}

function relativeTime(timestamp: number, nowTimestamp: number): string {
  const seconds = Math.max(0, timestamp - nowTimestamp);
  if (seconds === 0) return "now";
  if (seconds >= 3_600) return `in about ${Math.ceil(seconds / 3_600)} hours`;
  return `in about ${Math.max(1, Math.ceil(seconds / 60))} minutes`;
}

function compactRelativeTime(timestamp: number, nowTimestamp: number): string {
  const seconds = Math.max(0, timestamp - nowTimestamp);
  if (seconds === 0) return "now";
  if (seconds >= 3_600) return `in ~${Math.ceil(seconds / 3_600)} hrs`;
  return `in ~${Math.max(1, Math.ceil(seconds / 60))} mins`;
}

function formatRate(rate: number): string {
  return rate.toLocaleString("en-US", { maximumSignificantDigits: 6 });
}

function formatDuration(seconds: number): string {
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
  return `${Math.max(0, Math.floor(seconds / 60))}m`;
}

function AuctionTimeline({
  startsAt,
  endsAt,
  marketAt,
  now,
  fromSymbol,
  toSymbol,
}: {
  startsAt: number;
  endsAt: number;
  marketAt?: number;
  now: number;
  fromSymbol: string;
  toSymbol: string;
}) {
  const duration = Math.max(1, endsAt - startsAt);
  const elapsed = Math.min(duration, Math.max(0, now - startsAt));
  const progress = (elapsed / duration) * 100;
  const marketProgress = marketAt === undefined
    ? undefined
    : Math.min(100, Math.max(0, ((marketAt - startsAt) / duration) * 100));
  const hasReachedMarket = marketAt !== undefined && marketAt <= now;
  const markerAlignment = marketProgress !== undefined && marketProgress < 20
    ? "translate-x-0 text-left"
    : marketProgress !== undefined && marketProgress > 80
      ? "-translate-x-full text-right"
      : "-translate-x-1/2 text-center";

  return (
    <div className="space-y-2" aria-label="Auction timeline">
      <div className="flex items-start justify-between gap-3 text-xs">
        <span className={hasReachedMarket ? "font-medium text-[var(--success)]" : "text-[var(--muted-foreground)]"}>
          {hasReachedMarket
            ? `Auction is at the current ${fromSymbol}/${toSymbol} market price`
            : marketAt
              ? `Auction will reach the current ${fromSymbol}/${toSymbol} market price ${compactRelativeTime(marketAt, now)}`
              : "Market price estimate unavailable"}
        </span>
        <span className="shrink-0 tabular-nums text-[var(--muted-foreground)]">{formatDuration(elapsed)} / {formatDuration(duration)}</span>
      </div>
      <div className="relative pb-7">
        <div className="relative h-2.5 overflow-hidden rounded-full bg-[var(--muted)]">
          <div
            className={`h-full rounded-full transition-[width] duration-500 ${hasReachedMarket ? "bg-[var(--success)]" : "bg-[var(--foreground)]"}`}
            style={{ width: `${progress}%` }}
          />
          {marketProgress !== undefined && (
            <div className="absolute inset-y-0 z-10 w-0.5 bg-[var(--success)]" style={{ left: `${marketProgress}%` }} />
          )}
        </div>
        <span className="absolute left-0 top-3.5 text-[10px] text-[var(--muted-foreground)]">Start</span>
        {marketProgress !== undefined && (
          <span className={`absolute top-3.5 whitespace-nowrap text-[10px] font-medium text-[var(--success)] ${markerAlignment}`} style={{ left: `${marketProgress}%` }}>
            Market price · {formatLocalDate(marketAt!).replace(/^.*?,\s*/, "")}
          </span>
        )}
        <span className="absolute right-0 top-3.5 text-[10px] text-[var(--muted-foreground)]">Close</span>
      </div>
    </div>
  );
}

export function estimateLikelySettlementAt({
  kicked,
  initialAvailable,
  startingPrice,
  stepDuration,
  stepDecayRate,
  fromDecimals,
  toDecimals,
  fromPriceUsd,
  toPriceUsd,
  endsAt,
}: {
  kicked: bigint;
  initialAvailable: bigint;
  startingPrice: bigint;
  stepDuration: bigint;
  stepDecayRate: bigint;
  fromDecimals: number;
  toDecimals: number;
  fromPriceUsd: number;
  toPriceUsd: number;
  endsAt?: number;
}): number | undefined {
  if (
    kicked <= 0n || initialAvailable <= 0n || startingPrice <= 0n || stepDuration <= 0n ||
    stepDecayRate <= 0n || stepDecayRate >= 10_000n || fromPriceUsd <= 0 || toPriceUsd <= 0
  ) return undefined;

  const initialUnitPrice = Number(formatUnits(startingPrice, toDecimals)) /
    Number(formatUnits(initialAvailable, fromDecimals));
  // Match Zaplet's conservative market-crossing estimate by allowing 45 bps
  // for swap slippage and execution costs.
  const targetUnitPrice = (fromPriceUsd / toPriceUsd) / 1.0045;
  if (!Number.isFinite(initialUnitPrice) || initialUnitPrice <= 0 || targetUnitPrice <= 0) return undefined;

  const decayPerStep = 1 - Number(stepDecayRate) / 10_000;
  const steps = initialUnitPrice <= targetUnitPrice
    ? 0
    : Math.ceil(Math.log(targetUnitPrice / initialUnitPrice) / Math.log(decayPerStep));
  const settlementAt = Number(kicked) + steps * Number(stepDuration);
  return endsAt !== undefined && settlementAt > endsAt ? undefined : settlementAt;
}

function rewardRead(config: HarvestConfig) {
  if (config.kind === "yscvx") return { address: config.strategy, abi: STRATEGY_ABI, functionName: "pendingRewards" } as const;
  if (config.kind === "yscvxcrv") return { address: CVXCRV_WRAPPER, abi: WRAPPER_ABI, functionName: "earned", args: [config.strategy] } as const;
  if (config.kind === "yscvgcvx") return { address: CVGCVX_STAKING, abi: CVG_STAKING_ABI, functionName: "getAllClaimableAmounts", args: [config.strategy] } as const;
  return { address: config.strategy, abi: STRATEGY_ABI, functionName: "getRewardTokensWithBalances" } as const;
}

function reportTriggerRead(config: HarvestConfig) {
  return config.trigger.functionName === "reportTrigger"
    ? { address: config.trigger.address, abi: CUSTOM_REPORT_TRIGGER_ABI, functionName: "reportTrigger", args: [config.strategy] } as const
    : { address: config.trigger.address, abi: REPORT_TRIGGER_ABI, functionName: "strategyReportTrigger", args: [config.strategy] } as const;
}

function parseRewards(config: HarvestConfig, value: unknown): TokenAmount[] {
  if (config.kind === "yscvx") return [{ token: TOKENS.CVXCRV, amount: (value as bigint | undefined) ?? 0n }];
  if (config.kind === "yscvxcrv") return ((value as readonly { token: `0x${string}`; amount: bigint }[] | undefined) ?? []).filter((item) => item.amount > 0n);
  if (config.kind === "yscvgcvx") {
    const [cvgAmount = 0n, rewards = []] = (value as readonly [bigint, readonly { token: `0x${string}`; amount: bigint }[]] | undefined) ?? [];
    return [...(cvgAmount > 0n ? [{ token: CVG_TOKEN, amount: cvgAmount }] : []), ...rewards.filter((item) => item.amount > 0n)];
  }
  const [tokens = [], amounts = []] = (value as readonly [readonly `0x${string}`[], readonly bigint[]] | undefined) ?? [];
  return tokens.map((token, index) => ({ token, amount: amounts[index] ?? 0n })).filter((item) => item.amount > 0n);
}

function triggerMessage(
  trigger: readonly [boolean, `0x${string}`] | undefined,
  status: "pending" | "error" | "success",
  nextReportAt?: number,
  thresholdProgress?: string,
): string {
  if (status === "pending") return "Checking when the strategy can harvest these rewards…";
  if (status === "error" || !trigger) return "We could not check when the strategy can harvest. Try again shortly.";
  if (trigger[0]) return "The strategy rewards are ready to be harvested for the vault.";
  if (trigger[1].toLowerCase() === "0x2606a10b") {
    if (!nextReportAt) return "The strategy needs to wait a little longer before it can harvest.";
    const remainingSeconds = Math.max(0, nextReportAt - Math.floor(Date.now() / 1000));
    const relative = remainingSeconds >= 86_400
      ? `in ${Math.ceil(remainingSeconds / 86_400)} days`
      : remainingSeconds >= 3_600
        ? `in about ${Math.ceil(remainingSeconds / 3_600)} hours`
        : `in about ${Math.max(1, Math.ceil(remainingSeconds / 60))} minutes`;
    return `The strategy can harvest these rewards around ${formatLocalDate(nextReportAt)} (${relative}).`;
  }
  try {
    const reason = hexToString(trigger[1], { size: undefined }).replaceAll("\0", "").trim();
    const normalized = reason.toLowerCase();
    if (normalized.includes("not enough pending") || normalized.includes("not enough rewards")) {
      if (thresholdProgress) return `${thresholdProgress} accumulated by the strategy. It needs more before it can harvest.`;
      return "The strategy needs to accumulate more rewards before it can harvest.";
    }
    if (normalized.includes("base fee")) {
      return "Network fees are currently too high. Try again later.";
    }
    if (normalized.includes("zero asset") || normalized.includes("no assets")) {
      return "The strategy has no deposited assets earning rewards.";
    }
    if (normalized.includes("no rewards")) {
      return "There are no strategy rewards ready to harvest yet.";
    }
    if (normalized.includes("shutdown")) {
      return "Harvesting is unavailable while this strategy is shut down.";
    }
    if (normalized.includes("paused")) {
      return "Harvesting is temporarily paused.";
    }
    return reason || "The strategy rewards cannot be harvested yet.";
  } catch {
    return "The strategy rewards cannot be harvested yet.";
  }
}

function TokenAmountRow({ item }: { item: TokenAmount }) {
  const known = KNOWN_TOKENS[item.token.toLowerCase()];
  const { token } = useTokenMetadata(known ? undefined : item.token);
  const symbol = known?.symbol ?? token?.symbol ?? `${item.token.slice(0, 6)}…${item.token.slice(-4)}`;
  const decimals = known?.decimals ?? token?.decimals ?? 18;
  const logo = known?.logo ?? token?.logoURI;
  const amount = Number(formatUnits(item.amount, decimals)).toLocaleString("en-US", { maximumFractionDigits: 4 });

  return (
    <div className="flex items-center gap-3 py-3">
      {logo ? <Image src={logo} alt={symbol} width={34} height={34} className="rounded-full" /> : (
        <div className="w-[34px] h-[34px] shrink-0 rounded-full bg-[var(--muted)] flex items-center justify-center text-[10px] font-semibold">{symbol.slice(0, 3)}</div>
      )}
      <div>
        <p className="mono text-base font-medium">{amount} {symbol}</p>
      </div>
    </div>
  );
}

function AuctionRoute({ item, to }: { item: TokenAmount; to: `0x${string}` }) {
  const knownFrom = KNOWN_TOKENS[item.token.toLowerCase()];
  const knownTo = KNOWN_TOKENS[to.toLowerCase()];
  const { token: fromMetadata } = useTokenMetadata(knownFrom ? undefined : item.token);
  const { token: toMetadata } = useTokenMetadata(knownTo ? undefined : to);
  const fromSymbol = knownFrom?.symbol ?? fromMetadata?.symbol ?? "Reward";
  const toSymbol = knownTo?.symbol ?? toMetadata?.symbol ?? "Strategy token";
  const fromLogo = knownFrom?.logo ?? fromMetadata?.logoURI;
  const toLogo = knownTo?.logo ?? toMetadata?.logoURI;
  const fromDecimals = knownFrom?.decimals ?? fromMetadata?.decimals ?? 18;
  const amount = Number(formatUnits(item.amount, fromDecimals)).toLocaleString("en-US", { maximumFractionDigits: 4 });

  const tokenIcon = (logo: string | undefined, symbol: string) => logo ? (
    <Image src={logo} alt={symbol} width={24} height={24} className="rounded-full" />
  ) : (
    <span className="w-6 h-6 rounded-full bg-[var(--muted)] flex items-center justify-center text-[8px] font-semibold">{symbol.slice(0, 3)}</span>
  );

  return (
    <div aria-label={`Auction route ${fromSymbol} to ${toSymbol}`} className="flex items-center gap-2 py-3 text-sm font-medium mono">
      {tokenIcon(fromLogo, fromSymbol)}
      <span>{amount} {fromSymbol}</span>
      <span className="text-[var(--muted-foreground)]">→</span>
      {tokenIcon(toLogo, toSymbol)}
      <span>{toSymbol}</span>
    </div>
  );
}

export function VaultHarvestPanel({ vaultAddress }: { vaultAddress: string }) {
  const config = useMemo(() => getHarvestConfig(vaultAddress), [vaultAddress]);
  const { isConnected, address } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { data: vaultCache } = useVaultCache();
  const [currentTimestamp, setCurrentTimestamp] = useState(() => Math.floor(Date.now() / 1000));
  const auctionPreview = useSyncExternalStore(
    subscribeToAuctionPreview,
    getAuctionPreviewSnapshot,
    getAuctionPreviewServerSnapshot,
  );
  const [action, setAction] = useState<"report" | "auction" | "approve-take" | "take" | null>(null);
  const [pendingTakeWarning, setPendingTakeWarning] = useState<{
    item: TokenAmount;
    index: number;
    fromSymbol: string;
    toSymbol: string;
    auctionRate: number;
    marketRate: number;
    likelySettlesAt: number | undefined;
    takeLabel: string;
  } | null>(null);
  const { writeContractAsync, data: txHash, status: writeStatus, error: writeError, reset } = useDirectWriteContract();

  const reads = useReadContracts({
    contracts: config ? [
      rewardRead(config),
      reportTriggerRead(config),
      config.kind === "yspxcvx"
        ? { address: config.strategy, abi: STRATEGY_ABI, functionName: "getKickableTokens" }
        : config.auctionToken
          ? { address: config.strategy, abi: STRATEGY_ABI, functionName: "kickable", args: [config.auctionToken] }
          : { address: config.strategy, abi: STRATEGY_ABI, functionName: "pendingRewards" },
      { address: config.strategy, abi: STRATEGY_ABI, functionName: "lastReport" },
      { address: config.strategy, abi: STRATEGY_ABI, functionName: "profitMaxUnlockTime" },
    ] : [],
    query: { enabled: !!config, refetchInterval: 15_000 },
  });
  const { data: readData, isLoading: readsLoading, refetch: refetchReads } = reads;
  const thresholdRead = useReadContract({
    address: config?.strategy,
    abi: STRATEGY_ABI,
    functionName: config?.rewardThreshold?.functionName ?? "minAmountToSell",
    args: config?.rewardThreshold ? [config.rewardThreshold.token] : undefined,
    query: { enabled: !!config?.rewardThreshold, refetchInterval: 15_000 },
  });
  const { data: rewardThreshold, refetch: refetchThreshold } = thresholdRead;
  const auctionAddressRead = useReadContract({
    address: config?.strategy,
    abi: STRATEGY_ABI,
    functionName: "auction",
    query: { enabled: !!config?.auctionOutputToken, refetchInterval: 15_000 },
  });
  const { data: auctionAddress, refetch: refetchAuctionAddress } = auctionAddressRead;
  const receipt = useWaitForTransactionReceipt({ hash: txHash });

  const rewards = config ? parseRewards(config, readData?.[0]?.status === "success" ? readData[0].result : undefined) : [];
  const triggerRead = readData?.[1];
  const trigger = triggerRead?.status === "success" ? triggerRead.result as readonly [boolean, `0x${string}`] : undefined;
  const triggerStatus = triggerRead?.status === "failure" ? "error" : triggerRead?.status === "success" ? "success" : "pending";
  const shouldReport = trigger?.[0] ?? false;
  const lastReport = readData?.[3]?.status === "success" ? readData[3].result as bigint : undefined;
  const profitMaxUnlockTime = readData?.[4]?.status === "success" ? readData[4].result as bigint : undefined;
  const nextReportAt = lastReport !== undefined && profitMaxUnlockTime !== undefined
    ? Number(lastReport + profitMaxUnlockTime)
    : undefined;
  const thresholdReward = config?.rewardThreshold
    ? rewards.find((item) => item.token.toLowerCase() === config.rewardThreshold?.token.toLowerCase())
    : undefined;
  const thresholdToken = config?.rewardThreshold ? KNOWN_TOKENS[config.rewardThreshold.token.toLowerCase()] : undefined;
  const thresholdProgress = thresholdReward && rewardThreshold !== undefined && thresholdToken
    ? `${Number(formatUnits(thresholdReward.amount, thresholdToken.decimals)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / ${Number(formatUnits(rewardThreshold, thresholdToken.decimals)).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${thresholdToken.symbol}`
    : undefined;
  const auctionItems: TokenAmount[] = config?.kind === "yspxcvx"
    ? (() => {
        const result = readData?.[2]?.status === "success" ? readData[2].result as readonly [readonly `0x${string}`[], readonly bigint[]] : undefined;
        return (result?.[0] ?? []).map((token, index) => ({ token, amount: result?.[1][index] ?? 0n }));
      })()
    : config?.auctionToken
      ? [{ token: config.auctionToken, amount: readData?.[2]?.status === "success" ? readData[2].result as bigint : 0n }]
      : [];
  const auctionStateReads = useReadContracts({
    contracts: auctionAddress ? auctionItems.flatMap((item) => [
      { address: auctionAddress, abi: AUCTION_ABI, functionName: "isActive", args: [item.token] } as const,
      { address: auctionAddress, abi: AUCTION_ABI, functionName: "available", args: [item.token] } as const,
      { address: auctionAddress, abi: AUCTION_ABI, functionName: "kicked", args: [item.token] } as const,
      { address: auctionAddress, abi: AUCTION_ABI, functionName: "auctionLength" } as const,
      { address: auctionAddress, abi: AUCTION_ABI, functionName: "startingPrice" } as const,
      { address: auctionAddress, abi: AUCTION_ABI, functionName: "stepDuration" } as const,
      { address: auctionAddress, abi: AUCTION_ABI, functionName: "stepDecayRate" } as const,
      { address: auctionAddress, abi: AUCTION_ABI, functionName: "auctions", args: [item.token] } as const,
      { address: auctionAddress, abi: AUCTION_ABI, functionName: "getAmountNeeded", args: [item.token] } as const,
      { address: config?.auctionOutputToken, abi: ERC20_ABI, functionName: "balanceOf", args: [address ?? ZERO_ADDRESS] } as const,
      { address: config?.auctionOutputToken, abi: ERC20_ABI, functionName: "allowance", args: [address ?? ZERO_ADDRESS, auctionAddress] } as const,
    ]) : [],
    query: { enabled: !!auctionAddress && !!config?.auctionOutputToken && auctionItems.length > 0, refetchInterval: 15_000 },
  });
  const { data: auctionStateData, refetch: refetchAuctionState } = auctionStateReads;

  useEffect(() => {
    const interval = setInterval(() => setCurrentTimestamp(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(interval);
  }, []);

  const getAuctionState = (index: number): AuctionState => {
    if (auctionPreview) {
      const hasPaymentBalance = auctionPreview !== "no-balance";
      return {
      active: auctionPreview !== "waiting" && auctionPreview !== "empty",
      available: 2_500n * 10n ** 18n,
      startsAt: currentTimestamp - 3 * 3_600,
      endsAt: currentTimestamp + 21 * 3_600,
      likelySettlesAt: currentTimestamp + 2 * 3_600,
      auctionRate: 0.06,
      marketRate: 0.05,
      takeAmount: hasPaymentBalance ? 2_500n * 10n ** 18n : 0n,
      takePayment: hasPaymentBalance ? 150n * 10n ** 18n : 0n,
      requiredPayment: 150n * 10n ** 18n,
      paymentBalance: hasPaymentBalance ? 150n * 10n ** 18n : 0n,
      paymentAllowance: hasPaymentBalance ? 150n * 10n ** 18n : 0n,
      };
    }
    if (!auctionAddress) return {
      active: false,
      available: 0n,
      startsAt: undefined,
      endsAt: undefined,
      likelySettlesAt: undefined,
      auctionRate: undefined,
      marketRate: undefined,
      takeAmount: 0n,
      takePayment: 0n,
      requiredPayment: 0n,
      paymentBalance: 0n,
      paymentAllowance: 0n,
    };
    const offset = index * 11;
    const results = auctionStateData;
    const contractActive = results?.[offset]?.status === "success" ? results[offset].result as boolean : false;
    const available = results?.[offset + 1]?.status === "success" ? results[offset + 1].result as bigint : 0n;
    // The contract's price can remain active after every token has been bought.
    const active = contractActive && available > 0n;
    const kicked = results?.[offset + 2]?.status === "success" ? results[offset + 2].result as bigint : 0n;
    const length = results?.[offset + 3]?.status === "success" ? results[offset + 3].result as bigint : 0n;
    const startingPrice = results?.[offset + 4]?.status === "success" ? results[offset + 4].result as bigint : 0n;
    const stepDuration = results?.[offset + 5]?.status === "success" ? results[offset + 5].result as bigint : 0n;
    const stepDecayRate = results?.[offset + 6]?.status === "success" ? results[offset + 6].result as bigint : 0n;
    const auctionInfo = results?.[offset + 7]?.status === "success"
      ? results[offset + 7].result as readonly [bigint, bigint, bigint]
      : undefined;
    const amountNeeded = results?.[offset + 8]?.status === "success" ? results[offset + 8].result as bigint : 0n;
    const paymentBalance = results?.[offset + 9]?.status === "success" ? results[offset + 9].result as bigint : 0n;
    const paymentAllowance = results?.[offset + 10]?.status === "success" ? results[offset + 10].result as bigint : 0n;
    const startsAt = kicked > 0n ? Number(kicked) : undefined;
    const endsAt = kicked > 0n && length > 0n ? Number(kicked + length) : undefined;
    const outputToken = config?.auctionOutputToken;
    const fromToken = KNOWN_TOKENS[auctionItems[index]?.token.toLowerCase()];
    const toToken = outputToken ? KNOWN_TOKENS[outputToken.toLowerCase()] : undefined;
    const tokenPriceUsd = (token: `0x${string}` | undefined): number => {
      if (!token) return 0;
      const address = token.toLowerCase();
      if (address === TOKENS.CVXCRV.toLowerCase()) return vaultCache?.cvxCrvPrice ?? 0;
      if (address === TOKENS.CVX.toLowerCase()) return vaultCache?.cvxPrice ?? 0;
      if (address === TOKENS.CVGCVX.toLowerCase()) return vaultCache?.cvgCvxPrice ?? 0;
      if (address === TOKENS.PXCVX.toLowerCase()) return vaultCache?.pxCvxPrice ?? 0;
      if (address === "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e") return 1;
      return 0;
    };
    const likelySettlesAt = estimateLikelySettlementAt({
      kicked,
      initialAvailable: auctionInfo?.[2] ?? available,
      startingPrice,
      stepDuration,
      stepDecayRate,
      fromDecimals: fromToken?.decimals ?? 18,
      toDecimals: toToken?.decimals ?? 18,
      fromPriceUsd: tokenPriceUsd(auctionItems[index]?.token),
      toPriceUsd: tokenPriceUsd(outputToken),
      endsAt,
    });
    const availableTokens = Number(formatUnits(available, fromToken?.decimals ?? 18));
    const paymentTokens = Number(formatUnits(amountNeeded, toToken?.decimals ?? 18));
    const auctionRate = availableTokens > 0 && paymentTokens > 0 ? paymentTokens / availableTokens : undefined;
    const fromPriceUsd = tokenPriceUsd(auctionItems[index]?.token);
    const toPriceUsd = tokenPriceUsd(outputToken);
    const marketRate = fromPriceUsd > 0 && toPriceUsd > 0 ? fromPriceUsd / toPriceUsd : undefined;
    // getAmountNeeded(from) is the contract's exact cost for everything still available.
    // For a partial take, divide by one more than that rounded-down total so the
    // resulting amount cannot cost more than the wallet balance.
    const takeAmount = amountNeeded > 0n && paymentBalance > 0n
      ? paymentBalance >= amountNeeded
        ? available
        : (available * paymentBalance) / (amountNeeded + 1n)
      : 0n;
    const takePayment = available > 0n && takeAmount > 0n
      ? takeAmount === available
        ? amountNeeded
        : ((amountNeeded + 1n) * takeAmount + available - 1n) / available
      : 0n;
    return { active, available, startsAt, endsAt, likelySettlesAt, auctionRate, marketRate, takeAmount, takePayment, requiredPayment: amountNeeded, paymentBalance, paymentAllowance };
  };

  useEffect(() => {
    if (!receipt.isSuccess) return;
    toast.success(
      action === "auction" ? "Strategy rewards sent to auction"
        : action === "approve-take" ? "Auction payment approved"
          : action === "take" ? "Auction take completed"
            : "Harvest report submitted",
    );
    void refetchReads();
    void refetchThreshold();
    void refetchAuctionAddress();
    void refetchAuctionState();
    reset();
  }, [action, receipt.isSuccess, refetchAuctionAddress, refetchAuctionState, refetchReads, refetchThreshold, reset]);

  useEffect(() => {
    if (writeError) toast.error(writeError.message.split("\n")[0]);
  }, [writeError]);

  useEffect(() => {
    if (receipt.error) toast.error("Transaction failed");
  }, [receipt.error]);

  if (!config) {
    return <div className="p-6 text-sm text-[var(--muted-foreground)]">Harvest data is not available for this vault.</div>;
  }

  const busy = writeStatus === "pending" || receipt.isLoading;
  const submit = async (nextAction: "report" | "auction", token?: `0x${string}`) => {
    if (!isConnected) { openConnectModal?.(); return; }
    setAction(nextAction);
    try {
      if (nextAction === "report") {
        await writeContractAsync({
          address: PERMISSIONLESS_KEEPER, abi: KEEPER_ABI, functionName: "report", args: [config.strategy],
        });
      } else {
        await writeContractAsync({
          address: config.strategy, abi: STRATEGY_ABI, functionName: "kickAuction", args: [token!],
        });
      }
    } catch { setAction(null); }
  };

  const submitTake = async (
    item: TokenAmount,
    auctionState: AuctionState,
  ) => {
    if (!isConnected || !address) { openConnectModal?.(); return; }
    if (!auctionAddress || !config.auctionOutputToken || auctionState.takeAmount <= 0n || auctionState.takePayment <= 0n) return;
    try {
      if (auctionState.paymentAllowance < auctionState.takePayment) {
        setAction("approve-take");
        await writeContractAsync({
          address: config.auctionOutputToken,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [auctionAddress, auctionState.takePayment],
        });
      } else {
        setAction("take");
        await writeContractAsync({
          address: auctionAddress,
          abi: AUCTION_ABI,
          functionName: "take",
          args: [item.token, auctionState.takeAmount, address],
        });
      }
    } catch { setAction(null); }
  };

  const requestTake = (
    item: TokenAmount,
    index: number,
    auctionState: AuctionState,
    fromSymbol: string,
    toSymbol: string,
    takeLabel: string,
  ) => {
    const needsApproval = auctionState.paymentAllowance < auctionState.takePayment;
    if (
      !needsApproval && auctionState.auctionRate !== undefined && auctionState.marketRate !== undefined &&
      auctionState.auctionRate > auctionState.marketRate
    ) {
      setPendingTakeWarning({
        item,
        index,
        fromSymbol,
        toSymbol,
        auctionRate: auctionState.auctionRate,
        marketRate: auctionState.marketRate,
        likelySettlesAt: auctionState.likelySettlesAt,
        takeLabel,
      });
      return;
    }
    void submitTake(item, auctionState);
  };

  const pendingMarketMatchAt = pendingTakeWarning
    ? getAuctionState(pendingTakeWarning.index).likelySettlesAt ?? pendingTakeWarning.likelySettlesAt
    : undefined;

  return (
    <div className="p-4 sm:p-5 space-y-4">
      <div className="rounded-lg border border-[var(--border)] p-4 hover:border-[var(--border-hover)] transition-colors">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Gift size={16} className="text-[var(--muted-foreground)]" />
          Vault strategy rewards
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4 mt-2">
          <div className="min-w-0 flex-1 divide-y divide-[var(--border)]">
            {readsLoading ? <div className="h-14 flex items-center"><Loader2 className="animate-spin text-[var(--muted-foreground)]" size={18} /></div> : rewards.length ? (
              rewards.map((item) => <TokenAmountRow key={item.token} item={item} />)
            ) : <div className="py-4 text-sm text-[var(--muted-foreground)]">No strategy rewards available</div>}
          </div>
          <button disabled={!shouldReport || busy} onClick={() => void submit("report")} className="w-full sm:w-auto shrink-0 px-4 py-1.5 text-sm font-medium rounded-md bg-[var(--foreground)] text-[var(--background)] hover:opacity-90 transition-all disabled:bg-[var(--muted)] disabled:text-[var(--muted-foreground)] disabled:opacity-100 disabled:hover:opacity-100 disabled:cursor-not-allowed">
            {busy && action === "report" ? "Harvesting…" : "Harvest for vault"}
          </button>
        </div>
        <p className={`pt-3 mt-1 border-t border-[var(--border)] text-xs ${shouldReport ? "text-[var(--success)]" : "text-[var(--muted-foreground)]"}`}>
          {triggerMessage(trigger, triggerStatus, nextReportAt, thresholdProgress)}
        </p>
      </div>

      {auctionItems.length > 0 && auctionItems.map((liveItem, index) => {
        const item = auctionPreview === "waiting"
          ? { ...liveItem, amount: 2_500n * 10n ** BigInt(KNOWN_TOKENS[liveItem.token.toLowerCase()]?.decimals ?? 18) }
          : auctionPreview === "empty" ? { ...liveItem, amount: 0n } : liveItem;
        const auctionState = getAuctionState(index);
        const displayedItem = auctionState.active ? { ...item, amount: auctionState.available } : item;
        const fromToken = KNOWN_TOKENS[item.token.toLowerCase()];
        const toToken = config.auctionOutputToken ? KNOWN_TOKENS[config.auctionOutputToken.toLowerCase()] : undefined;
        const canTake = auctionState.active && auctionState.takeAmount > 0n && auctionState.takePayment > 0n;
        const needsTakeApproval = auctionState.paymentAllowance < auctionState.takePayment;
        const takeLabel = `Take ${Number(formatUnits(auctionState.takeAmount, fromToken?.decimals ?? 18)).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${fromToken?.symbol ?? "tokens"} with ${Number(formatUnits(auctionState.takePayment, toToken?.decimals ?? 18)).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${toToken?.symbol ?? "payment tokens"}`;
        return <div key={item.token} className="rounded-lg border border-[var(--border)] p-4 hover:border-[var(--border-hover)] transition-colors">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Gavel size={16} className="text-[var(--muted-foreground)]" />
            Auction
            {auctionState.active && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--success)]">
                <CircleDot size={12} aria-hidden="true" className="motion-safe:animate-[pulse_3s_ease-in-out_infinite]" />
                Auction in progress
              </span>
            )}
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4 mt-2">
            {config.auctionOutputToken && <AuctionRoute item={displayedItem} to={config.auctionOutputToken} />}
            <div className="flex flex-col gap-2 w-full sm:w-auto shrink-0">
              {!auctionState.active && (
                <button disabled={item.amount === 0n || busy} onClick={() => void submit("auction", item.token)} className="w-full inline-flex items-center justify-center px-4 py-1.5 rounded-md bg-[var(--foreground)] text-[var(--background)] text-sm font-medium hover:opacity-90 transition-all disabled:bg-[var(--muted)] disabled:text-[var(--muted-foreground)] disabled:opacity-100 disabled:hover:opacity-100 disabled:cursor-not-allowed">
                  {busy && action === "auction" ? "Starting…" : "Start auction"}
                </button>
              )}
              {auctionState.active && (
                <button disabled={!canTake || busy} onClick={() => requestTake(item, index, auctionState, fromToken?.symbol ?? "token", toToken?.symbol ?? "payment token", takeLabel)} className="w-full inline-flex items-center justify-center px-4 py-1.5 rounded-md border border-[var(--border)] text-sm font-medium hover:bg-[var(--muted)] transition-all disabled:text-[var(--muted-foreground)] disabled:cursor-not-allowed">
                  {busy && action === "approve-take" ? "Approving…"
                    : busy && action === "take" ? "Taking…"
                      : auctionState.paymentBalance <= 0n
                        ? `No ${toToken?.symbol ?? "payment token"} balance`
                      : needsTakeApproval
                        ? `Approve ${toToken?.symbol ?? "payment token"} to participate`
                        : takeLabel}
                </button>
              )}
            </div>
          </div>
          {auctionState.active ? (
            <div className="pt-3 mt-1 border-t border-[var(--border)] text-xs text-[var(--muted-foreground)] space-y-3">
              {auctionState.startsAt !== undefined && auctionState.endsAt !== undefined ? (
                <AuctionTimeline
                  startsAt={auctionState.startsAt}
                  endsAt={auctionState.endsAt}
                  marketAt={auctionState.likelySettlesAt}
                  now={currentTimestamp}
                  fromSymbol={fromToken?.symbol ?? "auction token"}
                  toSymbol={toToken?.symbol ?? "payment token"}
                />
              ) : (
                <p>The auction is live.</p>
              )}
              {auctionState.auctionRate !== undefined && auctionState.marketRate !== undefined && (
                <div className="grid grid-cols-2 gap-2" aria-label="Auction and market price comparison">
                  <div className="rounded-md bg-[var(--muted)] px-3 py-2">
                    <span className="block text-[10px] uppercase tracking-wide">Auction now</span>
                    <span className="mt-0.5 block font-medium text-[var(--foreground)]">{formatRate(auctionState.auctionRate)} {toToken?.symbol ?? "payment tokens"}</span>
                  </div>
                  <div className="rounded-md bg-[var(--muted)] px-3 py-2">
                    <span className="block text-[10px] uppercase tracking-wide">Market</span>
                    <span className="mt-0.5 block font-medium text-[var(--success)]">≈ {formatRate(auctionState.marketRate)} {toToken?.symbol ?? "payment tokens"}</span>
                  </div>
                </div>
              )}
            </div>
          ) : null}
          {(auctionState.active || item.amount === 0n || auctionAddress && auctionAddress !== ZERO_ADDRESS) && (
            <div className={`flex items-baseline justify-between gap-3 text-xs text-[var(--muted-foreground)] ${!auctionState.active ? "pt-3 mt-1 border-t border-[var(--border)]" : "pt-3"}`}>
              {auctionState.active && (auctionState.takeAmount > 0n && auctionState.takePayment > 0n ? (
                <p>
                  Swap up to {Number(formatUnits(auctionState.takePayment, toToken?.decimals ?? 18)).toLocaleString("en-US", { maximumFractionDigits: 4 })} {toToken?.symbol ?? "payment tokens"} for ≈{Number(formatUnits(auctionState.takeAmount, fromToken?.decimals ?? 18)).toLocaleString("en-US", { maximumFractionDigits: 4 })} {fromToken?.symbol ?? "tokens"}.
                </p>
              ) : (
                <p>
                  You need {toToken?.symbol ?? "the payment token"} to take this auction.{" "}
                  {config.auctionOutputToken && (
                    <Link
                      href={`/zap?${new URLSearchParams({
                        input: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                        output: config.auctionOutputToken,
                        outputSymbol: toToken?.symbol ?? "token",
                        outputDecimals: String(toToken?.decimals ?? 18),
                        ...(toToken?.logo ? { outputLogo: toToken.logo } : {}),
                        ...(auctionState.requiredPayment > 0n
                          ? { outputAmount: formatUnits(auctionState.requiredPayment, toToken?.decimals ?? 18) }
                          : {}),
                      }).toString()}`}
                      className="whitespace-nowrap font-medium text-[var(--foreground)] transition-colors hover:text-[var(--accent)]"
                    >
                      <Zap size={12} aria-hidden="true" className="mr-1 inline-block align-[-0.125em]" />
                      Buy {toToken?.symbol ?? "token"}
                    </Link>
                  )}
                </p>
              ))}
              {!auctionState.active && item.amount === 0n && (
                <p>No strategy-owned tokens are waiting for an auction.</p>
              )}
              {auctionAddress && auctionAddress !== ZERO_ADDRESS && (
              <a
                href={`https://auctionscan.info/auction/1/${auctionAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="View current and previous auctions on AuctionScan (opens in a new tab)"
                className="ml-auto inline-flex shrink-0 items-center gap-1 font-medium transition-colors hover:text-[var(--accent)]"
              >
                AuctionScan
                <ExternalLink size={12} aria-hidden="true" />
              </a>
              )}
            </div>
          )}
          {canTake && needsTakeApproval && (
            <p className="pt-2 text-xs text-[var(--muted-foreground)]">If you’d like to participate, approve {toToken?.symbol ?? "the payment token"} first.</p>
          )}
        </div>
      })}
      {pendingTakeWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="auction-price-warning-title">
          <div className="w-full max-w-md rounded-xl border border-[var(--warning)]/40 bg-[var(--background)] p-5 shadow-xl">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 rounded-full bg-[var(--warning)]/15 p-2 text-[var(--warning)]">
                <AlertTriangle size={18} aria-hidden="true" />
              </span>
              <div>
                <h2 id="auction-price-warning-title" className="text-base font-semibold">Auction price is above market value</h2>
                <p className="mt-1 text-sm text-[var(--warning)]">
                  You would pay approximately {(((pendingTakeWarning.auctionRate / pendingTakeWarning.marketRate) - 1) * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}% more than the estimated market price.
                </p>
              </div>
            </div>
            <p className="mt-4 rounded-lg bg-[var(--warning)]/10 px-3 py-2.5 text-sm text-[var(--foreground)]">
              Auction: {formatRate(pendingTakeWarning.auctionRate)} {pendingTakeWarning.toSymbol} per {pendingTakeWarning.fromSymbol}<br />
              Market: approximately {formatRate(pendingTakeWarning.marketRate)} {pendingTakeWarning.toSymbol} per {pendingTakeWarning.fromSymbol}
            </p>
            <p className="mt-2 text-sm text-[var(--muted-foreground)]">
              {pendingMarketMatchAt !== undefined
                ? `Estimated to reach the market price ${relativeTime(pendingMarketMatchAt, currentTimestamp)} · ${formatLocalDate(pendingMarketMatchAt)}. You may want to wait until then.`
                : "The auction price falls over time toward the estimated market price."}
            </p>
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" onClick={() => setPendingTakeWarning(null)} className="rounded-md border border-[var(--border)] px-4 py-2 text-sm font-medium hover:bg-[var(--muted)]">Cancel</button>
              <button type="button" onClick={() => {
                const warning = pendingTakeWarning;
                setPendingTakeWarning(null);
                void submitTake(warning.item, getAuctionState(warning.index));
              }} className="rounded-md bg-[var(--warning)] px-4 py-2 text-sm font-semibold text-black hover:opacity-90">{pendingTakeWarning.takeLabel}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
