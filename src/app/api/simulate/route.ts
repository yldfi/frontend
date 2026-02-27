import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, encodeAbiParameters, http, keccak256, pad, parseAbiParameters, toHex } from "viem";
import { mainnet } from "viem/chains";
import { TOKENS, VAULT_ADDRESSES, CURVE_CONTROLLERS, getVaultByAddress } from "@/config/vaults";
import { fetchTokenPrices, ENSO_ROUTER, ENSO_ROUTER_EXECUTOR } from "@/lib/enso";
import { CRVUSD_ADDRESS } from "@/config/addresses";
import { ZAPPER_ADDRESS, ZAPPER_V3_ADDRESS } from "@/lib/zapper";
import { ERC4626_ABI } from "@/lib/abis";

export const dynamic = "force-dynamic";

// Allowed origins for CORS
const ALLOWED_ORIGINS = [
  "https://yldfi.co",
  "https://www.yldfi.co",
  "http://localhost:3000",
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
async function enrichVaultTokenPrices(assetChanges: AssetChange[]): Promise<AssetChange[]> {
  try {
    // Collect underlying addresses for ALL vault tokens (not just unpriced ones),
    // since Tenderly often returns stale/inaccurate prices for vault tokens.
    // We always override with convertToAssets × underlyingPrice for accuracy.
    const underlyingAddresses = new Set<string>();
    const knownVaultAddresses = new Set<string>();
    // Map unknown vault address → { underlying, underlyingDecimals } discovered via RPC
    const discoveredVaults = new Map<string, { underlying: string; underlyingDecimals: number }>();

    for (const change of assetChanges) {
      const vault = getVaultByAddress(change.address);
      if (vault) {
        underlyingAddresses.add(vault.assetAddress.toLowerCase());
        knownVaultAddresses.add(change.address.toLowerCase());
      }
    }

    // For tokens not in yld vaults, try ERC4626 asset() discovery on ALL tokens
    // (not just unpriced — Tenderly often returns stale prices for vault tokens)
    const unknownTokens = assetChanges.filter(c =>
      !knownVaultAddresses.has(c.address.toLowerCase())
    );
    // Deduplicate by address to avoid redundant RPC calls
    const seenAddresses = new Set<string>();
    const uniqueUnknown = unknownTokens.filter(c => {
      const addr = c.address.toLowerCase();
      if (seenAddresses.has(addr)) return false;
      seenAddresses.add(addr);
      return true;
    });
    await Promise.all(uniqueUnknown.map(async (change) => {
      try {
        const [underlying, underlyingDecimals] = await Promise.all([
          publicClient.readContract({
            address: change.address as `0x${string}`,
            abi: ERC4626_ABI,
            functionName: "asset",
          }),
          publicClient.readContract({
            address: change.address as `0x${string}`,
            abi: ERC4626_ABI,
            functionName: "decimals",
          }),
        ]);
        const underlyingAddr = (underlying as string).toLowerCase();
        discoveredVaults.set(change.address.toLowerCase(), {
          underlying: underlyingAddr,
          underlyingDecimals: Number(underlyingDecimals),
        });
        underlyingAddresses.add(underlyingAddr);
      } catch {
        // Not an ERC4626 vault, skip
      }
    }));

    if (underlyingAddresses.size === 0) return assetChanges;

    // Fetch underlying token prices from Enso
    const priceData = await fetchTokenPrices([...underlyingAddresses]);
    const priceMap = new Map(priceData.map((p) => [p.address.toLowerCase(), p.price]));

    // Calculate vault token values — always override for known vaults, enrich for discovered
    const enrichedChanges = await Promise.all(
      assetChanges.map(async (change): Promise<AssetChange> => {
        const isKnownVault = knownVaultAddresses.has(change.address.toLowerCase());
        const discovered = discoveredVaults.get(change.address.toLowerCase());

        // Skip non-vault tokens entirely
        if (!isKnownVault && !discovered) return change;

        const vault = isKnownVault ? getVaultByAddress(change.address) : null;
        const underlyingAddr = vault ? vault.assetAddress.toLowerCase() : discovered!.underlying;

        try {
          const underlyingAmount = await publicClient.readContract({
            address: change.address as `0x${string}`,
            abi: ERC4626_ABI,
            functionName: "convertToAssets",
            args: [BigInt(change.rawAmount)],
          });

          const underlyingPrice = priceMap.get(underlyingAddr);
          if (underlyingPrice === undefined) return change;

          // Use known vault decimals or previously-discovered decimals (no extra RPC)
          const decimals = vault ? vault.assetDecimals : discovered!.underlyingDecimals;

          const underlyingValue = Number(underlyingAmount) / 10 ** decimals;
          const dollarValue = (underlyingValue * underlyingPrice).toString();

          return { ...change, dollarValue };
        } catch {
          return change;
        }
      })
    );

    return enrichedChanges;
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
    ZAPPER_V3_ADDRESS.toLowerCase(),
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

  const inputToken = body.inputToken?.toLowerCase();
  const shouldOverrideCvx = inputToken === TOKENS.CVX.toLowerCase();
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

  const isDev = process.env.NODE_ENV === "development";
  console.log("[Tenderly] NODE_ENV:", process.env.NODE_ENV, "isDev:", isDev, "save:", isDev);
  const tenderlyRequest = {
    network_id: body.networkId?.toString() ?? "1",
    from: body.from,
    to: body.to,
    input: body.data,
    value: body.value ?? "0",
    gas: body.gas,
    save: true,            // Save simulations so users can view traces
    save_if_fails: true,   // Always save failures for debugging
    simulation_type: "full",
    overrides,
  };

  // Helper to try eth_call as fallback
  async function tryEthCall(): Promise<{ success: boolean; error?: string }> {
    try {
      await publicClient.call({
        account: body.from as `0x${string}`,
        to: body.to as `0x${string}`,
        data: body.data as `0x${string}`,
        value: body.value ? BigInt(body.value) : 0n,
      });
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
    response = await fetch(
      `https://api.tenderly.co/api/v1/account/${accountSlug}/project/${projectSlug}/simulate`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Access-Key": accessKey,
        },
        body: JSON.stringify(tenderlyRequest),
        signal: AbortSignal.timeout(15_000), // 15s timeout — prevent hanging forever
      }
    );
  } catch (error) {
    // Tenderly request failed (network error) - try eth_call fallback
    const ethCallResult = await tryEthCall();
    if (ethCallResult.success) {
      return NextResponse.json(
        {
          success: true,
          simulationUnavailable: true,
          simulationUnavailableReason: error instanceof Error ? error.message : "Tenderly request failed",
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
    return NextResponse.json(
      {
        success: false,
        errorMessage: ethCallResult.error ?? "Transaction would fail",
        retryable: false,
      },
      { status: 400, headers: corsHeaders }
    );
  }

  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;

  // Check for Tenderly API-level errors (quota, auth, etc.) vs transaction failures
  const payloadError = payload?.error as Record<string, unknown> | undefined;
  const errorSlug = payloadError?.slug as string | undefined;
  const isApiError = !response.ok || errorSlug === "quota_limit_reached" || errorSlug === "unauthorized";

  if (isApiError) {
    // Tenderly API error - try eth_call fallback
    console.log("[Tenderly] API error detected, slug:", errorSlug, "response.ok:", response.ok);
    const ethCallResult = await tryEthCall();
    console.log("[Tenderly] eth_call fallback result:", ethCallResult);
    if (ethCallResult.success) {
      const apiErrorMessage = payloadError?.message ?? "Tenderly simulation unavailable";
      console.log("[Tenderly] Falling back to eth_call success, reason:", apiErrorMessage);
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

  // Return a link to our share endpoint which will share and redirect to Tenderly
  const tenderlyUrl = simulationId
    ? `/api/simulate/share/${simulationId}`
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
  const assetChanges = await enrichVaultTokenPrices(processedChanges);

  // Log for debugging (dev only)
  if (isDev) {
    console.log("[Tenderly Simulation]", {
      success: Boolean(response.ok && status),
      simulationId,
      tenderlyUrl,
      gasUsed,
      errorMessage,
      assetChangesCount: assetChanges.length,
    });
  }

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
