"use client";

import dynamic from "next/dynamic";
import { use } from "react";

function LoadingDots() {
  return (
    <span className="inline-flex items-center gap-0.5 text-[var(--muted-foreground)]">
      <span className="animate-bounce" style={{ animationDelay: "0ms", animationDuration: "600ms" }}>.</span>
      <span className="animate-bounce" style={{ animationDelay: "150ms", animationDuration: "600ms" }}>.</span>
      <span className="animate-bounce" style={{ animationDelay: "300ms", animationDuration: "600ms" }}>.</span>
    </span>
  );
}

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
