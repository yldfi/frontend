"use client";

import { useState, useEffect } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { formatUnits } from "viem";
import Link from "next/link";
import Image from "next/image";
import { Gift, Clock, CheckCircle2, ArrowUpRight, Check, ChevronRight, AlertTriangle } from "lucide-react";
import { CustomConnectButton } from "@/components/CustomConnectButton";
import { LoadingDots } from "@/components/LoadingDots";
import { useMerklRewards, useMerklOpportunities, getMerklOpportunityUrl, type MerklReward } from "@/hooks/useMerklRewards";
import { useVaultBalance } from "@/hooks/useVaultBalance";
import { useCurveLendingPosition } from "@/hooks/useCurveLendingPosition";
import { VAULT_ADDRESSES, VAULTS } from "@/config/vaults";
import { formatUsd } from "@/lib/utils";
import { toast } from "sonner";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { trackRewardsPageView, trackRewardsClaimClick, trackRewardsEligibilityCheck } from "@/lib/analytics";

const MERKL_DISTRIBUTOR = "0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae" as const;
const CAMPAIGN_START = 1773619200; // 2026-03-16 00:00:00 UTC
const CAMPAIGN_END = 1776211200; // 2026-04-15 00:00:00 UTC
const MERKL_DISTRIBUTOR_ABI = [
  {
    name: "claim",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "users", type: "address[]" },
      { name: "tokens", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "proofs", type: "bytes32[][]" },
    ],
    outputs: [],
  },
] as const;

function Countdown({ target }: { target: number }) {
  const [remaining, setRemaining] = useState(() => target - Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(target - Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [target]);

  if (remaining <= 0) return null;

  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;

  return (
    <span className="inline-flex items-center gap-1 mono">
      <Clock className="w-3 h-3" />
      Starts in {h}h {m.toString().padStart(2, "0")}m {s.toString().padStart(2, "0")}s
    </span>
  );
}

function RewardRow({ reward }: { reward: MerklReward }) {
  const { address } = useAccount();
  const amount = BigInt(reward.amount);
  const claimed = BigInt(reward.claimed);
  const pending = BigInt(reward.pending);
  const claimable = amount - claimed;
  const hasClaimable = claimable > 0n;

  // Total earned = claimable + claimed + pending
  const totalEarned = amount > 0n ? amount : pending;

  const formattedAmount = parseFloat(formatUnits(totalEarned, reward.token.decimals));
  const formattedClaimed = parseFloat(formatUnits(claimed, reward.token.decimals));
  const formattedClaimable = parseFloat(formatUnits(claimable, reward.token.decimals));
  const formattedPending = parseFloat(formatUnits(pending, reward.token.decimals));

  const price = reward.token.price ?? (reward.token.symbol === "crvUSD" ? 1 : 0);
  const claimableUsd = formattedClaimable * price;

  const { writeContract, data: txHash, isPending: isClaiming, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed, error: receiptError } = useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (isConfirmed) {
      toast.success("Rewards claimed successfully!", {
        description: `${formattedClaimable.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${reward.token.symbol}`,
      });
    }
  }, [isConfirmed, formattedClaimable, reward.token.symbol]);

  useEffect(() => {
    if (writeError) toast.error(writeError.message?.split("\n")[0] || "Failed to submit claim");
    if (receiptError) toast.error("Claim transaction failed");
  }, [writeError, receiptError]);

  const handleClaim = () => {
    if (!address) return;
    trackRewardsClaimClick();
    writeContract({
      address: MERKL_DISTRIBUTOR,
      abi: MERKL_DISTRIBUTOR_ABI,
      functionName: "claim",
      args: [
        [address],
        [reward.token.address as `0x${string}`],
        [BigInt(reward.amount)],
        [reward.proofs as `0x${string}`[]],
      ],
    });
  };

  return (
    <div className="border border-[var(--border)] rounded-lg p-5 hover:border-[var(--border-hover)] transition-colors">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          {reward.token.symbol === "crvUSD" ? (
            <Image src="/tokens/crvusd.png" alt="crvUSD" width={36} height={36} className="rounded-full" />
          ) : (
            <div className="w-9 h-9 rounded-full bg-[var(--muted)] flex items-center justify-center text-sm font-medium">
              {reward.token.symbol.slice(0, 2)}
            </div>
          )}
          <div>
            <div className="font-medium">{reward.token.symbol}</div>
          </div>
        </div>
        {hasClaimable && !isConfirmed && (
          <button
            className="px-4 py-1.5 text-sm font-medium rounded-md bg-[var(--foreground)] text-[var(--background)] hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={handleClaim}
            disabled={isClaiming || isConfirming}
          >
            {isClaiming ? <>Confirm <LoadingDots /></> : isConfirming ? <>Claiming <LoadingDots /></> : "Claim"}
          </button>
        )}
        {isConfirmed && (
          <span className="px-4 py-1.5 text-sm font-medium text-green-400 flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4" /> Claimed
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-4 text-sm">
        <div>
          <div className="text-[var(--muted-foreground)] mb-1">
            {formattedPending > 0 && amount === 0n ? "Pending" : "Earned"}
          </div>
          <div className="font-medium mono">
            {formattedAmount.toLocaleString("en-US", { maximumFractionDigits: 4 })}
          </div>
          {price > 0 && (
            <div className="text-xs text-[var(--muted-foreground)]">
              {formatUsd(formattedAmount * price)}
            </div>
          )}
        </div>
        <div>
          <div className="text-[var(--muted-foreground)] mb-1 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> Claimed
          </div>
          <div className="font-medium mono">
            {formattedClaimed.toLocaleString("en-US", { maximumFractionDigits: 4 })}
          </div>
        </div>
        <div>
          <div className="text-[var(--muted-foreground)] mb-1">Claimable</div>
          <div className="font-medium mono text-green-400">
            {formattedClaimable.toLocaleString("en-US", { maximumFractionDigits: 4 })}
          </div>
          {claimableUsd > 0 && (
            <div className="text-xs text-green-400/70">{formatUsd(claimableUsd)}</div>
          )}
        </div>
      </div>

    </div>
  );
}

export function RewardsPageContent() {
  const [currentTimestamp, setCurrentTimestamp] = useState<number | null>(null);
  const { isConnected, address } = useAccount();
  const { data, isLoading, error } = useMerklRewards(1);
  const { data: opportunities } = useMerklOpportunities();
  const yldOpportunity = opportunities?.find((o) => o.name === "Yld Borrow crvUSD");
  const merklUrl = yldOpportunity ? getMerklOpportunityUrl(yldOpportunity) : "https://app.merkl.fr";
  const ycvxVault = VAULTS.ycvxcrv;
  const ycvxDeprecated = Boolean(ycvxVault.deprecated);

  // Check eligibility: user holds ycvxCRV
  const { balance: ycvxcrvBalance } = useVaultBalance(VAULT_ADDRESSES.YCVXCRV as `0x${string}`);
  // Check eligibility: user has a borrow position
  const { position } = useCurveLendingPosition(
    VAULT_ADDRESSES.YCVXCRV as `0x${string}`,
    address
  );
  const hasBorrowPosition = position?.hasLoan ?? false;

  // Step 1 complete if user holds ycvxCRV OR has a lending position (collateral is in Curve's custody)
  const hasYcvxcrv = ycvxcrvBalance > 0n || hasBorrowPosition;

  // Is the user actively earning rewards?
  const isEarning = hasBorrowPosition;

  // Track page view on mount
  useEffect(() => {
    trackRewardsPageView();
  }, []);

  useEffect(() => {
    const updateTimestamp = () => setCurrentTimestamp(Math.floor(Date.now() / 1000));
    updateTimestamp();
    const intervalId = setInterval(updateTimestamp, 1000);
    return () => clearInterval(intervalId);
  }, []);

  // Track eligibility when data is loaded
  useEffect(() => {
    if (isConnected && !isLoading) {
      trackRewardsEligibilityCheck(hasYcvxcrv, hasBorrowPosition);
    }
  }, [isConnected, isLoading, hasYcvxcrv, hasBorrowPosition]);

  // Flatten all rewards across chains. `useMerklRewards` already applies the
  // on-chain claimed override so `r.claimed` reflects the authoritative value.
  const rewards: MerklReward[] = data?.flatMap((d) => d.rewards) ?? [];

  // Use price from API, fallback to $1 for stablecoins
  const getPrice = (r: MerklReward) => r.token.price ?? (r.token.symbol === "crvUSD" ? 1 : 0);

  // Calculate totals
  const totalClaimableUsd = rewards.reduce((sum, r) => {
    const claimable = BigInt(r.amount) - BigInt(r.claimed);
    return sum + parseFloat(formatUnits(claimable, r.token.decimals)) * getPrice(r);
  }, 0);

  const totalPendingUsd = rewards.reduce((sum, r) => {
    return sum + parseFloat(formatUnits(BigInt(r.pending), r.token.decimals)) * getPrice(r);
  }, 0);

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <Header />

      <main style={{ paddingTop: "calc(4rem + var(--test-banner-height))" }}>
        {/* Breadcrumb navigation */}
        <div className="border-b border-[var(--border)]">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4">
            <nav className="flex items-center gap-2 text-sm">
              <Link
                href="/"
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              >
                yld Vaults
              </Link>
              <ChevronRight size={14} className="text-[var(--muted-foreground)]" />
              <span className="text-[var(--foreground)]">Rewards</span>
            </nav>
          </div>
        </div>

        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        {/* Page header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Gift className="w-6 h-6" />
            <h1 className="text-2xl font-semibold tracking-tight">Rewards</h1>
            <a
              href={merklUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] bg-[var(--muted)] transition-colors"
            >
              Powered by
              <Image src="/merkl-symbol.svg" alt="Merkl" width={14} height={14} className="rounded-sm" />
              <span className="font-medium">Merkl</span>
            </a>
          </div>
          <p className="text-sm text-[var(--muted-foreground)]">
            Claim your earned rewards from yld campaigns.
          </p>
        </div>

        {/* Campaign */}
        <div className="mb-10">
          {(() => {
            const hasActiveCampaign = !!yldOpportunity && yldOpportunity.status !== "PAST";
            if (!hasActiveCampaign) {
              return (
                <div className="border border-[var(--border)] rounded-lg p-12 text-center">
                  <Gift className="w-10 h-10 mx-auto mb-4 text-[var(--muted-foreground)]" />
                  <p className="text-[var(--muted-foreground)]">No active campaigns</p>
                </div>
              );
            }
            const now = currentTimestamp ?? CAMPAIGN_START;
            const campaignStart = CAMPAIGN_START;
            const campaignEnd = CAMPAIGN_END;
            const isLive = now >= campaignStart && now < campaignEnd;
            const isUpcoming = now < campaignStart;
            const isCountdown = isUpcoming && (campaignStart - now) <= 86400;
            const statusLabel = isLive ? "Live" : isUpcoming ? "Starting Soon" : "Ended";
            const sectionTitle = isLive ? "Active Campaigns" : isUpcoming ? "Upcoming Campaigns" : "Past Campaigns";
            const dateOpts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false };
            const startDate = new Date(campaignStart * 1000).toLocaleDateString("en-US", dateOpts) + " UTC";
            const endDate = new Date(campaignEnd * 1000).toLocaleDateString("en-US", dateOpts) + " UTC";
            return (<>
          <h2 className="text-sm font-medium text-[var(--muted-foreground)] uppercase tracking-wider mb-4">
            {sectionTitle}
          </h2>
          <div className="border border-[var(--border)] rounded-lg overflow-hidden relative">
            {yldOpportunity && (
              <div className="absolute top-0 right-0 bg-green-400 text-black text-xs font-bold mono px-3 py-1 rounded-bl-lg">
                {yldOpportunity.apr?.toFixed(1) ?? "0"}% APR
              </div>
            )}
            <div className="p-5">
              {/* Campaign header */}
              <div className="flex items-center gap-3 mb-4">
                <Image src="/ycvxcrv-64.png" alt="ycvxCRV" width={40} height={40} className="rounded-full" />
                <div className="flex-1">
                  <h3 className="font-medium leading-normal">
                    ycvxCRV borrow rewards{" "}
                    {hasBorrowPosition ? (
                      <Link href="/vaults/ycvxcrv/lending" className="hover:text-[var(--accent)] transition-colors">
                        <Image src="/curve-logo.png" alt="Curve" width={14} height={14} className="rounded-full inline align-middle" />
                        {" "}Manage loan{" "}
                        <ArrowUpRight className="w-3 h-3 inline align-middle" />
                      </Link>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[var(--muted-foreground)]">
                        <Image src="/curve-logo.png" alt="Curve" width={14} height={14} className="rounded-full inline align-middle" />
                        {" "}Curve LlamaLend
                      </span>
                    )}
                  </h3>
                  <div className="flex items-center gap-2 mt-0.5">
                    {ycvxDeprecated && ycvxVault.deprecated && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 text-yellow-500">
                        <AlertTriangle className="w-3 h-3" />
                        {ycvxVault.deprecated.badge}
                      </span>
                    )}
                    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${
                      isLive ? "bg-green-400/10 text-green-400" : isUpcoming ? "bg-yellow-400/10 text-yellow-400" : "bg-gray-400/10 text-gray-400"
                    }`}>
                      {isLive && <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
                      {isCountdown ? <Countdown target={campaignStart} /> : statusLabel}
                    </span>
                    <span className="inline-flex items-center gap-1 text-xs text-[var(--muted-foreground)]">
                      <Image src="/tokens/crvusd.png" alt="crvUSD" width={14} height={14} className="rounded-full" />
                      crvUSD rewards
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap text-sm text-[var(--muted-foreground)] mb-5">
                <span>
                  {ycvxDeprecated
                    ? "Existing positions and claims remain available. New ycvxCRV deposits and LlamaLend loans are hidden."
                    : "Earn crvUSD by borrowing against ycvxCRV. The more you borrow, the more you earn."}
                </span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-[var(--muted)] text-[var(--foreground)] mono">
                  <Clock className="w-3 h-3" />
                  {startDate} → {endDate}
                </span>
              </div>

              {/* Steps */}
              <div className="mb-5">
                <div className="text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider mb-3">
                  {ycvxDeprecated ? "Available actions" : "How to become eligible"}
                </div>
                <div className="space-y-3">
                  <Link href="/vaults/ycvxcrv" className="flex items-start gap-3 group">
                    {hasYcvxcrv ? (
                      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-green-400/20 flex items-center justify-center">
                        <Check className="w-3.5 h-3.5 text-green-400" />
                      </span>
                    ) : (
                      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[var(--muted)] flex items-center justify-center text-xs font-medium">
                        1
                      </span>
                    )}
                    <div className="flex-1">
                      <div className="text-sm font-medium group-hover:text-[var(--accent)] transition-colors flex items-center gap-1.5">
                        {ycvxDeprecated ? "Exchange ycvxCRV for yscvxCRV" : "Deposit cvxCRV into the ycvxCRV vault"}
                        <ArrowUpRight className="w-3 h-3" />
                      </div>
                      <div className="text-xs text-[var(--muted-foreground)]">
                        {ycvxDeprecated
                          ? "yscvxCRV keeps staked cvxCRV exposure without the LlamaLend yield route."
                          : "Deposit cvxCRV to receive ycvxCRV yield-bearing vault tokens."}
                      </div>
                    </div>
                  </Link>
                  {ycvxDeprecated && !hasBorrowPosition ? (
                    <div className="flex items-start gap-3">
                      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-yellow-500/15 flex items-center justify-center">
                        <AlertTriangle className="w-3.5 h-3.5 text-yellow-500" />
                      </span>
                      <div className="flex-1">
                        <div className="text-sm font-medium text-yellow-500">
                          New ycvxCRV loans are disabled
                        </div>
                        <div className="text-xs text-[var(--muted-foreground)]">
                          Holders without an existing LlamaLend position can withdraw or exchange to yscvxCRV, but cannot open a new borrow position.
                        </div>
                      </div>
                    </div>
                  ) : (
                    <Link href="/vaults/ycvxcrv/lending" className="flex items-start gap-3 group">
                      {hasBorrowPosition ? (
                        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-green-400/20 flex items-center justify-center">
                          <Check className="w-3.5 h-3.5 text-green-400" />
                        </span>
                      ) : (
                        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[var(--muted)] flex items-center justify-center text-xs font-medium">
                          2
                        </span>
                      )}
                      <div className="flex-1">
                        <div className="text-sm font-medium group-hover:text-[var(--accent)] transition-colors flex items-center gap-1.5">
                          {ycvxDeprecated ? "Manage existing LlamaLend loan" : "Open a LlamaLend loan and borrow crvUSD"}
                          <ArrowUpRight className="w-3 h-3" />
                        </div>
                        <div className="text-xs text-[var(--muted-foreground)]">
                          {ycvxDeprecated
                            ? "Repay, close, or manage collateral for your existing ycvxCRV position."
                            : "Use your ycvxCRV as collateral to borrow crvUSD. The more you borrow, the more you earn."}
                        </div>
                      </div>
                    </Link>
                  )}
                </div>
              </div>
            </div>
            {isConnected && isEarning && isUpcoming && (
              <div className="border-t border-yellow-400/20 bg-yellow-400/5 px-5 py-3">
                <div className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-yellow-400" />
                  <span className="text-sm text-yellow-400">You&apos;re all set — rewards will start accumulating when the campaign goes live</span>
                </div>
              </div>
            )}
            {isConnected && isEarning && isLive && (
              <div className="border-t border-green-400/20 bg-green-400/5 px-5 py-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                    <span className="text-xs font-medium text-green-400 uppercase tracking-wider">Active Rewards</span>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-[var(--muted-foreground)]">Your earnings</span>
                    <span className="font-medium mono text-green-400">
                      {totalClaimableUsd + totalPendingUsd > 0 ? formatUsd(totalClaimableUsd + totalPendingUsd) : "$0.00"}
                    </span>
                    {totalClaimableUsd > 0 && totalPendingUsd > 0 && (
                      <span className="text-xs text-[var(--muted-foreground)]">
                        ({formatUsd(totalClaimableUsd)} claimable)
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
          </>);
          })()}
        </div>

        {/* Divider */}
        <div className="mb-8">
          <h2 className="text-sm font-medium text-[var(--muted-foreground)] uppercase tracking-wider">
            Your Rewards
          </h2>
        </div>

        {!isConnected ? (
          <div className="border border-[var(--border)] rounded-lg p-12 text-center">
            <Gift className="w-10 h-10 mx-auto mb-4 text-[var(--muted-foreground)]" />
            <p className="text-[var(--muted-foreground)] mb-4">
              Connect your wallet to view rewards
            </p>
            <CustomConnectButton />
          </div>
        ) : isLoading ? (
          <div className="border border-[var(--border)] rounded-lg p-12 text-center">
            <LoadingDots />
            <p className="text-sm text-[var(--muted-foreground)] mt-2">
              Fetching rewards...
            </p>
          </div>
        ) : error ? (
          <div className="border border-[var(--border)] rounded-lg p-12 text-center">
            <p className="text-[var(--destructive)]">
              Failed to load rewards. Please try again later.
            </p>
          </div>
        ) : rewards.length === 0 ? (
          <div className="border border-[var(--border)] rounded-lg p-12 text-center">
            <Gift className="w-10 h-10 mx-auto mb-4 text-[var(--muted-foreground)]" />
            <p className="text-[var(--muted-foreground)]">
              No rewards found for this wallet.
            </p>
          </div>
        ) : (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 gap-4 mb-8">
              <div className="border border-[var(--border)] rounded-lg p-5">
                <div className="text-sm text-[var(--muted-foreground)] mb-1">Claimable</div>
                <div className="text-2xl font-semibold mono text-green-400">
                  {formatUsd(totalClaimableUsd)}
                </div>
              </div>
              <div className="border border-[var(--border)] rounded-lg p-5">
                <div className="text-sm text-[var(--muted-foreground)] mb-1 flex items-center gap-1">
                  <Clock className="w-3 h-3" /> Pending
                </div>
                <div className="text-2xl font-semibold mono">
                  {formatUsd(totalPendingUsd)}
                </div>
              </div>
            </div>

            {/* Reward rows */}
            <div className="space-y-3">
              {rewards.map((reward) => (
                <RewardRow key={`${reward.token.address}-${reward.distributionChainId}`} reward={reward} />
              ))}
            </div>

          </>
        )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
