import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const MORALIS_API_KEY = process.env.MORALIS_API_KEY || "";
const TOKEN_HOLDER_API_KEY = process.env.TOKEN_HOLDER_API_KEY || "";

// Cache: token address -> { holders, timestamp }
const holdersCache = new Map<string, { holders: string[]; timestamp: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Rate limiting
const MAX_REQUESTS_PER_MINUTE = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const requestLog = new Map<string, number[]>();

function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function isRateLimited(clientIp: string): boolean {
  const now = Date.now();
  const entries = requestLog.get(clientIp) ?? [];
  const recent = entries.filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= MAX_REQUESTS_PER_MINUTE) {
    requestLog.set(clientIp, recent);
    return true;
  }
  recent.push(now);
  requestLog.set(clientIp, recent);
  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

interface MoralisHolder {
  owner_address: string;
  balance: string;
  is_contract: boolean;
}

interface MoralisResponse {
  result?: MoralisHolder[];
}

/**
 * Check if an address is an EOA (not a contract) by checking code size
 */
async function isEOA(address: string, rpcUrl: string): Promise<boolean> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getCode",
        params: [address, "latest"],
      }),
    });
    const data = (await response.json()) as { result?: string };
    // EOA has no code (0x or 0x0)
    return !data.result || data.result === "0x" || data.result === "0x0";
  } catch {
    return false;
  }
}

/**
 * Fetch token holders from Moralis API
 */
async function fetchFromMoralis(
  token: string,
  minBalance: bigint,
  maxHolders: number
): Promise<string[]> {
  if (!MORALIS_API_KEY) {
    return [];
  }

  const url = `https://deep-index.moralis.io/api/v2.2/erc20/${token}/owners?chain=eth&limit=50&order=DESC`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-API-Key": MORALIS_API_KEY,
    },
  });

  if (!response.ok) {
    throw new Error(`Moralis API error: ${response.status}`);
  }

  const data = (await response.json()) as MoralisResponse;
  const holders: string[] = [];

  // Use public RPC for EOA checks
  const rpcUrl = process.env.DEBUG_RPC_URL || "https://eth.llamarpc.com";

  for (const holder of data.result || []) {
    if (holders.length >= maxHolders) break;

    const balance = BigInt(holder.balance);
    if (balance < minBalance) continue;

    // Skip if Moralis says it's a contract
    if (holder.is_contract) continue;

    // Double-check it's an EOA
    const isEoa = await isEOA(holder.owner_address, rpcUrl);
    if (!isEoa) continue;

    holders.push(holder.owner_address.toLowerCase());
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

  // Check Moralis config
  if (!MORALIS_API_KEY) {
    return NextResponse.json(
      { success: false, error: "Moralis API not configured" },
      { status: 500 }
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

  // Fetch from Moralis
  try {
    const holders = await fetchFromMoralis(token, minBalance, maxHolders);

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
    configured: Boolean(MORALIS_API_KEY && TOKEN_HOLDER_API_KEY),
  });
}
