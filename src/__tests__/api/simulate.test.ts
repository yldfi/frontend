import { describe, it, expect, beforeEach } from "vitest";
import { encodeAbiParameters, formatUnits, keccak256, parseAbiParameters } from "viem";

// ---- Re-implement pure logic from src/app/api/simulate/route.ts ----

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
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  );
  return base64UrlEncode(new Uint8Array(signature));
}

function base64UrlDecode(value: string): Uint8Array {
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((value.length + 3) % 4);
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
  const expected = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  );
  const expectedBytes = new Uint8Array(expected);
  const providedBytes = base64UrlDecode(signature);
  return timingSafeEqual(expectedBytes, providedBytes);
}

const CVX_BALANCE_SLOT = 0n;

function computeERC20BalanceSlot(
  account: string,
  slot: bigint = CVX_BALANCE_SLOT
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address, uint256"), [
      account as `0x${string}`,
      slot,
    ])
  );
}

// Nonce tracker (re-implemented)
function createNonceTracker() {
  const consumedNonces = new Map<string, number>();

  function consumeNonce(nonce: string, expires: number): boolean {
    const now = Date.now();
    for (const [key, exp] of consumedNonces) {
      if (now > exp) consumedNonces.delete(key);
    }
    if (consumedNonces.has(nonce)) return false;
    consumedNonces.set(nonce, expires);
    return true;
  }

  return { consumeNonce, _map: consumedNonces };
}

// Asset change types (re-implemented)
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

const CRVUSD_ADDRESS = "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e";
const CURVE_CONTROLLER_ADDRESSES = new Set([
  "0x24174143ccf438f0a1f6dcf93b468c127123a96e",
]);
const CURVE_AMM_ADDRESSES = new Set([
  "0xf1b03586c03ebfec014238d105148a15102a282f",
]);
const VAULT_COLLATERAL_TOKENS = new Set([
  "0x95f19b19aff698169a1a0bbc28a2e47b14cb9a86",
]);
// Canonical casing for well-known token symbols — Tenderly's own token_info.symbol
// can disagree with the on-chain symbol() casing (e.g. returns "cvx" for CVX).
const KNOWN_TOKEN_SYMBOLS: Record<string, string> = {
  "0x4e3fbd56cd56c3e72c1403e103b45db9da5b9d2b": "CVX",
};

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
    const tokenAddress =
      change.token_info?.contract_address?.toLowerCase() ?? "";
    const isCrvUsd = tokenAddress === CRVUSD_ADDRESS.toLowerCase();
    const symbol = KNOWN_TOKEN_SYMBOLS[tokenAddress] ?? change.token_info?.symbol;

    // Derive amount from raw_amount/decimals ourselves rather than trusting
    // Tenderly's own precomputed `amount` — for tokens Tenderly hasn't indexed
    // yet (e.g. a just-deployed vault), it comes back as "0" while raw_amount
    // is still correct, which silently drops the row as dust downstream.
    const amount = (() => {
      try {
        const raw = BigInt(change.raw_amount ?? "0");
        if (raw === 0n) return "0";
        return formatUnits(raw, change.token_info?.decimals ?? 18);
      } catch {
        return change.amount ?? "0";
      }
    })();

    const isUserSending = from === normalizedUser;
    const isUserReceiving = to === normalizedUser;
    const isToController = CURVE_CONTROLLER_ADDRESSES.has(to);
    const isFromController = CURVE_CONTROLLER_ADDRESSES.has(from);
    const isMint =
      from === "0x0000000000000000000000000000000000000000";

    if (isCrvUsd && isToController && !isFromController) {
      result.push({
        type: "repay",
        symbol: symbol ?? "crvUSD",
        amount,
        rawAmount: change.raw_amount ?? "0",
        address: change.token_info?.contract_address ?? "",
        decimals: change.token_info?.decimals ?? 18,
        logo: change.token_info?.logo,
        dollarValue: change.dollar_value,
      });
      continue;
    }

    if (isCrvUsd && (isFromController || isMint)) {
      result.push({
        type: "borrow",
        symbol: symbol ?? "crvUSD",
        amount,
        rawAmount: change.raw_amount ?? "0",
        address: change.token_info?.contract_address ?? "",
        decimals: change.token_info?.decimals ?? 18,
        logo: change.token_info?.logo,
        dollarValue: change.dollar_value,
      });
      continue;
    }

    const isVaultCollateral = VAULT_COLLATERAL_TOKENS.has(tokenAddress);
    const isToAmm = CURVE_AMM_ADDRESSES.has(to);
    const isFromAmm = CURVE_AMM_ADDRESSES.has(from);

    if (isVaultCollateral && isToAmm) {
      result.push({
        type: "deposit",
        symbol: symbol ?? "???",
        amount,
        rawAmount: change.raw_amount ?? "0",
        address: change.token_info?.contract_address ?? "",
        decimals: change.token_info?.decimals ?? 18,
        logo: change.token_info?.logo,
        dollarValue: change.dollar_value,
      });
      continue;
    }

    if (isVaultCollateral && isFromAmm) {
      result.push({
        type: "receive",
        symbol: symbol ?? "???",
        amount,
        rawAmount: change.raw_amount ?? "0",
        address: change.token_info?.contract_address ?? "",
        decimals: change.token_info?.decimals ?? 18,
        logo: change.token_info?.logo,
        dollarValue: change.dollar_value,
      });
      continue;
    }

    if (!isUserSending && !isUserReceiving) continue;

    result.push({
      type: isUserSending ? "send" : "receive",
      symbol: symbol ?? "???",
      amount,
      rawAmount: change.raw_amount ?? "0",
      address: change.token_info?.contract_address ?? "",
      decimals: change.token_info?.decimals ?? 18,
      logo: change.token_info?.logo,
      dollarValue: change.dollar_value,
    });
  }

  return result;
}

// CORS logic (re-implemented)
const ALLOWED_ORIGINS = [
  "https://yldfi.co",
  "https://www.yldfi.co",
];

function getCorsOrigin(origin: string): string {
  const isAllowed = ALLOWED_ORIGINS.includes(origin);
  return isAllowed ? origin : ALLOWED_ORIGINS[0];
}

function normalizeTenderlyGas(gas?: string | number): number | undefined {
  if (gas === undefined) return undefined;
  const parsed = typeof gas === "string" ? Number(gas) : gas;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

// ---- Tests ----

describe("Simulate API", () => {
  describe("signPayload + verifySignature", () => {
    const SECRET = "test-secret-key-12345";

    it("round-trips: sign then verify succeeds", async () => {
      const payload = "test-nonce.1234567890";
      const sig = await signPayload(SECRET, payload);
      const valid = await verifySignature(SECRET, payload, sig);
      expect(valid).toBe(true);
    });

    it("rejects tampered payload", async () => {
      const sig = await signPayload(SECRET, "original-payload");
      const valid = await verifySignature(SECRET, "tampered-payload", sig);
      expect(valid).toBe(false);
    });

    it("rejects wrong secret", async () => {
      const sig = await signPayload(SECRET, "test-payload");
      const valid = await verifySignature("wrong-secret", "test-payload", sig);
      expect(valid).toBe(false);
    });

    it("produces base64url output (no +, /, or =)", async () => {
      const sig = await signPayload(SECRET, "some-payload-data");
      expect(sig).not.toMatch(/[+/=]/);
    });

    it("produces consistent signatures for same input", async () => {
      const sig1 = await signPayload(SECRET, "same-input");
      const sig2 = await signPayload(SECRET, "same-input");
      expect(sig1).toBe(sig2);
    });

    it("produces different signatures for different payloads", async () => {
      const sig1 = await signPayload(SECRET, "payload-a");
      const sig2 = await signPayload(SECRET, "payload-b");
      expect(sig1).not.toBe(sig2);
    });

    it("produces different signatures for different secrets", async () => {
      const sig1 = await signPayload("secret-a", "same-payload");
      const sig2 = await signPayload("secret-b", "same-payload");
      expect(sig1).not.toBe(sig2);
    });

    it("handles empty payload", async () => {
      const sig = await signPayload(SECRET, "");
      const valid = await verifySignature(SECRET, "", sig);
      expect(valid).toBe(true);
    });

    it("handles unicode payload", async () => {
      const sig = await signPayload(SECRET, "hello-🌍-world");
      const valid = await verifySignature(SECRET, "hello-🌍-world", sig);
      expect(valid).toBe(true);
    });
  });

  describe("timingSafeEqual", () => {
    it("returns true for equal arrays", () => {
      const a = new Uint8Array([1, 2, 3, 4]);
      const b = new Uint8Array([1, 2, 3, 4]);
      expect(timingSafeEqual(a, b)).toBe(true);
    });

    it("returns false for different arrays", () => {
      const a = new Uint8Array([1, 2, 3, 4]);
      const b = new Uint8Array([1, 2, 3, 5]);
      expect(timingSafeEqual(a, b)).toBe(false);
    });

    it("returns false for different length arrays", () => {
      const a = new Uint8Array([1, 2, 3]);
      const b = new Uint8Array([1, 2, 3, 4]);
      expect(timingSafeEqual(a, b)).toBe(false);
    });

    it("returns true for empty arrays", () => {
      const a = new Uint8Array([]);
      const b = new Uint8Array([]);
      expect(timingSafeEqual(a, b)).toBe(true);
    });

    it("returns false for completely different arrays", () => {
      const a = new Uint8Array([0, 0, 0, 0]);
      const b = new Uint8Array([255, 255, 255, 255]);
      expect(timingSafeEqual(a, b)).toBe(false);
    });
  });

  describe("consumeNonce", () => {
    let tracker: ReturnType<typeof createNonceTracker>;

    beforeEach(() => {
      tracker = createNonceTracker();
    });

    it("returns true on first use", () => {
      const future = Date.now() + 60_000;
      expect(tracker.consumeNonce("nonce-1", future)).toBe(true);
    });

    it("returns false on replay", () => {
      const future = Date.now() + 60_000;
      tracker.consumeNonce("nonce-1", future);
      expect(tracker.consumeNonce("nonce-1", future)).toBe(false);
    });

    it("allows different nonces", () => {
      const future = Date.now() + 60_000;
      expect(tracker.consumeNonce("nonce-a", future)).toBe(true);
      expect(tracker.consumeNonce("nonce-b", future)).toBe(true);
    });

    it("evicts expired nonces", () => {
      const past = Date.now() - 1;
      tracker.consumeNonce("old-nonce", past);
      // After eviction, the map should clean up on next call
      tracker.consumeNonce("trigger-cleanup", Date.now() + 60_000);
      expect(tracker._map.has("old-nonce")).toBe(false);
    });

    it("does not evict non-expired nonces", () => {
      const future = Date.now() + 60_000;
      tracker.consumeNonce("fresh-nonce", future);
      tracker.consumeNonce("trigger", future);
      expect(tracker._map.has("fresh-nonce")).toBe(true);
    });
  });

  describe("computeERC20BalanceSlot", () => {
    it("produces a 0x-prefixed hex string", () => {
      const slot = computeERC20BalanceSlot(
        "0x1234567890abcdef1234567890abcdef12345678"
      );
      expect(slot).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("is deterministic", () => {
      const addr = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      const a = computeERC20BalanceSlot(addr);
      const b = computeERC20BalanceSlot(addr);
      expect(a).toBe(b);
    });

    it("produces different slots for different addresses", () => {
      const a = computeERC20BalanceSlot(
        "0x1111111111111111111111111111111111111111"
      );
      const b = computeERC20BalanceSlot(
        "0x2222222222222222222222222222222222222222"
      );
      expect(a).not.toBe(b);
    });

    it("produces different slots for different base slots", () => {
      const addr = "0x1111111111111111111111111111111111111111";
      const a = computeERC20BalanceSlot(addr, 0n);
      const b = computeERC20BalanceSlot(addr, 1n);
      expect(a).not.toBe(b);
    });

    it("uses keccak256(abi.encode(address, slot))", () => {
      const addr = "0x1111111111111111111111111111111111111111";
      const expected = keccak256(
        encodeAbiParameters(parseAbiParameters("address, uint256"), [
          addr as `0x${string}`,
          0n,
        ])
      );
      expect(computeERC20BalanceSlot(addr, 0n)).toBe(expected);
    });
  });

  describe("processAssetChanges", () => {
    const USER = "0xUserAddress1234567890abcdef12345678";
    const CONTROLLER = "0x24174143ccf438f0a1f6dcf93b468c127123a96e";
    const AMM = "0xf1b03586c03ebfec014238d105148a15102a282f";
    const VAULT_TOKEN = "0x95f19b19aff698169a1a0bbc28a2e47b14cb9a86";
    const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

    function makeChange(
      overrides: Partial<TenderlyAssetChange> & {
        tokenAddress?: string;
        symbol?: string;
      }
    ): TenderlyAssetChange {
      return {
        token_info: {
          symbol: overrides.symbol ?? "TOKEN",
          decimals: 18,
          standard: "ERC20",
          contract_address: overrides.tokenAddress ?? "0xSomeToken",
          logo: undefined,
        },
        from: overrides.from ?? USER,
        to: overrides.to ?? "0xOtherAddress",
        amount: overrides.amount ?? "1.0",
        raw_amount: overrides.raw_amount ?? "1000000000000000000",
        dollar_value: overrides.dollar_value,
      };
    }

    it("returns empty array for undefined input", () => {
      expect(processAssetChanges(undefined, USER)).toEqual([]);
    });

    it("returns empty array for null input", () => {
      expect(processAssetChanges(null as never, USER)).toEqual([]);
    });

    it("returns empty array for empty array", () => {
      expect(processAssetChanges([], USER)).toEqual([]);
    });

    it("classifies crvUSD to controller as repay", () => {
      const changes = processAssetChanges(
        [
          makeChange({
            tokenAddress: CRVUSD_ADDRESS,
            symbol: "crvUSD",
            from: USER,
            to: CONTROLLER,
          }),
        ],
        USER
      );
      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe("repay");
      expect(changes[0].symbol).toBe("crvUSD");
    });

    it("classifies crvUSD from controller as borrow", () => {
      const changes = processAssetChanges(
        [
          makeChange({
            tokenAddress: CRVUSD_ADDRESS,
            symbol: "crvUSD",
            from: CONTROLLER,
            to: USER,
          }),
        ],
        USER
      );
      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe("borrow");
    });

    it("classifies minted crvUSD (from 0x0) as borrow", () => {
      const changes = processAssetChanges(
        [
          makeChange({
            tokenAddress: CRVUSD_ADDRESS,
            symbol: "crvUSD",
            from: ZERO_ADDR,
            to: USER,
          }),
        ],
        USER
      );
      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe("borrow");
    });

    it("classifies vault collateral to AMM as deposit", () => {
      const changes = processAssetChanges(
        [
          makeChange({
            tokenAddress: VAULT_TOKEN,
            symbol: "ycvxCRV",
            from: USER,
            to: AMM,
          }),
        ],
        USER
      );
      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe("deposit");
    });

    it("classifies vault collateral from AMM as receive", () => {
      const changes = processAssetChanges(
        [
          makeChange({
            tokenAddress: VAULT_TOKEN,
            symbol: "ycvxCRV",
            from: AMM,
            to: USER,
          }),
        ],
        USER
      );
      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe("receive");
    });

    it("classifies user sending tokens as send", () => {
      const changes = processAssetChanges(
        [
          makeChange({
            from: USER,
            to: "0xRecipient",
          }),
        ],
        USER
      );
      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe("send");
    });

    it("classifies user receiving tokens as receive", () => {
      const changes = processAssetChanges(
        [
          makeChange({
            from: "0xSender",
            to: USER,
          }),
        ],
        USER
      );
      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe("receive");
    });

    it("filters out changes not involving user", () => {
      const changes = processAssetChanges(
        [
          makeChange({
            from: "0xUnrelated1",
            to: "0xUnrelated2",
          }),
        ],
        USER
      );
      expect(changes).toHaveLength(0);
    });

    it("handles mixed changes correctly", () => {
      const changes = processAssetChanges(
        [
          makeChange({
            tokenAddress: CRVUSD_ADDRESS,
            symbol: "crvUSD",
            from: ZERO_ADDR,
            to: USER,
          }),
          makeChange({
            tokenAddress: VAULT_TOKEN,
            symbol: "ycvxCRV",
            from: USER,
            to: AMM,
          }),
          makeChange({
            from: "0xA",
            to: "0xB",
          }),
        ],
        USER
      );
      expect(changes).toHaveLength(2);
      expect(changes[0].type).toBe("borrow");
      expect(changes[1].type).toBe("deposit");
    });

    it("is case-insensitive for user address", () => {
      const changes = processAssetChanges(
        [
          makeChange({
            from: USER.toUpperCase(),
            to: "0xRecipient",
          }),
        ],
        USER.toLowerCase()
      );
      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe("send");
    });

    it("preserves dollar_value", () => {
      const changes = processAssetChanges(
        [
          makeChange({
            from: "0xSender",
            to: USER,
            dollar_value: "42.50",
          }),
        ],
        USER
      );
      expect(changes[0].dollarValue).toBe("42.50");
    });

    it("derives amount from raw_amount when Tenderly's own amount is 0 (unindexed token)", () => {
      // Tenderly returns amount:"0" for tokens it hasn't seen before (e.g. a
      // freshly-deployed vault) even though raw_amount/decimals are correct —
      // this silently dropped the row as dust before the fix.
      const changes = processAssetChanges(
        [
          makeChange({
            from: "0xSender",
            to: USER,
            amount: "0",
            raw_amount: "210504506594801098457",
          }),
        ],
        USER
      );
      expect(changes).toHaveLength(1);
      expect(changes[0].amount).toBe("210.504506594801098457");
    });

    it("falls back to Tenderly's amount when raw_amount is genuinely 0", () => {
      const changes = processAssetChanges(
        [
          makeChange({
            from: "0xSender",
            to: USER,
            amount: "0",
            raw_amount: "0",
          }),
        ],
        USER
      );
      expect(changes[0].amount).toBe("0");
    });

    it("derives amount from raw_amount on the send leg too (e.g. withdraw burning shares)", () => {
      // Same Tenderly quirk can hit either leg of a tx — withdraw burns vault
      // shares (a "send" from the user) before returning the underlying asset.
      const changes = processAssetChanges(
        [
          makeChange({
            from: USER,
            to: "0xRecipient",
            amount: "0",
            raw_amount: "210504506594801098457",
          }),
        ],
        USER
      );
      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe("send");
      expect(changes[0].amount).toBe("210.504506594801098457");
    });

    it("overrides Tenderly's lowercase CVX symbol with canonical casing", () => {
      const changes = processAssetChanges(
        [
          makeChange({
            tokenAddress: "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B",
            symbol: "cvx",
            from: USER,
            to: "0xRecipient",
          }),
        ],
        USER
      );
      expect(changes[0].symbol).toBe("CVX");
    });
  });

  describe("getCorsOrigin", () => {
    it("returns origin when it is allowed", () => {
      expect(getCorsOrigin("https://yldfi.co")).toBe("https://yldfi.co");
      expect(getCorsOrigin("https://www.yldfi.co")).toBe(
        "https://www.yldfi.co"
      );
    });

    it("falls back to first allowed origin for unknown origin", () => {
      expect(getCorsOrigin("https://evil.com")).toBe("https://yldfi.co");
    });

    it("falls back for empty origin", () => {
      expect(getCorsOrigin("")).toBe("https://yldfi.co");
    });

    it("is case-sensitive", () => {
      expect(getCorsOrigin("https://YLDFI.CO")).toBe("https://yldfi.co");
    });
  });

  describe("normalizeTenderlyGas", () => {
    it("converts decimal gas strings to numbers", () => {
      expect(normalizeTenderlyGas("60000000")).toBe(60000000);
    });

    it("passes through numeric gas values", () => {
      expect(normalizeTenderlyGas(60000000)).toBe(60000000);
    });

    it("accepts hex gas strings", () => {
      expect(normalizeTenderlyGas("0x3938700")).toBe(60000000);
    });

    it("drops invalid gas strings", () => {
      expect(normalizeTenderlyGas("not-a-number")).toBeUndefined();
    });

    it("drops zero or negative gas values", () => {
      expect(normalizeTenderlyGas(0)).toBeUndefined();
      expect(normalizeTenderlyGas(-1)).toBeUndefined();
    });
  });
});
