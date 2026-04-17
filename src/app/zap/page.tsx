"use client";

import dynamic from "next/dynamic";
import { LoadingDots } from "@/components/LoadingDots";

const ZapPageContent = dynamic(
  () => import("@/components/ZapPageContent").then((mod) => mod.ZapPageContent),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-screen bg-[var(--background)] flex items-center justify-center text-lg">
        <LoadingDots />
      </div>
    ),
  }
);

export default function ZapPage() {
  return <ZapPageContent />;
}
