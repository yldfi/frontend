import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Initialize Cloudflare bindings for local development
initOpenNextCloudflareForDev();

const nextConfig: NextConfig = {
  images: {
    unoptimized: true,
  },
  // Optimize barrel file imports for faster dev boot and smaller bundles
  experimental: {
    optimizePackageImports: ["lucide-react", "@rainbow-me/rainbowkit"],
  },
  // Safe{Wallet} fetches the Safe App manifest cross-origin. In production the
  // file is served from Cloudflare static assets, which use public/_headers;
  // this covers `next dev` and any request that reaches the worker.
  async headers() {
    return [
      {
        source: "/manifest.json",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET" },
          { key: "Access-Control-Allow-Headers", value: "X-Requested-With, content-type, Authorization" },
        ],
      },
    ];
  },
  // Silence Turbopack warning about webpack config without turbopack config
  turbopack: {},
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
