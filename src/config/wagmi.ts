import { http, fallback, unstable_connector } from "wagmi";
import type { Chain } from "viem";
import { mainnet } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";

// Tenderly Virtual TestNet for testing (chain ID 1337)
// This is a mainnet fork so all contracts are available
// Configure your wallet (MetaMask) to use the Tenderly RPC URL
const tenderlyFork: Chain = {
  id: 1337,
  name: "Tenderly Fork",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://virtual.mainnet.rpc.tenderly.co"] },
  },
  blockExplorers: {
    default: { name: "Tenderly", url: "https://dashboard.tenderly.co" },
  },
};

// RPC endpoints with fallbacks for reliability
// First try the user's wallet RPC (MetaMask uses Infura, etc.)
// Then fall back to public RPCs if needed
const mainnetTransport = fallback([
  unstable_connector(injected),
  http("https://eth.llamarpc.com"),
  http("https://eth.drpc.org"),
  http("https://cloudflare-eth.com"),
  http(), // Default RPC as last fallback
]);

// Tenderly transport - use wallet's configured RPC (injected connector)
// This ensures we use the same RPC the user configured in MetaMask
const tenderlyTransport = fallback([
  unstable_connector(injected),
  http(), // Fallback to chain's default RPC
]);

// Include Tenderly fork in development mode only
// Use optional chaining to avoid errors in edge runtimes
const isDev = typeof process !== "undefined" && process.env?.NODE_ENV === "development";
const chains = isDev ? [mainnet, tenderlyFork] as const : [mainnet] as const;

export const config = getDefaultConfig({
  appName: "yld_fi",
  projectId: (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID) || "demo",
  chains,
  transports: {
    [mainnet.id]: mainnetTransport,
    ...(isDev && { [tenderlyFork.id]: tenderlyTransport }),
  },
  ssr: true,
});

export const supportedChains = chains;

// Public RPC URLs for direct fetch calls (e.g., eth_call for price queries)
export const PUBLIC_RPC_URLS = {
  llamarpc: "https://eth.llamarpc.com",
  drpc: "https://eth.drpc.org",
  cloudflare: "https://cloudflare-eth.com",
} as const;
