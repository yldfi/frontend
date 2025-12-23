import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Initialize Cloudflare bindings for local development
initOpenNextCloudflareForDev();

const nextConfig: NextConfig = {
  images: {
    unoptimized: true,
  },
  webpack: (config) => {
    // Fix warnings from third-party packages that include optional/unused dependencies
    config.resolve.fallback = {
      ...config.resolve.fallback,
      // MetaMask SDK includes React Native code paths not used in web
      "@react-native-async-storage/async-storage": false,
      // pino-pretty is optional dev dependency for WalletConnect's logger
      "pino-pretty": false,
    };
    return config;
  },
};

export default nextConfig;
