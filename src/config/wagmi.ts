import { createConfig, http, fallback, unstable_connector } from "wagmi";
import { mainnet } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import {
  connectorsForWallets,
  getDefaultWallets,
} from "@rainbow-me/rainbowkit";
import { PUBLIC_RPC_URLS } from "./rpc";

// Anvil fork RPC for local testing (set NEXT_PUBLIC_ANVIL_RPC=http://127.0.0.1:8545)
// NOTE: use process.env.X (not process.env?.X) so Next.js DefinePlugin inlines it in the browser bundle
const anvilRpc: string | undefined = process.env.NEXT_PUBLIC_ANVIL_RPC || undefined;

// RPC endpoints with fallbacks for reliability
// Public RPCs first for reliable reads; wallet RPC last as fallback
// (injected provider can hang indefinitely with no timeout, blocking all reads)
// CORS-friendly RPCs first (llamarpc blocks browser-origin requests)
// Wallet RPC last as fallback (injected provider can hang with no timeout)
const mainnetTransport = anvilRpc
  ? fallback([http(anvilRpc), http(PUBLIC_RPC_URLS.drpc)])
  : fallback([
      http(PUBLIC_RPC_URLS.drpc),
      http(PUBLIC_RPC_URLS.cloudflare),
      unstable_connector(injected),
      http(), // Default RPC as last fallback
    ]);

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "demo";

// Get default wallets from RainbowKit
const { wallets: defaultWallets } = getDefaultWallets();

// Build connectors with wallets
const connectors = connectorsForWallets(defaultWallets, {
  appName: "yld",
  projectId,
});

export const config = createConfig({
  chains: [mainnet],
  connectors,
  transports: {
    [mainnet.id]: mainnetTransport,
  },
  // Faster polling on Anvil fork (default 4000ms is too slow for auto-mine)
  ...(anvilRpc ? { pollingInterval: 1_000 } : {}),
  ssr: true,
});

export const supportedChains = [mainnet] as const;

// Re-export PUBLIC_RPC_URLS for backwards compatibility
// Prefer importing from @/config/rpc directly to avoid wagmi initialization side effects
export { PUBLIC_RPC_URLS } from "./rpc";
