import { http, fallback, unstable_connector } from "wagmi";
import { mainnet } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";

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

export const config = getDefaultConfig({
  appName: "yld_fi",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "demo",
  chains: [mainnet],
  transports: {
    [mainnet.id]: mainnetTransport,
  },
  ssr: true,
});

export const supportedChains = [mainnet];
