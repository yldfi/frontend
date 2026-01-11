import { createConfig, http, fallback, unstable_connector } from "wagmi";
import type { Chain } from "viem";
import { mainnet } from "wagmi/chains";
import { injected, mock } from "wagmi/connectors";
import {
  connectorsForWallets,
  getDefaultWallets,
  type Wallet,
} from "@rainbow-me/rainbowkit";

// Impersonation support for development/testing
// Set localStorage.setItem('impersonate', '0x...') to impersonate an address
// The "Impersonator" wallet will appear in the wallet list in dev mode
const IMPERSONATE_STORAGE_KEY = "impersonate";

function getImpersonateAddress(): `0x${string}` | null {
  if (typeof window === "undefined") return null;
  try {
    const addr = localStorage.getItem(IMPERSONATE_STORAGE_KEY);
    if (addr && /^0x[a-fA-F0-9]{40}$/.test(addr)) {
      return addr as `0x${string}`;
    }
  } catch {
    // localStorage not available
  }
  return null;
}

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

const projectId = (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID) || "demo";

// Create Impersonator wallet for dev testing
// Uses wagmi's mock connector to simulate any address
// Set localStorage.setItem('impersonate', '0x...') before connecting
const impersonatorWallet = (): Wallet => {
  return {
    id: "impersonator",
    name: "Impersonator",
    iconUrl: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM3YzNhZWQiIHN0cm9rZS13aWR0aD0iMiI+PGNpcmNsZSBjeD0iMTIiIGN5PSI4IiByPSI0Ii8+PHBhdGggZD0iTTQgMThjMC00IDQtNiA4LTZzOCAyIDggNiIvPjwvc3ZnPg==",
    iconBackground: "#7c3aed",
    installed: true,
    // No hidden function - always show in dev mode
    createConnector: () => {
      // Read address at connection time from localStorage
      const addr = getImpersonateAddress() || "0x0000000000000000000000000000000000000000";
      console.log("[Impersonator] Connecting as:", addr);
      return mock({
        accounts: [addr as `0x${string}`],
        features: {
          reconnect: true,
        },
      });
    },
  };
};

// Get default wallets from RainbowKit
const { wallets: defaultWallets } = getDefaultWallets();

// In dev mode, add Impersonator wallet group
// Log structure for debugging
if (typeof window !== "undefined" && isDev) {
  console.log("[wagmi] Default wallet groups:", defaultWallets.map(g => g.groupName));
}

const walletsConfig = isDev
  ? [
      // Add Impersonator as first group so it appears at top
      {
        groupName: "Dev Tools",
        wallets: [impersonatorWallet],
      },
      ...defaultWallets,
    ]
  : defaultWallets;

// Build connectors with wallets
const connectors = connectorsForWallets(walletsConfig, {
  appName: "yld_fi",
  projectId,
});

export const config = createConfig({
  chains,
  connectors,
  transports: {
    [mainnet.id]: mainnetTransport,
    ...(isDev && { [tenderlyFork.id]: tenderlyTransport }),
  },
  ssr: true,
});

// Export for use in components
export { IMPERSONATE_STORAGE_KEY };

export const supportedChains = chains;

// Re-export PUBLIC_RPC_URLS for backwards compatibility
// Prefer importing from @/config/rpc directly to avoid wagmi initialization side effects
export { PUBLIC_RPC_URLS } from "./rpc";
