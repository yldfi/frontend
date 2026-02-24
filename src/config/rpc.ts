// Public RPC URLs for Ethereum mainnet (no API keys required)
// Privacy-only: all RPCs below are "tracking: none" per DefiLlama chainlist
// Source: https://github.com/DefiLlama/chainlist/blob/main/constants/extraRpcs.js

export const PUBLIC_RPC_URLS = {
  drpc: "https://eth.drpc.org",
  publicnode: "https://ethereum-rpc.publicnode.com",
  onerpc: "https://1rpc.io/eth",
  mevblocker: "https://rpc.mevblocker.io",
  payload: "https://rpc.payload.de",
  meowrpc: "https://eth.meowrpc.com",
  securerpc: "https://api.securerpc.com/v1",
} as const;

// Array format for fallback chains
export const RPC_URL_LIST = Object.values(PUBLIC_RPC_URLS);

// Flashbots Protect RPC - submits to private mempool to prevent MEV attacks
// https://docs.flashbots.net/flashbots-protect/rpc/quick-start
export const FLASHBOTS_RPC_URL = "https://rpc.flashbots.net" as const;

// --- Dynamic RPC list from chainid.network ---
// Fetched in background on first use, cached in memory for 1 hour.
// Only RPCs from known no-tracking providers are accepted.

// Domains verified as tracking: "none" in DefiLlama chainlist
const PRIVACY_SAFE_DOMAINS = new Set([
  "eth.drpc.org",
  "ethereum-rpc.publicnode.com",
  "1rpc.io",
  "rpc.mevblocker.io",
  "rpc.flashbots.net",
  "rpc.payload.de",
  "eth.meowrpc.com",
  "api.securerpc.com",
  "rpc.builder0x69.io",
]);

let dynamicRpcs: string[] = [];
let dynamicFetchPromise: Promise<void> | null = null;
let dynamicFetchedAt = 0;
const DYNAMIC_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchChainlistRpcs(): Promise<string[]> {
  try {
    const res = await fetch("https://chainid.network/chains.json", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const chains = (await res.json()) as Array<{
      chainId: number;
      rpc: string[];
    }>;
    const eth = chains.find((c) => c.chainId === 1);
    if (!eth) return [];
    // HTTPS only, no WebSocket, no template vars, privacy-safe domains only
    return eth.rpc.filter((url) => {
      if (!url.startsWith("https://")) return false;
      if (url.includes("${") || url.includes("wss://")) return false;
      try {
        const hostname = new URL(url).hostname;
        return PRIVACY_SAFE_DOMAINS.has(hostname);
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function ensureDynamicRpcsFetched(): void {
  const now = Date.now();
  // Refetch after cache TTL expires
  if (dynamicFetchPromise && now - dynamicFetchedAt < DYNAMIC_CACHE_TTL) return;
  dynamicFetchPromise = fetchChainlistRpcs().then((urls) => {
    if (urls.length > 0) {
      dynamicRpcs = urls;
      dynamicFetchedAt = Date.now();
    }
  });
}

/**
 * Get all available RPC URLs: hardcoded privacy RPCs first, then any dynamic
 * ones from chainid.network (filtered to privacy-safe domains).
 * First call triggers a background fetch; result available on next call.
 */
export function getAllRpcUrls(): string[] {
  ensureDynamicRpcsFetched();
  if (dynamicRpcs.length === 0) return [...RPC_URL_LIST];
  const hardcoded = new Set(RPC_URL_LIST.map((u) => u.replace(/\/$/, "")));
  const extra = dynamicRpcs.filter(
    (url) => !hardcoded.has(url.replace(/\/$/, "")),
  );
  return [...RPC_URL_LIST, ...extra];
}
