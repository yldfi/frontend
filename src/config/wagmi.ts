import { http, fallback } from "wagmi";
import { mainnet } from "wagmi/chains";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";

// RPC endpoints with fallbacks for reliability
// LlamaNodes and dRPC have better caching behavior for tx receipts
const mainnetTransport = fallback([
  http("https://eth.llamarpc.com"),
  http("https://eth.drpc.org"),
  http("https://cloudflare-eth.com"),
  http("https://ethereum-rpc.publicnode.com"),
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
