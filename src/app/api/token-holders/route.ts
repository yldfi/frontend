import { NextRequest, NextResponse } from "next/server";
import { RPC_TIMEOUT_MS, RPC_URL_LIST } from "@/config/rpc";

export const dynamic = "force-dynamic";

const TOKEN_HOLDER_API_KEY = process.env.TOKEN_HOLDER_API_KEY || "";
const BLOCKSCOUT_API_BASE = "https://eth.blockscout.com/api/v2";

// Cache: token address -> { holders, timestamp }
const holdersCache = new Map<string, { holders: string[]; timestamp: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

import { createRateLimiter, getClientIp } from "@/lib/rate-limit";

const isRateLimited = createRateLimiter(30);

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

interface BlockscoutHolder {
  address: { hash: string; is_contract: boolean };
  value: string;
}

interface BlockscoutResponse {
  items?: BlockscoutHolder[];
}

/**
 * Check if an address is an EOA (not a contract) by checking code size
 */
async function isEOA(address: string, rpcUrls: string[]): Promise<boolean> {
  for (const rpcUrl of rpcUrls) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getCode",
          params: [address, "latest"],
        }),
      });
      if (!response.ok) continue;
      const data = (await response.json()) as { result?: string };
      // EOA has no code (0x or 0x0)
      return !data.result || data.result === "0x" || data.result === "0x0";
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Fetch token holders from Blockscout API
 */
async function fetchFromBlockscout(
  token: string,
  minBalance: bigint,
  maxHolders: number
): Promise<string[]> {
  const url = `${BLOCKSCOUT_API_BASE}/tokens/${token}/holders`;

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Blockscout API error: ${response.status}`);
  }

  const data = (await response.json()) as BlockscoutResponse;
  const holders: string[] = [];

  // Use public RPCs with fallback for EOA checks
  const rpcUrls = process.env.DEBUG_RPC_URL
    ? [process.env.DEBUG_RPC_URL, ...RPC_URL_LIST]
    : [...RPC_URL_LIST];

  for (const item of data.items || []) {
    if (holders.length >= maxHolders) break;

    const address = item.address?.hash;
    if (!address) continue;

    if (BigInt(item.value || "0") < minBalance) continue;

    // Skip if Blockscout flags it as a contract
    if (item.address.is_contract) continue;

    // Double-check it's an EOA
    const isEoa = await isEOA(address, rpcUrls);
    if (!isEoa) continue;

    holders.push(address.toLowerCase());
  }

  return holders;
}

export async function POST(request: NextRequest) {
  // Auth check
  const apiKey = request.headers.get("x-api-key");
  if (!TOKEN_HOLDER_API_KEY || !apiKey || !timingSafeEqual(apiKey, TOKEN_HOLDER_API_KEY)) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  // Rate limiting
  const clientIp = getClientIp(request);
  if (isRateLimited(clientIp)) {
    return NextResponse.json(
      { success: false, error: "Rate limit exceeded" },
      { status: 429 }
    );
  }

  // Parse request
  let body: {
    token?: string;
    minBalance?: string;
    maxHolders?: number;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  if (!body.token || !body.token.match(/^0x[a-fA-F0-9]{40}$/)) {
    return NextResponse.json(
      { success: false, error: "Invalid token address" },
      { status: 400 }
    );
  }

  const token = body.token.toLowerCase();
  const minBalance = BigInt(body.minBalance || "0");
  const maxHolders = Math.min(body.maxHolders || 5, 20); // Cap at 20

  // Check cache
  const cacheKey = `${token}:${minBalance.toString()}`;
  const cached = holdersCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return NextResponse.json({
      success: true,
      holders: cached.holders.slice(0, maxHolders),
      cached: true,
      cacheAge: Math.floor((now - cached.timestamp) / 1000),
    });
  }

  // Fetch from Blockscout
  try {
    const holders = await fetchFromBlockscout(token, minBalance, maxHolders);

    // Update cache
    holdersCache.set(cacheKey, { holders, timestamp: now });

    return NextResponse.json({
      success: true,
      holders,
      cached: false,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to fetch holders",
      },
      { status: 502 }
    );
  }
}

// GET for health check
export async function GET() {
  return NextResponse.json({
    status: "ok",
    configured: Boolean(TOKEN_HOLDER_API_KEY),
  });
}
