import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, encodeAbiParameters, http, keccak256, pad, parseAbiParameters, toHex } from "viem";
import { mainnet } from "viem/chains";
import { TOKENS, VAULT_ADDRESSES, CURVE_CONTROLLERS, getVaultByAddress, LLAMA_AIRFORCE, CONCENTRATOR, CURVE_SAVINGS, ASYMMETRY } from "@/config/vaults";
import { fetchTokenPricesDirect, ENSO_ROUTER, ENSO_ROUTER_EXECUTOR } from "@/lib/enso";
import { CRVUSD_ADDRESS, USDC_ADDRESS, YVUSDC1_ADDRESS } from "@/config/addresses";
import { ZAPPER_ADDRESS } from "@/lib/zapper";
import { ERC4626_ABI } from "@/lib/abis";
import {
  getSimulationPriceLookupAddresses,
  resolveSimulationDollarValue,
} from "@/lib/simulation-pricing";

export const dynamic = "force-dynamic";

// Allowed origins for CORS
const ALLOWED_ORIGINS = [
  "https://yldfi.co",
  "https://www.yldfi.co",
  ...(process.env.NODE_ENV === "development" ? ["http://localhost:3000"] : []),
];

function getCorsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  const isAllowed = ALLOWED_ORIGINS.includes(origin);
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
const CVX_BALANCE_SLOT = 0n;
const CVX_ALLOWANCE_SLOT = 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_REQUESTS_PER_MINUTE = 8;
const SIMULATE_TOTAL_TIMEOUT_MS = 12_000;
const TENDERLY_FETCH_TIMEOUT_MS = 9_000;
const TENDERLY_JSON_TIMEOUT_MS = 1_500;
const ETH_CALL_TIMEOUT_MS = 2_500;
const ENRICH_TIMEOUT_MS = 1_500;
const VAULT_DISCOVERY_TIMEOUT_MS = 1_500;
const CONVERT_TO_ASSETS_TIMEOUT_MS = 1_500;
const PRICE_FETCH_TIMEOUT_MS = 1_500;

// Create public client for RPC calls
const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(),
});

import { createRateLimiter, getClientIp } from "@/lib/rate-limit";

const isRateLimited = createRateLimiter(MAX_REQUESTS_PER_MINUTE);

// Track consumed nonces to prevent replay within TTL window
// Map<nonce, expiresAt> — entries self-clean on each check
const consumedNonces = new Map<string, number>();
function consumeNonce(nonce: string, expires: number): boolean {
  const now = Date.now();
  // Evict expired nonces
  for (const [key, exp] of consumedNonces) {
    if (now > exp) consumedNonces.delete(key);
  }
  if (consumedNonces.has(nonce)) return false; // already used
  consumedNonces.set(nonce, expires);
  return true;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function signPayload(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return base64UrlEncode(new Uint8Array(signature));
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const bytes = Buffer.from(padded, "base64");
  return new Uint8Array(bytes);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

async function verifySignature(
  secret: string,
  payload: string,
  signature: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const expectedBytes = new Uint8Array(expected);
  const providedBytes = base64UrlDecode(signature);
  return timingSafeEqual(expectedBytes, providedBytes);
}

function computeERC20BalanceSlot(account: string, slot: bigint = CVX_BALANCE_SLOT): `0x${string}` {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address, uint256"), [account as `0x${string}`, slot])
  );
}

function computeERC20AllowanceSlot(
  owner: string,
  spender: string,
  slot: bigint = CVX_ALLOWANCE_SLOT
): `0x${string}` {
  const innerSlot = keccak256(
    encodeAbiParameters(parseAbiParameters("address, uint256"), [owner as `0x${string}`, slot])
  );
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address, bytes32"), [spender as `0x${string}`, innerSlot])
  );
}

function toStorageValue(value: bigint): `0x${string}` {
  return pad(toHex(value), { size: 32 });
}

function formatSimulateError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function shortAddress(address?: string): string | undefined {
  if (!address) return undefined;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function normalizeTenderlyGas(gas?: string | number): number | undefined {
  if (gas === undefined) return undefined;
  const parsed = typeof gas === "string" ? Number(gas) : gas;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const guardedTimeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([
      promise,
      guardedTimeout,
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// Asset change from Tenderly response
interface TenderlyAssetChange {
  token_info: {
    symbol: string;
    decimals: number;
    standard: string;
    contract_address: string;
    logo?: string;
  };
  from: string;
  to: string;
  amount: string;
  raw_amount: string;
  dollar_value?: string;
}

// Processed asset change for our response
interface AssetChange {
  type: "send" | "receive" | "repay" | "borrow" | "deposit";
  symbol: string;
  amount: string;
  rawAmount: string;
  address: string;
  decimals: number;
  logo?: string;
  dollarValue?: string;
}

// Known Curve controller addresses for lending operations
const CURVE_CONTROLLER_ADDRESSES = new Set([
  "0x24174143ccf438f0a1f6dcf93b468c127123a96e", // ycvxCRV controller
]);

// Known Curve AMM addresses (controller.amm()) — collateral is deposited/withdrawn here
const CURVE_AMM_ADDRESSES = new Set([
  "0xf1b03586c03ebfec014238d105148a15102a282f", // ycvxCRV controller AMM
]);

// Known vault token addresses (collateral tokens for lending)
const VAULT_COLLATERAL_TOKENS = new Set([
  "0x95f19b19aff698169a1a0bbc28a2e47b14cb9a86", // ycvxCRV
]);

// crvUSD address imported from @/config/addresses

function processAssetChanges(
  assetChanges: TenderlyAssetChange[] | undefined,
  userAddress: string
): AssetChange[] {
  if (!assetChanges || !Array.isArray(assetChanges)) return [];

  const normalizedUser = userAddress.toLowerCase();
  const result: AssetChange[] = [];

  for (const change of assetChanges) {
    const from = change.from?.toLowerCase() ?? "";
    const to = change.to?.toLowerCase() ?? "";
    const tokenAddress = change.token_info?.contract_address?.toLowerCase() ?? "";
    const isCrvUsd = tokenAddress === CRVUSD_ADDRESS.toLowerCase();

    const isUserSending = from === normalizedUser;
    const isUserReceiving = to === normalizedUser;
    const isToController = CURVE_CONTROLLER_ADDRESSES.has(to);
    const isFromController = CURVE_CONTROLLER_ADDRESSES.has(from);
    // Curve controllers mint crvUSD (from=0x0) rather than transferring from their balance
    const isMint = from === "0x0000000000000000000000000000000000000000";

    // Detect lending operations
    // crvUSD to controller = repay
    if (isCrvUsd && isToController && !isFromController) {
      result.push({
        type: "repay",
        symbol: change.token_info?.symbol ?? "crvUSD",
        amount: change.amount ?? "0",
        rawAmount: change.raw_amount ?? "0",
        address: change.token_info?.contract_address ?? "",
        decimals: change.token_info?.decimals ?? 18,
        logo: change.token_info?.logo,
        dollarValue: change.dollar_value,
      });
      continue;
    }

    // crvUSD from controller or minted = borrow (create_loan/borrow_more mint crvUSD)
    // May go to user directly or to ENSO_SHORTCUTS for output swap
    if (isCrvUsd && (isFromController || isMint)) {
      result.push({
        type: "borrow",
        symbol: change.token_info?.symbol ?? "crvUSD",
        amount: change.amount ?? "0",
        rawAmount: change.raw_amount ?? "0",
        address: change.token_info?.contract_address ?? "",
        decimals: change.token_info?.decimals ?? 18,
        logo: change.token_info?.logo,
        dollarValue: change.dollar_value,
      });
      continue;
    }

    // Collateral token → AMM = deposit (add_collateral)
    const isVaultCollateral = VAULT_COLLATERAL_TOKENS.has(tokenAddress);
    const isToAmm = CURVE_AMM_ADDRESSES.has(to);
    const isFromAmm = CURVE_AMM_ADDRESSES.has(from);

    if (isVaultCollateral && isToAmm) {
      result.push({
        type: "deposit",
        symbol: change.token_info?.symbol ?? "???",
        amount: change.amount ?? "0",
        rawAmount: change.raw_amount ?? "0",
        address: change.token_info?.contract_address ?? "",
        decimals: change.token_info?.decimals ?? 18,
        logo: change.token_info?.logo,
        dollarValue: change.dollar_value,
      });
      continue;
    }

    // Collateral token ← AMM = withdraw (remove_collateral)
    if (isVaultCollateral && isFromAmm) {
      result.push({
        type: "receive",
        symbol: change.token_info?.symbol ?? "???",
        amount: change.amount ?? "0",
        rawAmount: change.raw_amount ?? "0",
        address: change.token_info?.contract_address ?? "",
        decimals: change.token_info?.decimals ?? 18,
        logo: change.token_info?.logo,
        dollarValue: change.dollar_value,
      });
      continue;
    }

    // Regular user send/receive
    if (!isUserSending && !isUserReceiving) continue;

    result.push({
      type: isUserSending ? "send" : "receive",
      symbol: change.token_info?.symbol ?? "???",
      amount: change.amount ?? "0",
      rawAmount: change.raw_amount ?? "0",
      address: change.token_info?.contract_address ?? "",
      decimals: change.token_info?.decimals ?? 18,
      logo: change.token_info?.logo,
      dollarValue: change.dollar_value,
    });
  }

  return result;
}

/**
 * Enriches vault token prices by calculating USD value using pricePerShare × underlying price.
 * Handles both yld vaults (known config) and unknown ERC4626 vaults (e.g. yvUSDC-1) via on-chain discovery.
 */
// Known ERC4626 vault tokens → { underlying, underlyingDecimals }
// Avoids slow on-chain discovery calls. Module-level for persistence across requests.
const KNOWN_VAULT_REGISTRY = new Map<string, { underlying: string; underlyingDecimals: number }>([
  // Yearn V3
  [YVUSDC1_ADDRESS.toLowerCase(), { underlying: USDC_ADDRESS.toLowerCase(), underlyingDecimals: 6 }],
  // Curve Savings
  [CURVE_SAVINGS.SCRVUSD.toLowerCase(), { underlying: CRVUSD_ADDRESS.toLowerCase(), underlyingDecimals: 18 }],
  // Llama Airforce
  [LLAMA_AIRFORCE.UCVX.toLowerCase(), { underlying: TOKENS.PXCVX.toLowerCase(), underlyingDecimals: 18 }],
  // Concentrator
  [CONCENTRATOR.ACVX.toLowerCase(), { underlying: TOKENS.CVX.toLowerCase(), underlyingDecimals: 18 }],
  [CONCENTRATOR.ACRV.toLowerCase(), { underlying: TOKENS.CVXCRV.toLowerCase(), underlyingDecimals: 18 }],
  // Asymmetry
  [ASYMMETRY.AFCVX.toLowerCase(), { underlying: TOKENS.CVX.toLowerCase(), underlyingDecimals: 18 }],
]);

// Cache for on-chain discovered vaults — persists across requests, never expires
// (vault underlying doesn't change)
const discoveredVaultCache = new Map<string, { underlying: string; underlyingDecimals: number }>();
// Addresses we already tried and know are NOT vaults — skip forever
const notVaultCache = new Set<string>();

function lookupVault(address: string): { underlying: string; underlyingDecimals: number } | null {
  const addr = address.toLowerCase();
  // 1. yld vault config
  const yldVault = getVaultByAddress(address);
  if (yldVault) return { underlying: yldVault.assetAddress.toLowerCase(), underlyingDecimals: yldVault.assetDecimals };
  // 2. Known external vaults
  const known = KNOWN_VAULT_REGISTRY.get(addr);
  if (known) return known;
  // 3. Previously discovered on-chain
  return discoveredVaultCache.get(addr) ?? null;
}

async function enrichVaultTokenPrices(assetChanges: AssetChange[]): Promise<AssetChange[]> {
  try {
    // Only enrich tokens that are missing a dollar value
    const needsEnrichment = assetChanges.filter(c =>
      !c.dollarValue || c.dollarValue === "0" || parseFloat(c.dollarValue) === 0
    );
    if (needsEnrichment.length === 0) return assetChanges;

    // Resolve vault info for unpriced tokens
    const vaultInfoMap = new Map<string, { underlying: string; underlyingDecimals: number }>();
    const needsDiscovery: AssetChange[] = [];

    for (const change of needsEnrichment) {
      const info = lookupVault(change.address);
      if (info) {
        vaultInfoMap.set(change.address.toLowerCase(), info);
      } else if (!notVaultCache.has(change.address.toLowerCase())) {
        needsDiscovery.push(change);
      }
    }

    // Discover unknown tokens via single RPC call each (deduplicated, 2s timeout)
    if (needsDiscovery.length > 0) {
      const seen = new Set<string>();
      const unique = needsDiscovery.filter(c => {
        const a = c.address.toLowerCase();
        if (seen.has(a)) return false;
        seen.add(a);
        return true;
      });
      await Promise.all(unique.map(async (change) => {
        const addr = change.address.toLowerCase();
        try {
          const [underlying, decimals] = await Promise.all([
            withTimeout(
              publicClient.readContract({ address: addr as `0x${string}`, abi: ERC4626_ABI, functionName: "asset" }),
              VAULT_DISCOVERY_TIMEOUT_MS,
              "vault_asset_lookup",
            ),
            withTimeout(
              publicClient.readContract({ address: addr as `0x${string}`, abi: ERC4626_ABI, functionName: "decimals" }),
              VAULT_DISCOVERY_TIMEOUT_MS,
              "vault_decimals_lookup",
            ),
          ]);
          const info = { underlying: (underlying as string).toLowerCase(), underlyingDecimals: Number(decimals) };
          discoveredVaultCache.set(addr, info);
          vaultInfoMap.set(addr, info);
        } catch {
          notVaultCache.add(addr); // Remember this isn't a vault
        }
      }));
    }

    if (vaultInfoMap.size === 0) return assetChanges;

    // Collect unique underlying addresses we need prices for
    const underlyingAddresses = getSimulationPriceLookupAddresses(
      [...vaultInfoMap.values()].map(v => v.underlying),
    );

    // Fetch prices + convertToAssets in parallel
    const [priceData, ...convertResults] = await Promise.all([
      withTimeout(
        fetchTokenPricesDirect(underlyingAddresses),
        PRICE_FETCH_TIMEOUT_MS,
        "underlying_price_fetch",
      ),
      ...assetChanges
        .filter(c => vaultInfoMap.has(c.address.toLowerCase()))
        .map(c =>
          withTimeout(
            publicClient.readContract({
              address: c.address as `0x${string}`,
              abi: ERC4626_ABI,
              functionName: "convertToAssets",
              args: [BigInt(c.rawAmount)],
            }),
            CONVERT_TO_ASSETS_TIMEOUT_MS,
            "convert_to_assets",
          ).then(r => ({ address: c.address.toLowerCase(), underlyingAmount: r as bigint }))
            .catch(() => null)
        ),
    ]);

    const priceMap = new Map(priceData.map(p => [p.address.toLowerCase(), p.price]));
    const convertMap = new Map(convertResults.filter(Boolean).map(r => [r!.address, r!.underlyingAmount]));

    const enriched = assetChanges.map(change => {
      const info = vaultInfoMap.get(change.address.toLowerCase());
      if (!info) return change;

      const dollarValue = resolveSimulationDollarValue({
        address: change.address,
        rawAmount: change.rawAmount,
        decimals: change.decimals,
        priceMap,
        vaultInfo: info,
        underlyingAmount: convertMap.get(change.address.toLowerCase()),
      });
      return dollarValue ? { ...change, dollarValue } : change;
    });

    // Fallback: fetch Enso prices directly for any still-unpriced tokens
    return enrichTokenPricesFallback(enriched);
  } catch {
    return enrichTokenPricesFallback(assetChanges);
  }
}

/** Fetch Enso prices for any asset changes still missing a dollar value */
async function enrichTokenPricesFallback(assetChanges: AssetChange[]): Promise<AssetChange[]> {
  try {
    const unpriced = assetChanges.filter(c =>
      !c.dollarValue || c.dollarValue === "0" || parseFloat(c.dollarValue) === 0
    );
    if (unpriced.length === 0) return assetChanges;

    const vaultInfoMap = new Map<string, { underlying: string; underlyingDecimals: number }>();
    for (const change of unpriced) {
      const info = lookupVault(change.address);
      if (info) {
        vaultInfoMap.set(change.address.toLowerCase(), info);
      }
    }

    const addresses = getSimulationPriceLookupAddresses([
      ...unpriced.map(c => c.address.toLowerCase()),
      ...[...vaultInfoMap.values()].map(info => info.underlying),
    ]);
    const vaultChangesNeedingConvert = unpriced.filter(c => vaultInfoMap.has(c.address.toLowerCase()));

    const [priceData, ...convertResults] = await Promise.all([
      withTimeout(
        fetchTokenPricesDirect(addresses),
        PRICE_FETCH_TIMEOUT_MS,
        "fallback_price_fetch",
      ),
      ...vaultChangesNeedingConvert.map(change =>
        withTimeout(
          publicClient.readContract({
            address: change.address as `0x${string}`,
            abi: ERC4626_ABI,
            functionName: "convertToAssets",
            args: [BigInt(change.rawAmount)],
          }),
          CONVERT_TO_ASSETS_TIMEOUT_MS,
          "fallback_convert_to_assets",
        ).then(r => ({ address: change.address.toLowerCase(), underlyingAmount: r as bigint }))
          .catch(() => null)
      ),
    ]);

    const priceMap = new Map(priceData.map(p => [p.address.toLowerCase(), p.price]));
    const convertMap = new Map(convertResults.filter(Boolean).map(r => [r!.address, r!.underlyingAmount]));

    return assetChanges.map(change => {
      if (change.dollarValue && change.dollarValue !== "0" && parseFloat(change.dollarValue) !== 0) return change;
      const dollarValue = resolveSimulationDollarValue({
        address: change.address,
        rawAmount: change.rawAmount,
        decimals: change.decimals,
        priceMap,
        vaultInfo: vaultInfoMap.get(change.address.toLowerCase()),
        underlyingAmount: convertMap.get(change.address.toLowerCase()),
      });
      return dollarValue ? { ...change, dollarValue } : change;
    });
  } catch {
    return assetChanges;
  }
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { headers: getCorsHeaders(request) });
}

export async function POST(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  const clientIp = getClientIp(request);
  if (isRateLimited(clientIp)) {
    return NextResponse.json(
      { success: false, errorMessage: "Rate limit exceeded", retryable: true },
      { status: 429, headers: corsHeaders }
    );
  }

  const accountSlug = process.env.TENDERLY_ACCOUNT_SLUG;
  const projectSlug = process.env.TENDERLY_PROJECT_SLUG;
  const accessKey = process.env.TENDERLY_ACCESS_KEY;

  if (!accountSlug || !projectSlug || !accessKey) {
    return NextResponse.json(
      {
        success: false,
        errorMessage: "Tenderly not configured",
        retryable: true,
      },
      { status: 500, headers: corsHeaders }
    );
  }

  let body: {
    from?: string;
    to?: string;
    data?: string;
    value?: string;
    gas?: string | number;
    networkId?: string | number;
    inputToken?: string;
    nonce?: string;
    expires?: number;
    sig?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, errorMessage: "Invalid JSON body", retryable: false },
      { status: 400, headers: corsHeaders }
    );
  }

  if (!body?.from || !body?.to || !body?.data) {
    return NextResponse.json(
      { success: false, errorMessage: "Missing from/to/data", retryable: false },
      { status: 400, headers: corsHeaders }
    );
  }

  const nonceSecret = process.env.SIMULATION_NONCE_SECRET;
  if (!nonceSecret) {
    return NextResponse.json(
      { success: false, errorMessage: "Nonce secret not configured", retryable: true },
      { status: 500, headers: corsHeaders }
    );
  }

  if (!body.nonce || !body.expires || !body.sig) {
    return NextResponse.json(
      { success: false, errorMessage: "Missing nonce", retryable: false },
      { status: 400, headers: corsHeaders }
    );
  }

  if (Date.now() > body.expires) {
    return NextResponse.json(
      { success: false, errorMessage: "Nonce expired", retryable: false },
      { status: 400, headers: corsHeaders }
    );
  }

  const noncePayload = `${body.nonce}.${body.expires}`;
  const nonceOk = await verifySignature(nonceSecret, noncePayload, body.sig);
  if (!nonceOk) {
    return NextResponse.json(
      { success: false, errorMessage: "Invalid nonce", retryable: false },
      { status: 400, headers: corsHeaders }
    );
  }

  // Reject replayed nonces (each nonce can only be used once)
  if (!consumeNonce(body.nonce, body.expires)) {
    return NextResponse.json(
      { success: false, errorMessage: "Nonce already used", retryable: false },
      { status: 400, headers: corsHeaders }
    );
  }

  // Build allowlist of simulation targets: Enso router + vaults + controllers + zappers
  const allowedTargets = new Set<string>([
    ENSO_ROUTER_EXECUTOR.toLowerCase(),
    ZAPPER_ADDRESS.toLowerCase(),
    ...Object.values(VAULT_ADDRESSES).map((a) => a.toLowerCase()),
    ...Object.values(CURVE_CONTROLLERS).map((a) => a.toLowerCase()),
  ]);

  if (!allowedTargets.has(body.to.toLowerCase())) {
    return NextResponse.json(
      { success: false, errorMessage: `[yld→Tenderly] Simulation target not in allowlist: ${body.to}`, retryable: false },
      { status: 400, headers: corsHeaders }
    );
  }

  if (!body.data.startsWith("0x") || body.data.length < 10) {
    return NextResponse.json(
      { success: false, errorMessage: "Invalid calldata", retryable: false },
      { status: 400, headers: corsHeaders }
    );
  }

  const requestId = crypto.randomUUID().slice(0, 8);
  const requestStartedAt = Date.now();
  const totalDeadline = requestStartedAt + SIMULATE_TOTAL_TIMEOUT_MS;
  const logSimulate = (event: string, extra: Record<string, unknown> = {}) => {
    console.log("[Simulate]", JSON.stringify({
      requestId,
      event,
      elapsedMs: Date.now() - requestStartedAt,
      ...extra,
    }));
  };
  const getStageBudget = (maxMs: number): number => {
    const remaining = totalDeadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`simulate_total timed out after ${SIMULATE_TOTAL_TIMEOUT_MS}ms`);
    }
    return Math.min(maxMs, remaining);
  };
  const runStage = async <T>(
    stage: string,
    maxMs: number,
    work: (budgetMs: number) => Promise<T>,
  ): Promise<T> => {
    const budgetMs = getStageBudget(maxMs);
    const stageStartedAt = Date.now();
    try {
      const result = await withTimeout(work(budgetMs), budgetMs, stage);
      logSimulate("stage_ok", {
        stage,
        durationMs: Date.now() - stageStartedAt,
        budgetMs,
      });
      return result;
    } catch (error) {
      logSimulate("stage_error", {
        stage,
        durationMs: Date.now() - stageStartedAt,
        budgetMs,
        error: formatSimulateError(error),
      });
      throw error;
    }
  };

  const inputToken = body.inputToken?.toLowerCase();
  const shouldOverrideCvx = inputToken === TOKENS.CVX.toLowerCase();
  const normalizedGas = normalizeTenderlyGas(body.gas);
  const overrides = shouldOverrideCvx
    ? {
        [TOKENS.CVX]: {
          storage: {
            [computeERC20BalanceSlot(body.from)]: toStorageValue(MAX_UINT256),
            [computeERC20AllowanceSlot(body.from, ENSO_ROUTER)]: toStorageValue(MAX_UINT256),
          },
        },
      }
    : undefined;

  const tenderlyRequest = {
    network_id: body.networkId?.toString() ?? "1",
    from: body.from,
    to: body.to,
    input: body.data,
    value: body.value ?? "0",
    gas: normalizedGas,
    save: true,            // Save simulations so users can view traces
    save_if_fails: true,   // Always save failures for debugging
    // The UI only needs gas usage and asset/balance changes, not decoded traces.
    simulation_type: "quick",
    overrides,
  };
  logSimulate("start", {
    from: shortAddress(body.from),
    to: shortAddress(body.to),
    inputToken: shortAddress(body.inputToken),
    networkId: tenderlyRequest.network_id,
    simulationType: tenderlyRequest.simulation_type,
    gas: normalizedGas ?? null,
    hasOverrides: Boolean(overrides),
  });

  // Helper to try eth_call as fallback
  async function tryEthCall(): Promise<{ success: boolean; error?: string }> {
    try {
      await runStage("eth_call", ETH_CALL_TIMEOUT_MS, () =>
        publicClient.call({
          account: body.from as `0x${string}`,
          to: body.to as `0x${string}`,
          data: body.data as `0x${string}`,
          value: body.value ? BigInt(body.value) : 0n,
        })
      );
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "eth_call failed";
      // Extract revert reason if present
      const revertMatch = message.match(/reverted with reason string '([^']+)'/);
      return { success: false, error: revertMatch?.[1] ?? message };
    }
  }

  let response: Response;
  try {
    response = await runStage("tenderly_fetch", TENDERLY_FETCH_TIMEOUT_MS, (budgetMs) =>
      fetch(
        `https://api.tenderly.co/api/v1/account/${accountSlug}/project/${projectSlug}/simulate`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Access-Key": accessKey,
          },
          body: JSON.stringify(tenderlyRequest),
          signal: AbortSignal.timeout(budgetMs),
        }
      )
    );
  } catch (error) {
    // Tenderly request failed (network error) - try eth_call fallback
    const ethCallResult = await tryEthCall();
    if (ethCallResult.success) {
      const reason = formatSimulateError(error);
      logSimulate("fallback_unavailable", {
        reason,
        path: "tenderly_fetch",
      });
      return NextResponse.json(
        {
          success: true,
          simulationUnavailable: true,
          simulationUnavailableReason: reason,
          gasUsed: null,
          errorMessage: null,
          retryable: false,
          simulationId: null,
          tenderlyUrl: null,
          assetChanges: [],
        },
        { status: 200, headers: corsHeaders }
      );
    }
    logSimulate("failure", {
      path: "tenderly_fetch",
      error: ethCallResult.error ?? "Transaction would fail",
    });
    return NextResponse.json(
      {
        success: false,
        errorMessage: ethCallResult.error ?? "Transaction would fail",
        retryable: false,
      },
      { status: 400, headers: corsHeaders }
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = await runStage("tenderly_json", TENDERLY_JSON_TIMEOUT_MS, async () => (
      await response.json().catch(() => ({}))
    )) as Record<string, unknown>;
  } catch (error) {
    const ethCallResult = await tryEthCall();
    if (ethCallResult.success) {
      const reason = formatSimulateError(error);
      logSimulate("fallback_unavailable", {
        path: "tenderly_json",
        reason,
      });
      return NextResponse.json(
        {
          success: true,
          simulationUnavailable: true,
          simulationUnavailableReason: reason,
          gasUsed: null,
          errorMessage: null,
          retryable: false,
          simulationId: null,
          tenderlyUrl: null,
          assetChanges: [],
        },
        { status: 200, headers: corsHeaders }
      );
    }
    logSimulate("failure", {
      path: "tenderly_json",
      error: ethCallResult.error ?? "Transaction would fail",
    });
    return NextResponse.json(
      {
        success: false,
        errorMessage: ethCallResult.error ?? "Transaction would fail",
        retryable: false,
      },
      { status: 400, headers: corsHeaders }
    );
  }

  // Check for Tenderly API-level errors (quota, auth, etc.) vs transaction failures
  const payloadError = payload?.error as Record<string, unknown> | undefined;
  const errorSlug = payloadError?.slug as string | undefined;
  const isApiError = !response.ok || errorSlug === "quota_limit_reached" || errorSlug === "unauthorized";

  if (isApiError) {
    // Tenderly API error - try eth_call fallback
    const ethCallResult = await tryEthCall();
    if (ethCallResult.success) {
      const apiErrorMessage = payloadError?.message ?? "Tenderly simulation unavailable";
      logSimulate("fallback_unavailable", {
        path: "tenderly_api_error",
        errorSlug: errorSlug ?? null,
        reason: apiErrorMessage,
      });
      return NextResponse.json(
        {
          success: true,
          simulationUnavailable: true,
          simulationUnavailableReason: apiErrorMessage,
          gasUsed: null,
          errorMessage: null,
          retryable: false,
          simulationId: null,
          tenderlyUrl: null,
          assetChanges: [],
        },
        { status: 200, headers: corsHeaders }
      );
    }
    // eth_call also failed - return the actual error
    logSimulate("failure", {
      path: "tenderly_api_error",
      errorSlug: errorSlug ?? null,
      error: ethCallResult.error ?? "Transaction would fail",
    });
    return NextResponse.json(
      {
        success: false,
        errorMessage: ethCallResult.error ?? "Transaction would fail",
        retryable: false,
      },
      { status: 400, headers: corsHeaders }
    );
  }

  const simulation = (payload?.simulation ?? payload?.transaction ?? payload ?? {}) as Record<string, unknown>;
  const status = simulation?.status !== false;
  const transaction = payload?.transaction as Record<string, unknown> | undefined;
  const gasUsed = simulation?.gas_used ?? transaction?.gas_used ?? null;
  const payloadSimulation = payload?.simulation as Record<string, unknown> | undefined;
  const simulationId = simulation?.id ?? payloadSimulation?.id ?? null;

  // Return a signed link to our share endpoint which will verify before sharing via Tenderly
  const secret = process.env.SIMULATION_NONCE_SECRET;
  const tenderlyUrl = simulationId && secret
    ? `/api/simulate/share/${simulationId}?sig=${await signPayload(secret, String(simulationId))}`
    : null;
  const errorMessage =
    simulation?.error_message ??
    simulation?.error ??
    payloadError?.message ??
    (response.ok ? null : "Tenderly simulation failed");
  const retryable = !response.ok;

  // Extract asset changes from Tenderly response
  // Full simulation response structure: transaction.transaction_info.asset_changes
  const transactionInfo = transaction?.transaction_info as Record<string, unknown> | undefined;
  const rawAssetChanges = transactionInfo?.asset_changes as TenderlyAssetChange[] | undefined;
  const processedChanges = processAssetChanges(rawAssetChanges, body.from);

  // Enrich vault token prices (Tenderly doesn't have prices for our vault tokens)
  let assetChanges = processedChanges;
  try {
    assetChanges = await runStage("asset_enrich", ENRICH_TIMEOUT_MS, () =>
      enrichVaultTokenPrices(processedChanges)
    );
  } catch (error) {
    logSimulate("asset_enrich_fallback", {
      reason: formatSimulateError(error),
      processedChanges: processedChanges.length,
    });
    assetChanges = await enrichTokenPricesFallback(processedChanges);
  }

  logSimulate("finish", {
    success: Boolean(response.ok && status),
    simulationId,
    gasUsed,
    assetChangesCount: assetChanges.length,
    rawAssetChangesCount: rawAssetChanges?.length ?? 0,
    tenderlyUrl: tenderlyUrl ?? null,
    errorMessage: errorMessage ?? null,
  });

  return NextResponse.json(
    {
      success: Boolean(response.ok && status),
      status: Boolean(status),
      gasUsed,
      errorMessage,
      retryable,
      // Always return simulation details (not just in dev mode)
      simulationId,
      tenderlyUrl,
      assetChanges,
    },
    { status: response.ok ? 200 : 502, headers: corsHeaders }
  );
}
