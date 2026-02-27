"use client";

import dynamic from "next/dynamic";
import { type ReactNode } from "react";
import { CookieConsent } from "@/components/CookieConsent";
import { GoogleAnalytics } from "@/components/GoogleAnalytics";
import { BetaBanner } from "@/components/BetaBanner";
import { TestNetworkBanner } from "@/components/TestNetworkBanner";

const Providers = dynamic(
  () => import("@/components/Providers").then((mod) => mod.Providers),
  { ssr: false }
);

export function ClientProviders({ children }: { children: ReactNode }) {
  const gaId = process.env.NEXT_PUBLIC_GA_ID;

  return (
    <Providers>
      <BetaBanner />
      <TestNetworkBanner />
      {children}
      <CookieConsent />
      {gaId && <GoogleAnalytics gaId={gaId} />}
    </Providers>
  );
}
