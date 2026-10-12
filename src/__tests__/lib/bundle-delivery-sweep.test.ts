// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const {
  mockGetAggregators,
  mockGetRouteData,
  mockGetBundleData,
} = vi.hoisted(() => ({
  mockGetAggregators: vi.fn(),
  mockGetRouteData: vi.fn(),
  mockGetBundleData: vi.fn(),
}));

vi.mock("@ensofinance/sdk", () => ({
  EnsoClient: class MockEnsoClient {
    getAggregators = mockGetAggregators;
    getRouteData = mockGetRouteData;
    getBundleData = mockGetBundleData;
  },
}));

vi.mock("@/lib/zapper", () => ({
  extractInnerSwapData: vi.fn(() => "0xinner"),
}));

vi.mock("@/lib/curve", () => ({
  getCurveGetDy: vi.fn(),
  getCurveGetDyFactory: vi.fn(),
  getEthToCvxEstimate: vi.fn(),
  getStableSwapParams: vi.fn(),
  estimateCryptoSwapOffchain: vi.fn(),
  previewRedeem: vi.fn(async (vaultAddress: string) => {
    const lower = vaultAddress.toLowerCase();
    if (lower === "0xbe53a109b494e5c9f97b9cd39fe969be68bf6204") {
      return "10000000";
    }
    if (lower === "0x95f19b19aff698169a1a0bbc28a2e47b14cb9a86") {
      return "4000000000000000000";
    }
    if (lower === "0x8659fc767cad6005de79af65dafe4249c57927af") {
      return "5000000000000000000";
    }
    return "1000000000000000000";
  }),
  batchRedeemAndEstimateSwap: vi.fn(),
  findPegPoint: vi.fn(() => 0n),
  calculateMinDy: vi.fn((amount: bigint) => amount.toString()),
  validateSlippage: vi.fn((slippage?: string) => Number(slippage ?? "100")),
  cryptoswap: {
    getDy: vi.fn((_params: unknown, i: number, j: number, dx: bigint) => {
      if (i === 0 && j === 1) return dx + (dx / 10n);
      if (i === 1 && j === 0) return dx - (dx / 10n);
      return dx;
    }),
    findPegPoint: vi.fn(() => 0n),
  },
  getCryptoSwapParams: vi.fn(async () => ({})),
}));

import { POST } from "@/app/api/enso/[method]/route";
import { assertValidEnsoIntentRequest } from "@/lib/enso-intents";
import { cryptoswap, estimateCryptoSwapOffchain, findPegPoint, getCurveGetDy, getCurveGetDyFactory, getStableSwapParams } from "@/lib/curve";
import { ASYMMETRY, BEEFY, CONCENTRATOR, CURVE_CONTROLLERS, CURVE_SAVINGS, LLAMA_AIRFORCE, TOKENS, VAULT_ADDRESSES, YEARN } from "@/config/vaults";
import { CRVUSD_ADDRESS, USDC_ADDRESS } from "@/config/addresses";

/**
 * Branch sweep: every intent the app can request x every token combination the request
 * validator accepts x every quote-dependent branch (hybrid swap/mint split on/off,
 * Enso-vs-Curve best quote, amounts either side of the peg point). Each built bundle must
 * deliver its output to the user and never strand tokens in the shared EnsoShortcuts.
 */

const USER = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const SHORTCUTS = "0x4fe93ebc4ce6ae4f81601cc7ce7139023919e003";
const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ONE = 10n ** 18n;

const LIQUID = [ETH, USDC_ADDRESS, TOKENS.CVX, TOKENS.CVXCRV, CRVUSD_ADDRESS, "0x3432B6A60D23Ca0dFCa7761B7ab56459D9C964D0"];
const ILLIQUID = [TOKENS.PXCVX, TOKENS.LPXCVX, TOKENS.CVGCVX];
const YLD = [VAULT_ADDRESSES.YSCVX, VAULT_ADDRESSES.YSCVXCRV, VAULT_ADDRESSES.YSCVGCVX, VAULT_ADDRESSES.YSPXCVX, VAULT_ADDRESSES.YCVXCRV];
const EXTERNAL = [LLAMA_AIRFORCE.UCVX, LLAMA_AIRFORCE.UCRV, CONCENTRATOR.ACVX, CONCENTRATOR.ACRV, ASYMMETRY.AFCVX, BEEFY.MOO_CVX_CRV, BEEFY.MOO_CVX_CVX, CURVE_SAVINGS.SCRVUSD, YEARN.YVUSDC1];
const ALL = [...LIQUID, ...ILLIQUID, ...YLD, ...EXTERNAL];

type Body = Record<string, unknown>;
const pairsOf = (a: string[], b: string[]) => a.flatMap((x) => b.filter((y) => y !== x).map((y) => [x, y] as const));
const INTENTS: Array<[string, (a: string, b: string) => Body]> = [
  ["yldVaultZapIn", (a, b) => ({ inputToken: a, vaultAddress: b })],
  ["yldVaultZapOut", (a, b) => ({ vaultAddress: a, outputToken: b })],
  ["yldVaultToVault", (a, b) => ({ sourceVault: a, targetVault: b })],
  ["yldVaultToCvgCvxVault", (a, b) => ({ sourceVault: a, targetVault: b })],
  ["cvgCvxVaultToYldVault", (a, b) => ({ sourceVault: a, targetVault: b })],
  ["yldVaultToPxCvxVault", (a, b) => ({ sourceVault: a, targetVault: b })],
  ["pxCvxVaultToYldVault", (a, b) => ({ sourceVault: a, targetVault: b })],
  ["cvgCvxZapIn", (a, b) => ({ inputToken: a, vaultAddress: b })],
  ["cvgCvxZapOut", (a, b) => ({ vaultAddress: a, outputToken: b })],
  ["pxCvxZapIn", (a, b) => ({ inputToken: a, vaultAddress: b })],
  ["pxCvxZapOut", (a, b) => ({ vaultAddress: a, outputToken: b })],
  ["externalVaultZapInToYld", (a, b) => ({ externalVaultAddress: a, vaultAddress: b })],
  ["illiquidToYldVault", (a, b) => ({ inputToken: a, vaultAddress: b })],
  ["anyToExternalVault", (a, b) => ({ inputToken: a, externalVaultAddress: b })],
  ["yldVaultToExternalVault", (a, b) => ({ sourceVault: a, targetVault: b })],
  ["yldVaultToIlliquid", (a, b) => ({ sourceVault: a, outputToken: b })],
  ["specialTokenToExternalVault", (a, b) => ({ inputToken: a, outputVault: b })],
  ["specialTokenToIlliquid", (a, b) => ({ inputToken: a, outputToken: b })],
  ["externalVaultToAny", (a, b) => ({ externalVaultAddress: a, outputToken: b })],
  ["illiquidToAny", (a, b) => ({ inputToken: a, outputToken: b })],
  ["anyToIlliquid", (a, b) => ({ inputToken: a, outputToken: b })],
  ["curveLendingRepayWithSwap", (a, b) => ({ tokenIn: a, vaultAddress: b })],
];

/** Input token, output token and the intent body, for every combination the validator accepts. */
function acceptedCases(): Array<{ label: string; input: string; output: string; body: Body }> {
  const cases: Array<{ label: string; input: string; output: string; body: Body }> = [];
  for (const [intent, make] of INTENTS) {
    for (const [a, b] of pairsOf(ALL, [...ALL, ...Object.keys(CURVE_CONTROLLERS)])) {
      const body: Body = { intent, fromAddress: USER, amountIn: ONE.toString(), slippage: "100", receiver: USER, ...make(a, b) };
      try { assertValidEnsoIntentRequest(body); } catch { continue; }
      const output = intent === "curveLendingRepayWithSwap" ? CRVUSD_ADDRESS : b;
      cases.push({ label: `${intent} ${a.slice(0, 8)}->${b.slice(0, 8)}`, input: a, output, body });
    }
  }
  return cases;
}

type Action = { protocol: string; action: string; args: Record<string, unknown> };
const isRef = (v: unknown): v is { useOutputOfCallAt: number } => typeof v === "object" && v !== null && "useOutputOfCallAt" in v;
const lower = (v: unknown) => String(v).toLowerCase();
const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") out.push(v.toLowerCase());
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
};
const refs = (v: unknown, out: number[] = []): number[] => {
  if (isRef(v)) out.push(v.useOutputOfCallAt);
  else if (Array.isArray(v)) v.forEach((x) => refs(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => refs(x, out));
  return out;
};
const GUARDS = new Set(["slippage", "minamountout"]);
const NON_PRODUCING = new Set(["approve", "transfer", "transferfrom", "slippage", "minamountout"]);

/** Violations of the delivery invariants for one built bundle. */
function violations(actions: Action[], input: string): string[] {
  const out: string[] = [];
  actions.forEach((a, i) => {
    if (a.action === "approve" && lower(a.args.spender) === SHORTCUTS) out.push(`#${i} approves EnsoShortcuts`);
    if (a.action === "call" && a.args.method === "approve" && lower((a.args.args as unknown[])?.[0]) === SHORTCUTS) out.push(`#${i} raw-approves EnsoShortcuts`);
    for (const r of refs(a.args)) {
      const src = actions[r];
      if (r >= i) out.push(`#${i} references later #${r}`);
      else if (NON_PRODUCING.has(src.action) || (src.action === "call" && !/\breturns\s*\(/.test(String(src.args.abi)))) {
        out.push(`#${i} references #${r} (${src.action}${src.args.method ? ` ${src.args.method}` : ""}) which returns nothing`);
      }
    }
    // A fixed amount of a token the bundle produced leaves any surplus in EnsoShortcuts.
    if (a.protocol !== "erc20" && typeof a.args.amountIn === "string" && a.args.tokenIn && lower(a.args.tokenIn) !== lower(input) && i > 0) {
      out.push(`#${i} ${a.protocol}/${a.action} spends a fixed ${a.args.amountIn} of intermediate ${a.args.tokenIn}`);
    }
  });
  const terminal = [...actions].reverse().find((a) => !GUARDS.has(a.action));
  if (!terminal) return [...out, "empty bundle"];
  const namesUser = strings(terminal.args).includes(USER);
  const delivers =
    (terminal.protocol === "erc20" && terminal.action === "transfer" && lower(terminal.args.receiver) === USER) ||
    (terminal.protocol === "enso" && terminal.action === "route") ||
    (terminal.protocol !== "enso" && terminal.protocol !== "erc20") || // native deposit/redeem/withdraw
    (terminal.action === "call" && namesUser);
  if (!delivers) out.push(`terminal ${terminal.protocol}/${terminal.action}${terminal.args.method ? ` ${terminal.args.method}` : ""} leaves the output in EnsoShortcuts`);
  return out;
}

// Swap-only vs swap + mint split, Enso-vs-Curve best quote, and amounts either side of the
// mocked 1-token peg point.
const MODES = [
  { split: false, ensoWins: false, amount: ONE / 10n },
  { split: false, ensoWins: true, amount: 10n * ONE },
  { split: true, ensoWins: false, amount: 10n * ONE },
  { split: true, ensoWins: true, amount: 10n * ONE },
];

// Known open violations. Each must still reproduce, so fixing one forces its removal here.
const KNOWN_ISSUES: Array<{ intent: string; violation: RegExp; note: string }> = [
  {
    intent: "curveLendingRepayWithSwap",
    violation: /references #\d+ \(call withdraw\) which returns nothing/,
    note: "uCRV/Beefy repay tokens: route refs a void withdraw (uCRV also withdraws to the user). Enso rejects the build, so it fails closed.",
  },
];

function applyMode(mode: (typeof MODES)[number]): void {
  vi.clearAllMocks();
  vi.stubEnv("ENSO_API_KEY", "test-key");
  const peg = mode.split ? ONE : 0n;
  vi.mocked(cryptoswap.findPegPoint).mockReturnValue(peg);
  vi.mocked(findPegPoint).mockReturnValue(peg);
  vi.mocked(cryptoswap.getDy).mockImplementation((_p: unknown, i: number, j: number, dx: bigint) =>
    i === 0 && j === 1 ? (mode.split && dx > ONE ? (dx * 9n) / 10n : (dx * 11n) / 10n) : i === 1 && j === 0 ? dx - dx / 10n : dx);
  vi.mocked(estimateCryptoSwapOffchain).mockResolvedValue(5n * 10n ** 15n);
  vi.mocked(getStableSwapParams).mockResolvedValue({ balances: [0n, 0n], A: 0n, Ann: 0n, fee: 0n, offpegFeeMultiplier: 0n });
  vi.mocked(getCurveGetDy).mockImplementation(async (_pool: string, i: number, j: number, amount: string) =>
    i === 0 && j === 1 ? BigInt(amount) + BigInt(amount) / 10n : BigInt(amount));
  vi.mocked(getCurveGetDyFactory).mockImplementation(async (_pool: string, _i: number, _j: number, amount: string) => BigInt(amount));
  mockGetBundleData.mockResolvedValue({ tx: { to: "0xrouter", data: "0xdeadbeef", value: 0, from: USER }, gas: 1, amountsOut: {}, priceImpact: 0 });
  mockGetAggregators.mockResolvedValue(["0x", "kyberswap", "grapher", "openocean"]);
  mockGetRouteData.mockImplementation(async () => ({
    amountOut: mode.ensoWins ? (10n ** 30n).toString() : "1",
    gas: "1",
    priceImpact: 0,
    tx: { to: "0xroute", data: "0x1", value: "0" },
    route: mode.ensoWins ? [{ protocol: "grapher", action: "swap" }] : [],
  }));
  const word = `0x${(5n * ONE).toString(16).padStart(64, "0")}`;
  globalThis.fetch = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const reply = (req: { id?: number }) => ({ jsonrpc: "2.0", id: req.id, result: word });
    return { ok: true, json: async () => (Array.isArray(body) ? body.map(reply) : reply(body)) } as unknown as Response;
  }) as unknown as typeof fetch;
}

let ip = 0;
async function build(body: Body, amount: bigint): Promise<{ actions: Action[] | null; error?: string }> {
  const res = await POST(new Request("https://yldfi.co/api/enso/intent", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://yldfi.co", "x-forwarded-for": `10.0.${(++ip >> 8) & 255}.${ip & 255}` },
    body: JSON.stringify({ ...body, amountIn: amount.toString() }),
  }) as never, { params: Promise.resolve({ method: "intent" }) });
  const calls = mockGetBundleData.mock.calls;
  const actions = calls.length ? (calls[calls.length - 1][1] as Action[]) : null;
  return { actions, error: res.status >= 400 ? String(((await res.json()) as { error?: unknown }).error) : undefined };
}

describe("bundle delivery sweep", () => {
  const cases = acceptedCases();

  it("covers every accepted intent combination", () => {
    expect(cases.length).toBeGreaterThan(100);
  });

  it("delivers every bundle's output to the user across all quote-dependent branches", async () => {
    const report: string[] = [];
    let built = 0;
    for (const mode of MODES) {
      for (const c of cases) {
        applyMode(mode);
        const { actions, error } = await build(c.body, mode.amount);
        if (!actions) continue; // no bundle built (plain route, or rejected before building)
        built++;
        for (const v of violations(actions, c.input)) report.push(`${c.label} [split=${mode.split} enso=${mode.ensoWins} amt=${mode.amount}] ${v}${error ? ` (response: ${error.slice(0, 60)})` : ""}`);
      }
    }
    if (process.env.SWEEP_OUT) (await import("fs")).writeFileSync(process.env.SWEEP_OUT, [...new Set(report)].join("\n"));
    expect(built).toBeGreaterThan(1000);
    const isKnown = (line: string) => KNOWN_ISSUES.some((k) => line.startsWith(`${k.intent} `) && k.violation.test(line));
    expect([...new Set(report)].filter((line) => !isKnown(line))).toEqual([]);
    for (const known of KNOWN_ISSUES) {
      expect(report.some((line) => line.startsWith(`${known.intent} `) && known.violation.test(line)),
        `known issue no longer reproduces, remove it from KNOWN_ISSUES: ${known.note}`).toBe(true);
    }
  }, 600_000);
});
