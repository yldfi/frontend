/**
 * Content-Security-Policy.
 *
 * The policy is enforced in production and sent report-only in development. In
 * report-only mode browsers evaluate it and log violations in the console
 * ("[Report Only] Refused to …") but block nothing.
 *
 * `script-src` keeps `'unsafe-inline'` on purpose: pages are prerendered static
 * assets, so a per-request nonce cannot be injected into them. The policy still
 * restricts script hosts, plugins, base URI, form targets and network
 * destinations.
 *
 * Only origins belong in the policy: an RPC URL can carry an API key in its
 * path, so every URL is reduced with `originOf`.
 *
 * A connected wallet's ENS avatar lookup (done inside the wallet library) fetches
 * the avatar's own host, which can be any host. That host is deliberately not
 * allowed: the app does not use the result (its avatar comes from the
 * same-origin `/api/avatar` route), and the library falls back to an image load,
 * which `img-src` permits.
 */
import {
  FLASHBOTS_RPC_URL,
  PRIVACY_SAFE_DOMAINS,
  RPC_URL_LIST,
} from "@/config/rpc";

export interface ContentSecurityPolicyOptions {
  isDev: boolean;
  extraConnectSrc?: readonly string[];
  frameAncestors?: string;
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
  "https://api.coingecko.com", // src/hooks/useTokenMetadata.ts:39.
  // HEAD probes, so `img-src` does not cover them: src/hooks/useTokenMetadata.ts:22,24.
  "https://raw.githubusercontent.com",
  "https://tokens.1inch.io",
];

/** Google Analytics collection. // seen in console walks */
const ANALYTICS_CONNECT_SRC: readonly string[] = [
  "https://www.googletagmanager.com", // src/components/GoogleAnalytics.tsx:90.
  "https://www.google-analytics.com",
  "https://*.google-analytics.com",
  "https://*.analytics.google.com",
];

/** WalletConnect / Reown. // seen in console walks */
const WALLET_CONNECT_SRC: readonly string[] = [
  "https://*.walletconnect.com",
  "https://*.walletconnect.org",
  "wss://*.walletconnect.com",
  "wss://*.walletconnect.org",
  "https://*.web3modal.org",
  "https://*.reown.com",
];

/** Coinbase Wallet SDK hosts. // the Base option was opened in console walks; the wallet popup itself was not exercised */
const COINBASE_WALLET_CONNECT_SRC: readonly string[] = [
  "https://*.coinbase.com",
  "https://www.walletlink.org",
  "wss://www.walletlink.org",
];

/** MetaMask SDK relay, used when MetaMask is chosen in a phone browser. // seen in a phone-emulation walk */
const METAMASK_SDK_CONNECT_SRC: readonly string[] = [
  "https://metamask-sdk.api.cx.metamask.io",
  "wss://metamask-sdk.api.cx.metamask.io",
];

/** Local dev servers and the Anvil fork. */
const DEV_CONNECT_SRC: readonly string[] = [
  "http://localhost:*",
  "http://127.0.0.1:*",
  "ws://localhost:*",
  "ws://127.0.0.1:*",
];

export function buildContentSecurityPolicy(options: ContentSecurityPolicyOptions): string {
  const { isDev, frameAncestors } = options;
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
      ...METAMASK_SDK_CONNECT_SRC,
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

  // `frame-ancestors` is added only for the enforced header (browsers ignore it
  // in report-only mode).
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
    ...(frameAncestors ? [["frame-ancestors", frameAncestors] as const] : []),
  ];

  return directives.map(([name, value]) => `${name} ${value}`).join("; ");
}
