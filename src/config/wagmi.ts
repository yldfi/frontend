import { http, fallback } from "wagmi";
import { mainnet } from "wagmi/chains";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";

// RPC endpoints with fallbacks for reliability
// Primary: Cloudflare's public gateway, then PublicNode, then Ankr
const mainnetTransport = fallback([
  http("https://cloudflare-eth.com"),
  http("https://ethereum-rpc.publicnode.com"),
  http("https://rpc.ankr.com/eth"),
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
