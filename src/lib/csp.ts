/**
 * Report-only Content-Security-Policy.
 *
 * The policy is sent as `Content-Security-Policy-Report-Only`: browsers evaluate
 * it and log violations in the console ("[Report Only] Refused to …") but block
 * nothing. It is not enforced yet; enforcing it is a separate decision made from
 * what the console shows.
 *
 * `script-src` keeps `'unsafe-inline'` on purpose: pages are prerendered static
 * assets, so a per-request nonce cannot be injected into them. The policy still
 * restricts script hosts, plugins, base URI, form targets and network
 * destinations.
 *
 * Only origins belong in the policy: an RPC URL can carry an API key in its
 * path, so every URL is reduced with `originOf`.
 */
import {
  FLASHBOTS_RPC_URL,
  PRIVACY_SAFE_DOMAINS,
  RPC_URL_LIST,
} from "@/config/rpc";

export interface ReportOnlyCspOptions {
  isDev: boolean;
  extraConnectSrc?: readonly string[];
}

/** Plain http(s)/ws(s) origins: no credentials, paths, queries or fragments. */
const ORIGIN_PATTERN = /^(https?|wss?):\/\/[A-Za-z0-9.-]+(:\d+)?$/;

/**
 * `new URL(value).origin`, or nothing when the value is not a valid URL or its
 * origin is not a plain http(s)/ws(s) host. This drops `"null"` origins from
 * non-http schemes, and hosts that contain separators such as `;`.
 */
export function originOf(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const { origin } = new URL(value);
    return ORIGIN_PATTERN.test(origin) ? [origin] : [];
  } catch {
    return [];
  }
}

/** RPC endpoints the browser talks to directly (src/config/rpc.ts:6-12,20). */
const RPC_CONNECT_SRC: readonly string[] = [
  ...RPC_URL_LIST,
  FLASHBOTS_RPC_URL,
].flatMap(originOf);

/** Hosts dynamic RPC discovery may select (src/config/rpc.ts:27-37). */
const DISCOVERY_RPC_CONNECT_SRC: readonly string[] = [...PRIVACY_SAFE_DOMAINS]
  .map((host) => `https://${host}`)
  .flatMap(originOf);

/** Browser-side fetches found in src/. */
const BROWSER_FETCH_CONNECT_SRC: readonly string[] = [
  "https://chainid.network", // Dynamic RPC discovery, src/config/rpc.ts:46.
  "https://api.safe.global", // Safe Transaction Service, src/lib/safe-tx-service.ts:12.
  "https://api.curve.finance", // src/hooks/useCurveLendingData.ts:91.
  "https://prices.curve.finance", // src/hooks/useOraclePriceHistory.ts:9.
  "https://data.yldfi.co", // src/hooks/useVolumeProfile.ts:6, src/hooks/useR2PriceHistory.ts:6.
  "https://api.coingecko.com", // src/hooks/useTokenMetadata.ts:39.
  // HEAD probes, so `img-src` does not cover them: src/hooks/useTokenMetadata.ts:22,24.
  "https://raw.githubusercontent.com",
  "https://tokens.1inch.io",
];

/** Google Analytics collection. // candidate: confirm from console reports */
const ANALYTICS_CONNECT_SRC: readonly string[] = [
  "https://www.googletagmanager.com", // src/components/GoogleAnalytics.tsx:90.
  "https://www.google-analytics.com",
  "https://*.google-analytics.com",
  "https://*.analytics.google.com",
];

/** WalletConnect / Reown. // candidate: confirm from console reports */
const WALLET_CONNECT_SRC: readonly string[] = [
  "https://*.walletconnect.com",
  "https://*.walletconnect.org",
  "wss://*.walletconnect.com",
  "wss://*.walletconnect.org",
  "https://*.web3modal.org",
  "https://*.reown.com",
];

/** Coinbase Wallet SDK hosts. // candidate: confirm from console reports */
const COINBASE_WALLET_CONNECT_SRC: readonly string[] = [
  "https://*.coinbase.com",
  "https://www.walletlink.org",
  "wss://www.walletlink.org",
];

/** Local dev servers and the Anvil fork. */
const DEV_CONNECT_SRC: readonly string[] = [
  "http://localhost:*",
  "http://127.0.0.1:*",
  "ws://localhost:*",
  "ws://127.0.0.1:*",
];

export function buildReportOnlyCsp(options: ReportOnlyCspOptions): string {
  const { isDev } = options;
  const extraConnectSrc = (options.extraConnectSrc ?? []).flatMap(originOf);

  // De-duplicated, first-seen order: the discovery list overlaps the RPC lists.
  const connectSrc = [
    ...new Set([
      "'self'",
      ...RPC_CONNECT_SRC,
      ...DISCOVERY_RPC_CONNECT_SRC,
      ...BROWSER_FETCH_CONNECT_SRC,
      ...ANALYTICS_CONNECT_SRC,
      ...WALLET_CONNECT_SRC,
      ...COINBASE_WALLET_CONNECT_SRC,
      ...extraConnectSrc,
      ...(isDev ? DEV_CONNECT_SRC : []),
    ]),
  ];

  const scriptSrc = [
    "'self'",
    "'unsafe-inline'",
    "https://www.googletagmanager.com",
    ...(isDev ? ["'unsafe-eval'"] : []),
  ];

  // `frame-ancestors` is intentionally absent: it is ignored in report-only mode
  // and already enforced by the separate `Content-Security-Policy` header.
  const directives: ReadonlyArray<readonly [string, string]> = [
    ["default-src", "'self'"],
    ["script-src", scriptSrc.join(" ")],
    ["style-src", "'self' 'unsafe-inline'"],
    ["img-src", "'self' data: blob: https:"],
    ["font-src", "'self' data:"],
    ["connect-src", connectSrc.join(" ")],
    ["frame-src", "'self' https://verify.walletconnect.com https://verify.walletconnect.org"],
    ["worker-src", "'self' blob:"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
  ];

  return directives.map(([name, value]) => `${name} ${value}`).join("; ");
}
