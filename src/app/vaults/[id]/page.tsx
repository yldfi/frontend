"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import { use } from "react";

// Dynamic import with SSR disabled to avoid Turbopack bundling wagmi/rainbowkit during SSR
// These libraries pull in pino/thread-stream which have problematic test files
const VaultPageContent = dynamic(
  () => import("@/components/VaultPageContent").then((mod) => mod.VaultPageContent),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-screen bg-[var(--background)] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[var(--muted-foreground)]" />
      </div>
    ),
  }
);

export default function VaultPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <VaultPageContent id={id} />;
}
