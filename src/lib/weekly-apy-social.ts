import { VAULT_ADDRESSES } from "@/config/vaults";
import { RPC_TIMEOUT_MS, getAllRpcUrls } from "@/config/rpc";

const KONG_API_URL = "https://kong.yearn.farm/api/gql";

const WEEKLY_APY_QUERY = `
  query WeeklyApy($chainId: Int, $address: String) {
    vault(chainId: $chainId, address: $address) {
      address
      symbol
      apy {
        weeklyNet
      }
    }
  }
`;

const KONG_HEADERS: HeadersInit = {
  "content-type": "application/json",
  accept: "application/json",
  "user-agent": "yldfi/1.0 (+https://yldfi.co)",
};

export interface WeeklyApyVault {
  address: `0x${string}`;
  icon: string;
  label: string;
  protocolLogo: string;
  symbol: string;
  symbolPrefix: string;
  symbolSuffix: string;
  underlying: string;
  weeklyApy: number;
  weeklyApyFormatted: string;
}

interface KongVaultResponse {
  data?: {
    vault?: {
      address: string;
      symbol: string;
      apy?: {
        weeklyNet?: number | null;
      } | null;
    } | null;
  };
  errors?: unknown[];
}

const WEEKLY_APY_VAULTS = [
  {
    address: VAULT_ADDRESSES.YSCVXCRV,
    icon: "/yscvxcrv-128.png",
    label: "Convex Finance",
    protocolLogo: "/tokens/convex.png",
    symbol: "yscvxCRV",
    symbolPrefix: "ys",
    symbolSuffix: "cvxCRV",
    underlying: "cvxCRV",
    source: "kong",
  },
  {
    address: VAULT_ADDRESSES.YSCVX,
    icon: "/yscvx-128.png",
    label: "Convex Finance",
    protocolLogo: "/tokens/convex.png",
    symbol: "ysCVX",
    symbolPrefix: "ys",
    symbolSuffix: "CVX",
    underlying: "CVX",
    // Standalone strategy with no Yearn allocator vault, so Kong does not
    // index it (vault query returns null). Read the share price on-chain.
    source: "onchain",
  },
] as const;

type WeeklyApyVaultConfig = (typeof WEEKLY_APY_VAULTS)[number];

async function fetchKongWeeklyApy(vault: WeeklyApyVaultConfig): Promise<number> {
  const response = await fetch(KONG_API_URL, {
    method: "POST",
    headers: KONG_HEADERS,
    body: JSON.stringify({
      query: WEEKLY_APY_QUERY,
      variables: { chainId: 1, address: vault.address },
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${vault.symbol} weekly APY: ${response.status}`);
  }

  const result = (await response.json()) as KongVaultResponse;
  if (result.errors?.length || !result.data?.vault) {
    throw new Error(`Kong returned no vault data for ${vault.symbol}`);
  }

  return (result.data.vault.apy?.weeklyNet ?? 0) * 100;
}

// ~7 days of 12s mainnet slots.
const BLOCKS_PER_WEEK = 50_400n;
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
// convertToAssets(1e18)
const CONVERT_TO_ASSETS_1E18 =
  "0x07a2d13a0000000000000000000000000000000000000000000000000de0b6b3a7640000";

interface RpcResponse<T> {
  result?: T;
  error?: { message?: string };
}

/**
 * JSON-RPC call with fallback across the public RPC list. A JSON-RPC error
 * (e.g. a non-archive node refusing historical state) moves on to the next
 * URL instead of being treated as a result.
 */
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let lastError: unknown;
  for (const url of getAllRpcUrls()) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        cache: "no-store",
      });
      if (!response.ok) {
        lastError = new Error(`${method} returned HTTP ${response.status}`);
        continue;
      }
      const body = (await response.json()) as RpcResponse<T>;
      if (body.error || body.result === undefined || body.result === null) {
        lastError = new Error(`${method} failed: ${body.error?.message ?? "empty result"}`);
        continue;
      }
      return body.result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${method} failed on all RPCs`);
}

async function getBlock(tag: string): Promise<{ number: bigint; timestamp: number }> {
  const block = await rpc<{ number: string; timestamp: string }>("eth_getBlockByNumber", [tag, false]);
  return { number: BigInt(block.number), timestamp: Number(BigInt(block.timestamp)) };
}

async function getSharePrice(vault: `0x${string}`, blockTag: string): Promise<bigint> {
  const hex = await rpc<string>("eth_call", [{ to: vault, data: CONVERT_TO_ASSETS_1E18 }, blockTag]);
  return BigInt(hex);
}

/**
 * Trailing 7-day net APY from the ERC-4626 share price, compounded and
 * annualised over the actual elapsed time between the two blocks.
 */
async function fetchOnchainWeeklyApy(vault: WeeklyApyVaultConfig): Promise<number> {
  const latest = await getBlock("latest");
  const pastTag = `0x${(latest.number - BLOCKS_PER_WEEK).toString(16)}`;
  const latestTag = `0x${latest.number.toString(16)}`;
  const [past, priceNow, pricePast] = await Promise.all([
    getBlock(pastTag),
    getSharePrice(vault.address, latestTag),
    getSharePrice(vault.address, pastTag),
  ]);

  const elapsed = latest.timestamp - past.timestamp;
  if (pricePast <= 0n || priceNow <= 0n || elapsed <= 0) {
    throw new Error(`Invalid on-chain share price data for ${vault.symbol}`);
  }

  const ratio = Number(priceNow) / Number(pricePast);
  const apy = (ratio ** (SECONDS_PER_YEAR / elapsed) - 1) * 100;
  if (!Number.isFinite(apy)) {
    throw new Error(`Non-finite on-chain weekly APY for ${vault.symbol}`);
  }
  return apy;
}

async function fetchVaultWeeklyApy(vault: WeeklyApyVaultConfig): Promise<WeeklyApyVault> {
  const weeklyApy = vault.source === "onchain"
    ? await fetchOnchainWeeklyApy(vault)
    : await fetchKongWeeklyApy(vault);
  return {
    ...vault,
    weeklyApy,
    weeklyApyFormatted: `${weeklyApy.toFixed(2)}%`,
  };
}

export async function fetchWeeklyApyVaults(): Promise<WeeklyApyVault[]> {
  // One vault's data source failing must not blank the whole card (9 Nov 2026:
  // Kong had no ysCVX record, the page threw and no post went out). Skip the
  // failed vault and log it; fail only when nothing can be shown.
  const results = await Promise.allSettled(WEEKLY_APY_VAULTS.map(fetchVaultWeeklyApy));
  const vaults: WeeklyApyVault[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      vaults.push(result.value);
    } else {
      console.error(`[weekly-apy] skipping ${WEEKLY_APY_VAULTS[i].symbol}:`, result.reason);
    }
  });
  if (vaults.length === 0) {
    throw new Error("No weekly APY data available for any vault");
  }
  return vaults.sort((a, b) => b.weeklyApy - a.weeklyApy);
}

export function formatSocialDate(date: Date): string {
  const day = Number(new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    timeZone: "UTC",
  }).format(date));
  const month = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    timeZone: "UTC",
  }).format(date);
  const year = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    year: "numeric",
  }).format(date);

  return `${day}${getOrdinalSuffix(day)} ${month} ${year}`;
}

export function parseSocialDate(value?: string | string[]): Date {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return new Date();

  const parsed = new Date(`${raw}T12:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function getOrdinalSuffix(day: number): string {
  const teen = day % 100;
  if (teen >= 11 && teen <= 13) return "th";

  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}
