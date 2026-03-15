"use client";

import dynamic from "next/dynamic";
import { LoadingDots } from "@/components/LoadingDots";

const RewardsPageContent = dynamic(
  () => import("@/components/RewardsPageContent").then((mod) => mod.RewardsPageContent),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-screen bg-[var(--background)] flex items-center justify-center text-lg">
        <LoadingDots />
      </div>
    ),
  }
);

export default function RewardsPage() {
  return <RewardsPageContent />;
}
