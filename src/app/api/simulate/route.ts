import { NextRequest, NextResponse } from "next/server";
import { encodeAbiParameters, keccak256, pad, parseAbiParameters, toHex } from "viem";
import { TOKENS } from "@/config/vaults";

export const dynamic = "force-dynamic";

const ENSO_ROUTER = "0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E";
const ENSO_ROUTER_EXECUTOR = "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf";
const CVX_BALANCE_SLOT = 0n;
const CVX_ALLOWANCE_SLOT = 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_REQUESTS_PER_MINUTE = 8;
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
    save: isDev,
    save_if_fails: isDev,
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
  const tenderlyUrl = simulationId
    ? `https://dashboard.tenderly.co/${accountSlug}/${projectSlug}/simulator/${simulationId}`
    : null;
  const payloadError = payload?.error as Record<string, unknown> | undefined;
  const errorMessage =
    simulation?.error_message ??
    simulation?.error ??
    payloadError?.message ??
    (response.ok ? null : "Tenderly simulation failed");
  const retryable = !response.ok;

  // Log for debugging (dev only)
  if (isDev) {
    console.log("[Tenderly Simulation]", {
      success: Boolean(response.ok && status),
      simulationId,
      tenderlyUrl,
      gasUsed,
      errorMessage,
    });
  }

  return NextResponse.json(
    {
      success: Boolean(response.ok && status),
      status: Boolean(status),
      gasUsed,
      errorMessage,
      retryable,
      ...(isDev && { simulationId, tenderlyUrl }),
    },
    { status: response.ok ? 200 : 502 }
  );
}
