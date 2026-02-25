"use client";

import dynamic from "next/dynamic";
import { LoadingDots } from "@/components/LoadingDots";

// Dynamic import with SSR disabled to avoid Turbopack bundling wagmi/rainbowkit during SSR
// These libraries pull in pino/thread-stream which have problematic test files
const HomePageContent = dynamic(
  () => import("@/components/HomePageContent").then((mod) => mod.HomePageContent),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-screen bg-[var(--background)] flex items-center justify-center text-lg">
        <LoadingDots />
      </div>
    ),
  }
);

export default function Home() {
  return <HomePageContent />;
}
