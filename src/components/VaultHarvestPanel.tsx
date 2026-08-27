"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { useAccount, useReadContracts, useWaitForTransactionReceipt } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { formatUnits, hexToString } from "viem";
import { Check, Loader2, Send, Sprout } from "lucide-react";
import { toast } from "sonner";

import { useDirectWriteContract } from "@/hooks/useDirectWriteContract";
import { useTokenMetadata } from "@/hooks/useTokenMetadata";
import {
  COMMON_TRIGGER,
  CVGCVX_STAKING,
  CVXCRV_WRAPPER,
  PERMISSIONLESS_KEEPER,
  getHarvestConfig,
  type HarvestConfig,
} from "@/config/harvest";
import { TOKENS } from "@/config/vaults";

const REPORT_TRIGGER_ABI = [{
  name: "reportTrigger", type: "function", stateMutability: "view",
  inputs: [{ name: "strategy", type: "address" }],
  outputs: [{ name: "shouldReport", type: "bool" }, { name: "data", type: "bytes" }],
}] as const;
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
const CVG_TOKEN = "0x97efFB790f2fbB701D88f89DB4521348A2B77be8" as const;

const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number; logo?: string }> = {
  [TOKENS.CVXCRV.toLowerCase()]: { symbol: "cvxCRV", decimals: 18, logo: "/tokens/cvxcrv.png" },
  [TOKENS.CVX.toLowerCase()]: { symbol: "CVX", decimals: 18 },
  [TOKENS.CVGCVX.toLowerCase()]: { symbol: "cvgCVX", decimals: 18, logo: "/tokens/cvgcvx.png" },
  [CVG_TOKEN.toLowerCase()]: { symbol: "CVG", decimals: 18 },
  ["0xf939e0a03fb07f59a73314e73794be0e57ac1b4e"]: { symbol: "crvUSD", decimals: 18, logo: "/tokens/crvusd.png" },
  ["0xd533a949740bb3306d119cc777fa900ba034cd52"]: { symbol: "CRV", decimals: 18 },
  ["0x6c3f90f043a72fa612cbac8115ee7e52bde6e490"]: { symbol: "3CRV", decimals: 18 },
};

function rewardRead(config: HarvestConfig) {
  if (config.kind === "yscvx") return { address: config.strategy, abi: STRATEGY_ABI, functionName: "pendingRewards" } as const;
  if (config.kind === "yscvxcrv") return { address: CVXCRV_WRAPPER, abi: WRAPPER_ABI, functionName: "earned", args: [config.strategy] } as const;
  if (config.kind === "yscvgcvx") return { address: CVGCVX_STAKING, abi: CVG_STAKING_ABI, functionName: "getAllClaimableAmounts", args: [config.strategy] } as const;
  return { address: config.strategy, abi: STRATEGY_ABI, functionName: "getRewardTokensWithBalances" } as const;
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

function triggerMessage(trigger: readonly [boolean, `0x${string}`] | undefined): string {
  if (!trigger) return "Checking report availability…";
  if (trigger[0]) return "Report is available";
  try {
    const reason = hexToString(trigger[1], { size: undefined }).replaceAll("\0", "").trim();
    return reason || "Report is not currently available";
  } catch {
    return "Report is not currently available";
  }
}

function TokenAmountRow({ item, label }: { item: TokenAmount; label: string }) {
  const known = KNOWN_TOKENS[item.token.toLowerCase()];
  const { token } = useTokenMetadata(known ? undefined : item.token);
  const symbol = known?.symbol ?? token?.symbol ?? `${item.token.slice(0, 6)}…${item.token.slice(-4)}`;
  const decimals = known?.decimals ?? token?.decimals ?? 18;
  const logo = known?.logo ?? token?.logoURI;
  const amount = Number(formatUnits(item.amount, decimals)).toLocaleString("en-US", { maximumFractionDigits: 4 });

  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div>
        <p className="text-xs text-[var(--muted-foreground)]">{label}</p>
        <p className="mono text-lg mt-1">{amount} {symbol}</p>
      </div>
      {logo ? <Image src={logo} alt={symbol} width={34} height={34} className="rounded-full" /> : (
        <div className="w-[34px] h-[34px] rounded-full bg-[var(--muted)] flex items-center justify-center text-[10px] font-semibold">{symbol.slice(0, 3)}</div>
      )}
    </div>
  );
}

export function VaultHarvestPanel({ vaultAddress }: { vaultAddress: string }) {
  const config = useMemo(() => getHarvestConfig(vaultAddress), [vaultAddress]);
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const [action, setAction] = useState<"report" | "auction" | null>(null);
  const { writeContractAsync, data: txHash, status: writeStatus, error: writeError, reset } = useDirectWriteContract();

  const reads = useReadContracts({
    contracts: config ? [
      rewardRead(config),
      { address: COMMON_TRIGGER, abi: REPORT_TRIGGER_ABI, functionName: "reportTrigger", args: [config.strategy] },
      config.kind === "yspxcvx"
        ? { address: config.strategy, abi: STRATEGY_ABI, functionName: "getKickableTokens" }
        : config.auctionToken
          ? { address: config.strategy, abi: STRATEGY_ABI, functionName: "kickable", args: [config.auctionToken] }
          : { address: config.strategy, abi: STRATEGY_ABI, functionName: "pendingRewards" },
    ] : [],
    query: { enabled: !!config, refetchInterval: 15_000 },
  });
  const { data: readData, isLoading: readsLoading, refetch: refetchReads } = reads;
  const receipt = useWaitForTransactionReceipt({ hash: txHash });

  const rewards = config ? parseRewards(config, readData?.[0]?.status === "success" ? readData[0].result : undefined) : [];
  const trigger = readData?.[1]?.status === "success" ? readData[1].result as readonly [boolean, `0x${string}`] : undefined;
  const shouldReport = trigger?.[0] ?? false;
  const auctionItems: TokenAmount[] = config?.kind === "yspxcvx"
    ? (() => {
        const result = readData?.[2]?.status === "success" ? readData[2].result as readonly [readonly `0x${string}`[], readonly bigint[]] : undefined;
        return (result?.[0] ?? []).map((token, index) => ({ token, amount: result?.[1][index] ?? 0n }));
      })()
    : config?.auctionToken
      ? [{ token: config.auctionToken, amount: readData?.[2]?.status === "success" ? readData[2].result as bigint : 0n }]
      : [];

  useEffect(() => {
    if (!receipt.isSuccess) return;
    toast.success(action === "auction" ? "Rewards sent to auction" : "Harvest report submitted");
    void refetchReads();
    reset();
  }, [action, receipt.isSuccess, refetchReads, reset]);

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

  return (
    <div className="p-4 sm:p-5 space-y-4">
      <div className="rounded-lg border border-[var(--border)] px-4 divide-y divide-[var(--border)]">
        {readsLoading ? <div className="h-20 flex items-center justify-center"><Loader2 className="animate-spin text-[var(--muted-foreground)]" size={18} /></div> : rewards.length ? (
          rewards.map((item) => <TokenAmountRow key={item.token} item={item} label="Pending rewards" />)
        ) : <div className="py-5 text-sm text-[var(--muted-foreground)]">No pending rewards</div>}
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border)] p-4">
        <div className="flex items-start gap-3">
          <Sprout size={18} className="text-[var(--accent)] mt-0.5" />
          <div><p className="text-sm font-medium">Harvest strategy</p><p className="text-xs text-[var(--muted-foreground)] mt-1">{triggerMessage(trigger)}</p></div>
        </div>
        <button disabled={!shouldReport || busy} onClick={() => void submit("report")} className="shrink-0 px-3 py-2 rounded-md bg-[var(--accent)] text-white text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed">
          {busy && action === "report" ? "Submitting…" : "Harvest"}
        </button>
      </div>

      {auctionItems.length > 0 && auctionItems.map((item) => (
        <div key={item.token} className="rounded-lg border border-[var(--border)] p-4 space-y-3">
          <TokenAmountRow item={item} label="Kickable" />
          <button disabled={item.amount === 0n || busy} onClick={() => void submit("auction", item.token)} className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-md border border-[var(--accent)] text-[var(--accent)] text-sm font-medium hover:bg-[var(--accent)]/10 disabled:opacity-40 disabled:cursor-not-allowed">
            {receipt.isSuccess && action === "auction" ? <Check size={14} /> : <Send size={14} />}
            {busy && action === "auction" ? "Submitting…" : "Send to auction"}
          </button>
        </div>
      ))}
    </div>
  );
}
