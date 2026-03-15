"use client";

import Link from "next/link";
import { Gift } from "lucide-react";
import { Logo } from "@/components/Logo";
import { CustomConnectButton } from "@/components/CustomConnectButton";

export function Header() {
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
            className="flex items-center gap-1.5 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
          >
            <Gift className="w-4 h-4" />
            Rewards
          </Link>
          <CustomConnectButton />
        </div>
      </div>
    </header>
  );
}
