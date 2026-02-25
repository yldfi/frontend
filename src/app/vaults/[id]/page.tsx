"use client";

import dynamic from "next/dynamic";
import { use } from "react";
import { LoadingDots } from "@/components/LoadingDots";

// Dynamic import with SSR disabled to avoid Turbopack bundling wagmi/rainbowkit during SSR
// These libraries pull in pino/thread-stream which have problematic test files
const VaultPageContent = dynamic(
  () => import("@/components/VaultPageContent").then((mod) => mod.VaultPageContent),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-screen bg-[var(--background)] flex items-center justify-center text-lg">
        <LoadingDots />
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
