"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider, darkTheme, AvatarComponent } from "@rainbow-me/rainbowkit";
import { config } from "@/config/wagmi";
import { useState } from "react";
import { AnalyticsProvider } from "@/components/AnalyticsProvider";

import "@rainbow-me/rainbowkit/styles.css";

// Custom avatar to avoid ENS avatar CORS issues with euc.li
const CustomAvatar: AvatarComponent = ({ address, size }) => {
  // Generate a consistent color from the address
  const color = `#${address.slice(2, 8)}`;
  const color2 = `#${address.slice(-6)}`;

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: `linear-gradient(135deg, ${color} 0%, ${color2} 100%)`,
      }}
    />
  );
};

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
          },
        },
      })
  );

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: "#00f0ff",
            accentColorForeground: "#0a0b0f",
            borderRadius: "medium",
            fontStack: "system",
            overlayBlur: "small",
          })}
          modalSize="compact"
          avatar={CustomAvatar}
        >
          <AnalyticsProvider>{children}</AnalyticsProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
