"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import { use, Suspense } from "react";

// Dynamic import with SSR disabled to avoid Turbopack bundling wagmi/rainbowkit during SSR
const LendingPageContent = dynamic(
  () => import("@/components/lending/LendingPageContent").then((mod) => mod.LendingPageContent),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-screen bg-[var(--background)] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[var(--muted-foreground)]" />
      </div>
    ),
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
    <Suspense fallback={
      <div className="min-h-screen bg-[var(--background)] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[var(--muted-foreground)]" />
      </div>
    }>
      <LendingPageInner id={id} />
    </Suspense>
  );
}
