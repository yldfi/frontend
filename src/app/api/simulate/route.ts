import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, encodeAbiParameters, http, keccak256, pad, parseAbiParameters, toHex } from "viem";
import { mainnet } from "viem/chains";
import { TOKENS, getVaultByAddress } from "@/config/vaults";
import { fetchTokenPrices } from "@/lib/enso";

export const dynamic = "force-dynamic";

const ENSO_ROUTER = "0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E";
const ENSO_ROUTER_EXECUTOR = "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf";
const CVX_BALANCE_SLOT = 0n;
const CVX_ALLOWANCE_SLOT = 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_REQUESTS_PER_MINUTE = 8;
const RATE_LIMIT_WINDOW_MS = 60_000;

// ERC4626 ABI for convertToAssets
const ERC4626_ABI = [
  {
    inputs: [{ name: "shares", type: "uint256" }],
    name: "convertToAssets",
    outputs: [{ name: "assets", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Create public client for RPC calls
const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(),
});

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
  type: "send" | "receive";
  symbol: string;
  amount: string;
  rawAmount: string;
  address: string;
  decimals: number;
  logo?: string;
  dollarValue?: string;
}

function processAssetChanges(
  assetChanges: TenderlyAssetChange[] | undefined,
  userAddress: string
): AssetChange[] {
  if (!assetChanges || !Array.isArray(assetChanges)) return [];

  const normalizedUser = userAddress.toLowerCase();
  const result: AssetChange[] = [];

  for (const change of assetChanges) {
    const isUserSending = change.from?.toLowerCase() === normalizedUser;
    const isUserReceiving = change.to?.toLowerCase() === normalizedUser;

    // Only include changes where user is sender or receiver
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
 * Tenderly doesn't have prices for our vault tokens (yscvgCVX, yscvxCRV, yspxCVX), so we calculate them.
 */
async function enrichVaultTokenPrices(assetChanges: AssetChange[]): Promise<AssetChange[]> {
  try {
    // Find vault tokens without prices
    const vaultTokensToPrice = assetChanges.filter((change) => {
      if (change.dollarValue && parseFloat(change.dollarValue) > 0) return false;
      return getVaultByAddress(change.address) !== undefined;
    });

    if (vaultTokensToPrice.length === 0) return assetChanges;

    // Get unique underlying token addresses
    const underlyingAddresses = new Set<string>();
    for (const change of vaultTokensToPrice) {
      const vault = getVaultByAddress(change.address);
      if (vault) {
        underlyingAddresses.add(vault.assetAddress.toLowerCase());
      }
    }

    // Fetch underlying token prices from Enso
    const priceData = await fetchTokenPrices([...underlyingAddresses]);
    const priceMap = new Map(priceData.map((p) => [p.address.toLowerCase(), p.price]));

    // Calculate vault token values
    const enrichedChanges = await Promise.all(
      assetChanges.map(async (change): Promise<AssetChange> => {
        // Skip if already has a price
        if (change.dollarValue && parseFloat(change.dollarValue) > 0) return change;

        const vault = getVaultByAddress(change.address);
        if (!vault) return change;

        try {
          // Get underlying amount via convertToAssets
          const underlyingAmount = await publicClient.readContract({
            address: change.address as `0x${string}`,
            abi: ERC4626_ABI,
            functionName: "convertToAssets",
            args: [BigInt(change.rawAmount)],
          });

          // Get underlying price from Enso
          const underlyingPrice = priceMap.get(vault.assetAddress.toLowerCase());
          if (underlyingPrice === undefined) return change;

          // Calculate USD value: underlyingAmount / 10^decimals × price
          const underlyingValue = Number(underlyingAmount) / 10 ** vault.assetDecimals;
          const dollarValue = (underlyingValue * underlyingPrice).toString();

          return { ...change, dollarValue };
        } catch {
          // If RPC call fails, return unchanged
          return change;
        }
      })
    );

    return enrichedChanges;
  } catch {
    // If price enrichment fails entirely, return original asset changes
    return assetChanges;
  }
}

export async function POST(request: NextRequest) {
  const clientIp = getClientIp(request);
  if (isRateLimited(clientIp)) {
    return NextResponse.json(
      { success: false, errorMessage: "Rate limit exceeded", retryable: true },
      { status: 429 }
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
      { status: 500 }
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
      { status: 400 }
    );
  }

  if (!body?.from || !body?.to || !body?.data) {
    return NextResponse.json(
      { success: false, errorMessage: "Missing from/to/data", retryable: false },
      { status: 400 }
    );
  }

  const nonceSecret = process.env.SIMULATION_NONCE_SECRET;
  if (!nonceSecret) {
    return NextResponse.json(
      { success: false, errorMessage: "Nonce secret not configured", retryable: true },
      { status: 500 }
    );
  }

  if (!body.nonce || !body.expires || !body.sig) {
    return NextResponse.json(
      { success: false, errorMessage: "Missing nonce", retryable: false },
      { status: 400 }
    );
  }

  if (Date.now() > body.expires) {
    return NextResponse.json(
      { success: false, errorMessage: "Nonce expired", retryable: false },
      { status: 400 }
    );
  }

  const noncePayload = `${body.nonce}.${body.expires}`;
  const nonceOk = await verifySignature(nonceSecret, noncePayload, body.sig);
  if (!nonceOk) {
    return NextResponse.json(
      { success: false, errorMessage: "Invalid nonce", retryable: false },
      { status: 400 }
    );
  }

  if (body.to.toLowerCase() !== ENSO_ROUTER_EXECUTOR.toLowerCase()) {
    return NextResponse.json(
      { success: false, errorMessage: "Unsupported simulation target", retryable: false },
      { status: 400 }
    );
  }

  if (!body.data.startsWith("0x") || body.data.length < 10) {
    return NextResponse.json(
      { success: false, errorMessage: "Invalid calldata", retryable: false },
      { status: 400 }
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
  const tenderlyRequest = {
    network_id: body.networkId?.toString() ?? "1",
    from: body.from,
    to: body.to,
    input: body.data,
    value: body.value ?? "0",
    gas: body.gas,
    save: isDev,           // Only save successful simulations in dev
    save_if_fails: true,   // Always save failures for debugging
    simulation_type: "full",
    overrides,
  };

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
      }
    );
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        errorMessage:
          error instanceof Error ? error.message : "Tenderly request failed",
        retryable: true,
      },
      { status: 502 }
    );
  }

  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
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
  const payloadError = payload?.error as Record<string, unknown> | undefined;
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
    { status: response.ok ? 200 : 502 }
  );
}
