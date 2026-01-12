import { createConfig, http, fallback, unstable_connector } from "wagmi";
import { mainnet } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import {
  connectorsForWallets,
  getDefaultWallets,
} from "@rainbow-me/rainbowkit";
import { PUBLIC_RPC_URLS } from "./rpc";

// RPC endpoints with fallbacks for reliability
// First try the user's wallet RPC (MetaMask/Frame uses their configured RPC)
// Then fall back to public RPCs if needed
const mainnetTransport = fallback([
  unstable_connector(injected),
  http(PUBLIC_RPC_URLS.llamarpc),
  http(PUBLIC_RPC_URLS.drpc),
  http(PUBLIC_RPC_URLS.cloudflare),
  http(), // Default RPC as last fallback
]);

const projectId = (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID) || "demo";

// Get default wallets from RainbowKit
const { wallets: defaultWallets } = getDefaultWallets();

// Build connectors with wallets
const connectors = connectorsForWallets(defaultWallets, {
  appName: "yld_fi",
  projectId,
});

export const config = createConfig({
  chains: [mainnet],
  connectors,
  transports: {
    [mainnet.id]: mainnetTransport,
  },
  ssr: true,
});

export const supportedChains = [mainnet] as const;

// Re-export PUBLIC_RPC_URLS for backwards compatibility
// Prefer importing from @/config/rpc directly to avoid wagmi initialization side effects
export { PUBLIC_RPC_URLS } from "./rpc";
