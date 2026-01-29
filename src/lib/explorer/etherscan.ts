import type { ABIItem } from "@/types/explorer";

/**
 * Etherscan service - calls our API route which handles:
 * - Server-side Etherscan API calls (keeps API key private)
 * - Cloudflare KV caching (shared across all users)
 *
 * Also maintains a client-side in-memory cache for faster repeated access
 * within the same session.
 */

// In-memory cache for faster repeated access within a session
const abiCache = new Map<string, ABIItem[]>();
const nameCache = new Map<string, string | null>();
const natspecCache = new Map<string, NatSpec>();
const sourceCache = new Map<string, ContractSource>();

export interface ContractSource {
  source: string;
  name: string | null;
  compiler: string | null;
}

export interface FunctionDoc {
  notice?: string;
  dev?: string;
  params?: Record<string, string>;
  returns?: string;
}

export interface NatSpec {
  contractNotice?: string;
  contractDev?: string;
  functions: Record<string, FunctionDoc>;
}

interface ApiResponse<T> {
  result: T;
  cached: boolean;
  error?: string;
}

async function fetchFromApi<T>(action: string, address: string, chainId: number = 1): Promise<{ result: T; kvCached: boolean }> {
  const url = `/api/explorer?action=${action}&address=${address}&chainId=${chainId}`;
  const response = await fetch(url);

  if (!response.ok) {
    const errorData = (await response.json().catch(() => ({ error: "Request failed" }))) as { error?: string };
    throw new Error(errorData.error || `Failed to fetch ${action}`);
  }

  const data = (await response.json()) as ApiResponse<T>;
  return { result: data.result, kvCached: data.cached };
}

export async function getContractABI(address: string, chainId: number = 1): Promise<ABIItem[]> {
  const normalizedAddress = address.toLowerCase();

  // Check in-memory cache first
  const cacheKey = `${chainId}_${normalizedAddress}`;
  if (abiCache.has(cacheKey)) {
    return abiCache.get(cacheKey)!;
  }

  const { result: abi } = await fetchFromApi<ABIItem[]>("getABI", address, chainId);
  abiCache.set(cacheKey, abi);
  return abi;
}

export async function getContractName(address: string, chainId: number = 1): Promise<string | null> {
  const normalizedAddress = address.toLowerCase();

  // Check in-memory cache first
  const cacheKey = `${chainId}_${normalizedAddress}`;
  if (nameCache.has(cacheKey)) {
    return nameCache.get(cacheKey)!;
  }

  try {
    const { result: name } = await fetchFromApi<string | null>("getName", address, chainId);
    nameCache.set(cacheKey, name);
    return name;
  } catch {
    nameCache.set(cacheKey, null);
    return null;
  }
}

export async function getContractSource(address: string, chainId: number = 1): Promise<ContractSource> {
  const normalizedAddress = address.toLowerCase();

  // Check in-memory cache first
  const cacheKey = `${chainId}_${normalizedAddress}`;
  if (sourceCache.has(cacheKey)) {
    return sourceCache.get(cacheKey)!;
  }

  // API returns files array, we need to combine into single source string
  interface ApiSourceResult {
    files: Array<{ name: string; content: string }>;
    name: string | null;
    compiler: string | null;
    isProxy?: boolean;
    implementationAddress?: string | null;
  }

  const { result } = await fetchFromApi<ApiSourceResult>("getSource", address, chainId);

  // Combine all files into a single source string for the parser
  const source: ContractSource = {
    source: result.files.map(f => f.content).join("\n\n"),
    name: result.name,
    compiler: result.compiler,
  };

  sourceCache.set(cacheKey, source);
  return source;
}

export async function getContractNatSpec(address: string, chainId: number = 1): Promise<NatSpec> {
  const normalizedAddress = address.toLowerCase();

  // Check in-memory cache first
  const cacheKey = `${chainId}_${normalizedAddress}`;
  if (natspecCache.has(cacheKey)) {
    return natspecCache.get(cacheKey)!;
  }

  try {
    const { result: natspec } = await fetchFromApi<NatSpec>("getNatSpec", address, chainId);
    natspecCache.set(cacheKey, natspec);
    return natspec;
  } catch {
    const emptyNatspec: NatSpec = { functions: {} };
    natspecCache.set(cacheKey, emptyNatspec);
    return emptyNatspec;
  }
}

export function isValidAddress(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

export function isZeroAddress(address: string): boolean {
  return address === "0x0000000000000000000000000000000000000000";
}
