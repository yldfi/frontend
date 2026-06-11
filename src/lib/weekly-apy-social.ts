import { VAULT_ADDRESSES } from "@/config/vaults";

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
  },
  {
    address: VAULT_ADDRESSES.YSCVGCVX,
    icon: "/yscvgcvx-128.png",
    label: "LiquidBoost",
    protocolLogo: "/tokens/liquidboost.png",
    symbol: "yscvgCVX",
    symbolPrefix: "ys",
    symbolSuffix: "cvgCVX",
    underlying: "cvgCVX",
  },
] as const;

async function fetchVaultWeeklyApy(
  vault: (typeof WEEKLY_APY_VAULTS)[number]
): Promise<WeeklyApyVault> {
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

  const weeklyApy = (result.data.vault.apy?.weeklyNet ?? 0) * 100;
  return {
    ...vault,
    weeklyApy,
    weeklyApyFormatted: `${weeklyApy.toFixed(2)}%`,
  };
}

export async function fetchWeeklyApyVaults(): Promise<WeeklyApyVault[]> {
  const vaults = await Promise.all(WEEKLY_APY_VAULTS.map(fetchVaultWeeklyApy));
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
