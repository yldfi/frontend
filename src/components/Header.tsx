"use client";

import Link from "next/link";
import { Gift } from "lucide-react";
import { useAccount } from "wagmi";
import { formatUnits } from "viem";
import { Logo } from "@/components/Logo";
import { CustomConnectButton } from "@/components/CustomConnectButton";
import { useMerklRewards } from "@/hooks/useMerklRewards";
import { formatUsd } from "@/lib/utils";

export function Header() {
  const { address } = useAccount();
  const { data: merklData } = useMerklRewards(1);
  const rewards = merklData?.flatMap((d) => d.rewards) ?? [];

  // Calculate total claimable (amount - claimed) + pending
  const totalClaimable = rewards.reduce((sum, r) => {
    const claimable = BigInt(r.amount) - BigInt(r.claimed);
    const pending = BigInt(r.pending);
    const total = claimable > 0n ? claimable : pending;
    const price = r.token.price ?? 1; // crvUSD ≈ $1
    return sum + parseFloat(formatUnits(total, r.token.decimals)) * price;
  }, 0);

  const isEarning = address && totalClaimable > 0;

  return (
    <header
      className="fixed left-0 right-0 z-50 border-b border-[var(--border)] backdrop-blur-lg bg-[var(--background)]/80"
      style={{ top: "var(--test-banner-height)" }}
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <Logo size={28} />
          <span className="mono text-lg font-medium tracking-tight leading-none">
            yld
          </span>
        </Link>

        <div className="flex items-center gap-4">
          <Link
            href="/rewards"
            className={`flex items-center gap-1.5 text-sm transition-colors ${
              isEarning
                ? "text-green-400 hover:text-green-300"
                : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            }`}
          >
            <Gift className="w-4 h-4" />
            {isEarning ? formatUsd(totalClaimable) : "Rewards"}
          </Link>
          <CustomConnectButton />
        </div>
      </div>
    </header>
  );
}
