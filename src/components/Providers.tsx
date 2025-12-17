"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider, darkTheme, AvatarComponent } from "@rainbow-me/rainbowkit";
import { useEnsName } from "wagmi";
import { config } from "@/config/wagmi";
import { useState } from "react";
import { AnalyticsProvider } from "@/components/AnalyticsProvider";

import "@rainbow-me/rainbowkit/styles.css";

// Custom avatar that uses our CORS proxy for ENS avatars
// We intentionally ignore RainbowKit's ensImage prop to avoid CORS errors
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const CustomAvatar: AvatarComponent = ({ address, ensImage: _ensImage, size }) => {
  const { data: ensName } = useEnsName({ address: address as `0x${string}`, chainId: 1 });
  const [error, setError] = useState(false);

  // Always use our CORS proxy - ignore RainbowKit's ensImage to avoid CORS errors
  const avatarUrl = ensName ? `/api/avatar/${ensName}` : null;

  // Fallback gradient based on address
  const color1 = `#${address.slice(2, 8)}`;
  const color2 = `#${address.slice(-6)}`;

  if (error || !avatarUrl) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: `linear-gradient(135deg, ${color1} 0%, ${color2} 100%)`,
        }}
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={avatarUrl}
      alt="ENS Avatar"
      width={size}
      height={size}
      style={{ borderRadius: "50%" }}
      onError={() => setError(true)}
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
