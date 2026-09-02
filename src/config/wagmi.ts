import { createConfig, http, fallback, unstable_connector, custom } from "wagmi";
import { mainnet } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import {
  connectorsForWallets,
  getDefaultWallets,
} from "@rainbow-me/rainbowkit";
import { PUBLIC_RPC_URLS } from "./rpc";
import { installActiveConnectorGuard } from "@/lib/wallet-connection-guard";

// Anvil fork RPC for local testing (set NEXT_PUBLIC_ANVIL_RPC=http://127.0.0.1:8545)
// NOTE: use process.env.X (not process.env?.X) so Next.js DefinePlugin inlines it in the browser bundle
const anvilRpc: string | undefined = process.env.NEXT_PUBLIC_ANVIL_RPC || undefined;

// Tenderly VNet RPC for dev-mode toggle (only in development)
const vnetRpc: string | undefined = process.env.NODE_ENV === "development"
  ? (process.env.NEXT_PUBLIC_TENDERLY_VNET_RPC || undefined)
  : undefined;

// Normal transport chain (used as fallback or when VNet is off)
// When Anvil is set, use it exclusively — no mainnet fallback that would silently
// return wrong state (mainnet balances, different contract storage, etc.)
const normalTransport = anvilRpc
  ? http(anvilRpc)
  : fallback([
      http(PUBLIC_RPC_URLS.publicnode),
      http(PUBLIC_RPC_URLS.onerpc),
      http(PUBLIC_RPC_URLS.payload),
      http(PUBLIC_RPC_URLS.drpc),
      unstable_connector(injected),
    ]);

// Switchable transport: checks localStorage on every request to route to VNet or normal RPC.
// Only created when VNet RPC is configured AND Anvil is not (Anvil takes priority).
const mainnetTransport = (vnetRpc && !anvilRpc)
  ? (() => {
      const vnetTransport = http(vnetRpc);
      return custom({
        async request({ method, params }) {
          const useVNet = typeof window !== "undefined"
            && localStorage.getItem("yldfi-vnet-enabled") === "true";
          const transport = useVNet
            ? vnetTransport({ chain: mainnet })
            : normalTransport({ chain: mainnet });
          return transport.request({ method, params });
        },
      });
    })()
  : normalTransport;

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

installActiveConnectorGuard(config);

export const supportedChains = [mainnet] as const;

// Re-export PUBLIC_RPC_URLS for backwards compatibility
// Prefer importing from @/config/rpc directly to avoid wagmi initialization side effects
export { PUBLIC_RPC_URLS } from "./rpc";
