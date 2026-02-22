"use client";

import dynamic from "next/dynamic";
import { use, Suspense } from "react";

function LoadingDots() {
  return (
    <span className="inline-flex items-center gap-0.5 text-[var(--muted-foreground)]">
      <span className="animate-bounce" style={{ animationDelay: "0ms", animationDuration: "600ms" }}>.</span>
      <span className="animate-bounce" style={{ animationDelay: "150ms", animationDuration: "600ms" }}>.</span>
      <span className="animate-bounce" style={{ animationDelay: "300ms", animationDuration: "600ms" }}>.</span>
    </span>
  );
}

const loadingFallback = (
  <div className="min-h-screen bg-[var(--background)] flex items-center justify-center text-lg">
    <LoadingDots />
  </div>
);

// Dynamic import with SSR disabled to avoid Turbopack bundling wagmi/rainbowkit during SSR
const LendingPageContent = dynamic(
  () => import("@/components/lending/LendingPageContent").then((mod) => mod.LendingPageContent),
  {
    ssr: false,
    loading: () => loadingFallback,
  }
);

function LendingPageInner({ id }: { id: string }) {
  return <LendingPageContent vaultId={id} />;
}

export default function LendingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <Suspense fallback={loadingFallback}>
      <LendingPageInner id={id} />
    </Suspense>
  );
}
