// Public RPC URLs for direct fetch calls (e.g., eth_call for price queries)
// Separated from wagmi.ts to avoid triggering wagmi/RainbowKit initialization
// when imported in non-React contexts (scripts, tests, workers)

export const PUBLIC_RPC_URLS = {
  llamarpc: "https://eth.llamarpc.com",
  drpc: "https://eth.drpc.org",
  cloudflare: "https://cloudflare-eth.com",
} as const;

// Array format for fallback chains
export const RPC_URL_LIST = Object.values(PUBLIC_RPC_URLS);
