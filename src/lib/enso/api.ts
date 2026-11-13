import { fetchPricesInBatches } from "@/lib/enso-price-batches";
import { redactRpcUrl } from "@/lib/rpc-redact";
import { logRpcAttempt, markRpcTimedOut, orderRpcUrls } from "@/lib/rpc-health";
import type {
  EnsoBundleAction,
  EnsoBundleResponse,
  EnsoQuoteResponse,
  EnsoRouteResponse,
  EnsoToken,
} from "@/types/enso";
import { RPC_TIMEOUT_MS, getAllRpcUrls, isRpcTimeout, rpcAuthHeaderFor } from "@/config/rpc";
import { fetchEnsoIntent, shouldUsePlainTokenSwapIntent } from "@/lib/enso-intents";
import {
  assertProtectedEnsoBundleActions,
  assertSafeSlippageBps,
} from "@/lib/enso-swap-protection";
import {
  CHAIN_ID,
  DYNAMIC_ROUTE_UNAVAILABLE_MESSAGE,
  enqueueEnsoCall,
  ensoClient,
  errorMessage,
  isSwapNotFound,
  sleep,
} from "./client";
import { ENSO_REFERRAL_CODE } from "./constants";
import { applyTokenDisplayOverride, getTokenDisplayOverride } from "./tokens";

// Only aggregators verified inside Enso's native bundle `route` action with a
// dynamic useOutputOfCallAt amount belong here. Standalone route calldata is
// always quote-amount-specific and must never be replayed with routeMulti for a
// runtime-produced balance, even when its provider is listed here.
export const DYNAMIC_INPUT_SAFE_ENSO_AGGREGATORS = new Set(["grapher", "openocean"]);

interface DynamicInputAggregatorPolicy {
  availableSafeAggregators: string[];
  ignoreAggregators: string[];
}

// The aggregator list changes rarely but was fetched (through the serial Enso
// queue) for every dynamic-input bundle. Cache it per isolate.
const AGGREGATOR_CACHE_MS = 10 * 60 * 1000;
let aggregatorCache: { at: number; list: Promise<string[]> } | null = null;

/** Test hook: forget the cached aggregator list. */
export function resetEnsoAggregatorCache(): void {
  aggregatorCache = null;
}

function getCachedAggregators(): Promise<string[]> {
  const now = Date.now();
  if (aggregatorCache && now - aggregatorCache.at < AGGREGATOR_CACHE_MS) return aggregatorCache.list;
  const list = enqueueEnsoCall(() => ensoClient.getAggregators(CHAIN_ID));
  aggregatorCache = { at: now, list };
  // Never keep a failure or an empty list.
  list.then(
    (value) => { if (value.length === 0 && aggregatorCache?.list === list) aggregatorCache = null; },
    () => { if (aggregatorCache?.list === list) aggregatorCache = null; },
  );
  return list;
}

export async function getDynamicInputAggregatorPolicy(): Promise<DynamicInputAggregatorPolicy> {
  const aggregators = await getCachedAggregators();
  if (aggregators.length === 0) {
    throw new Error("Enso returned no aggregator policy for a dynamic-input route");
  }

  return {
    availableSafeAggregators: aggregators.filter((aggregator) =>
      DYNAMIC_INPUT_SAFE_ENSO_AGGREGATORS.has(aggregator.toLowerCase())
    ),
    ignoreAggregators: aggregators.filter(
      (aggregator) => !DYNAMIC_INPUT_SAFE_ENSO_AGGREGATORS.has(aggregator.toLowerCase())
    ),
  };
}
/**
 * Fetch token list from Enso API with metadata.
 * Client-side: proxied through /api/enso/tokens.
 * Server-side: calls SDK directly.
 */
export async function fetchEnsoTokenList(): Promise<EnsoToken[]> {
  if (typeof window !== "undefined") {
    const res = await fetch("/api/enso/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "base", includeMetadata: true }),
    });
    if (!res.ok) throw new Error(`Enso tokens proxy error: ${res.status}`);
    const tokenData = await res.json() as { data: Array<{ address: string; chainId: number; name?: string; symbol?: string; decimals: number; logosUri?: string[]; type?: EnsoToken["type"] }> };
    return tokenData.data
      .filter((t) => t.address && t.symbol)
      .map((t) => applyTokenDisplayOverride({
        address: t.address,
        chainId: t.chainId,
        name: t.name || t.symbol || "Unknown",
        symbol: t.symbol || "???",
        decimals: t.decimals,
        logoURI: t.logosUri?.[0],
        type: t.type ?? ("base" as const),
      }));
  }

  const tokenData = await enqueueEnsoCall(() => ensoClient.getTokenData({
    chainId: CHAIN_ID,
    type: "base",
    includeMetadata: true,
  }));

  return tokenData.data
    .filter((t) => t.address && t.symbol)
    .map((t) => applyTokenDisplayOverride({
      address: t.address,
      chainId: t.chainId,
      name: t.name || t.symbol || "Unknown",
      symbol: t.symbol || "???",
      decimals: t.decimals,
      logoURI: t.logosUri?.[0],
      type: t.type,
    }));
}

/**
 * Fetch wallet balances from Enso API
 * Returns token balances with prices for a given wallet address
 */
export interface EnsoWalletBalance {
  token: string;
  amount: string;
  chainId: number;
  decimals: number;
  price: number;
  name?: string;
  symbol?: string;
  logoUri?: string;
}

export async function fetchWalletBalances(walletAddress: string): Promise<EnsoWalletBalance[]> {
  if (typeof window !== "undefined") {
    const res = await fetch("/api/enso/balances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eoaAddress: walletAddress }),
    });
    if (!res.ok) throw new Error(`Enso balances proxy error: ${res.status}`);
    const balances = await res.json() as Array<{ token: string; amount: unknown; decimals: number; price: unknown; name?: string; symbol?: string; logoUri?: string }>;
    return balances.map((b) => {
      const override = getTokenDisplayOverride(b.token);
      return {
        token: b.token,
        amount: String(b.amount),
        chainId: CHAIN_ID,
        decimals: b.decimals,
        price: Number(b.price),
        name: override?.name ?? b.name,
        symbol: override?.symbol ?? b.symbol,
        logoUri: b.logoUri,
      };
    });
  }

  const balances = await enqueueEnsoCall(() => ensoClient.getBalances({
    chainId: CHAIN_ID,
    eoaAddress: walletAddress as `0x${string}`,
    useEoa: true,
  }));

  return balances.map((b) => {
    const override = getTokenDisplayOverride(b.token);
    return {
      token: b.token,
      amount: String(b.amount),
      chainId: CHAIN_ID,
      decimals: b.decimals,
      price: Number(b.price),
      // viem returns nullable strings for these fields; normalize null → undefined
      // to match the EnsoWalletBalance shape.
      name: override?.name ?? b.name ?? undefined,
      symbol: override?.symbol ?? b.symbol ?? undefined,
      logoUri: b.logoUri ?? undefined,
    };
  });
}

/**
 * Fetch batch token prices from Enso API
 */
export interface EnsoTokenPrice {
  chainId: number;
  address: string;
  price: number;
  decimals: number;
  symbol?: string;
  name?: string;
}

const tokenPricesInFlight = new Map<string, Promise<EnsoTokenPrice[]>>();

function tokenPricesRequestKey(addresses: readonly string[]): string {
  return [...new Set(addresses.map((address) => address.toLowerCase()))].sort().join(",");
}

export async function fetchTokenPrices(addresses: string[]): Promise<EnsoTokenPrice[]> {
  if (addresses.length === 0) return [];

  const key = tokenPricesRequestKey(addresses);
  const existing = tokenPricesInFlight.get(key);
  if (existing) return existing;

  const pending = fetchTokenPricesUncached(addresses).finally(() => {
    tokenPricesInFlight.delete(key);
  });
  tokenPricesInFlight.set(key, pending);
  return pending;
}

async function fetchTokenPricesUncached(addresses: string[]): Promise<EnsoTokenPrice[]> {
  if (typeof window !== "undefined") {
    const res = await fetch("/api/enso/prices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addresses }),
    });
    if (!res.ok) throw new Error(`Enso prices proxy error: ${res.status}`);
    const priceData = await res.json() as Array<{ chainId: number; address: string; price: unknown; decimals: number; symbol?: string }>;
    return priceData.map((p) => {
      const override = getTokenDisplayOverride(p.address);
      return {
        chainId: p.chainId,
        address: p.address,
        price: Number(p.price),
        decimals: p.decimals,
        symbol: override?.symbol ?? p.symbol,
        name: override?.name,
      };
    });
  }

  const priceData = await fetchPricesInBatches(addresses, (batch) => enqueueEnsoCall(() => ensoClient.getMultiplePriceData({
    chainId: CHAIN_ID,
    addresses: batch as `0x${string}`[],
  })));

  return priceData.map((p) => {
    const override = getTokenDisplayOverride(p.address);
    return {
      chainId: p.chainId,
      address: p.address,
      price: Number(p.price),
      decimals: p.decimals,
      symbol: override?.symbol ?? p.symbol,
      name: override?.name,
    };
  });
}

/**
 * Fetch token prices bypassing the rate-limited queue.
 * Use only in contexts where queue contention would cause timeouts (e.g., simulation API).
 */
export async function fetchTokenPricesDirect(addresses: string[]): Promise<EnsoTokenPrice[]> {
  if (addresses.length === 0) return [];
  const priceData = await fetchPricesInBatches(addresses, (batch) => ensoClient.getMultiplePriceData({
    chainId: CHAIN_ID,
    addresses: batch as `0x${string}`[],
  }));
  return priceData.map((p) => {
    const override = getTokenDisplayOverride(p.address);
    return {
      chainId: p.chainId,
      address: p.address,
      price: Number(p.price),
      decimals: p.decimals,
      symbol: override?.symbol ?? p.symbol,
      name: override?.name,
    };
  });
}

/**
 * Fetch optimal route/quote from Enso API.
 * Client-side: proxied through the `plainTokenSwap` intent (API key stays server-side).
 * Server-side: calls SDK directly.
 */
export interface EnsoRouteRequest {
  fromAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippage?: string; // basis points, e.g., "100" = 1%
  receiver?: string;
  ignoreAggregators?: string[];
}

export async function fetchRoute(params: EnsoRouteRequest): Promise<EnsoRouteResponse> {
  const slippage = params.slippage ?? "100";
  assertSafeSlippageBps(slippage);

  console.log("[Enso Route] Request:", {
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: params.amountIn,
    slippage,
  });

  // Client-side: proxy low-risk user-owned swaps through the named intent route.
  if (typeof window !== "undefined" && shouldUsePlainTokenSwapIntent(params)) {
    const result = await fetchEnsoIntent<EnsoRouteResponse>({
      intent: "plainTokenSwap",
      fromAddress: params.fromAddress,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn,
      slippage,
      receiver: params.receiver ?? params.fromAddress,
    });
    console.log("[Enso Route] Response (via intent):", {
      amountOut: result.amountOut,
      gas: result.gas,
      priceImpact: result.priceImpact,
    });
    return result;
  }

  // A route whose receiver is not the sender is only ever built server-side
  // (inside the intent proxy). The raw route endpoint is retired.
  if (typeof window !== "undefined") {
    throw new Error("Enso route with a custom receiver is only available server-side");
  }

  // Server-side: use SDK directly
  const routeData = await enqueueEnsoCall(() => ensoClient.getRouteData({
    chainId: CHAIN_ID,
    fromAddress: params.fromAddress as `0x${string}`,
    tokenIn: [params.tokenIn as `0x${string}`],
    tokenOut: [params.tokenOut as `0x${string}`],
    amountIn: [params.amountIn],
    slippage,
    routingStrategy: "router",
    referralCode: ENSO_REFERRAL_CODE,
    receiver: params.receiver as `0x${string}` | undefined,
    ignoreAggregators: params.ignoreAggregators,
  }));

  console.log("[Enso Route] Response:", {
    amountOut: String(routeData.amountOut),
    gas: String(routeData.gas),
    priceImpact: routeData.priceImpact,
    route: routeData.route.map((hop) => `${hop.action} via ${hop.protocol}`),
  });

  return {
    tx: {
      to: routeData.tx.to,
      data: routeData.tx.data,
      value: String(routeData.tx.value),
    },
    gas: String(routeData.gas),
    amountOut: String(routeData.amountOut),
    minAmountOut: routeData.minAmountOut == null
      ? undefined
      : String(Array.isArray(routeData.minAmountOut) ? routeData.minAmountOut[0] : routeData.minAmountOut),
    priceImpact: routeData.priceImpact != null ? Number(routeData.priceImpact) : null,
    route: routeData.route.map((hop) => ({
      action: hop.action,
      protocol: hop.protocol,
      tokenIn: hop.tokenIn as string[],
      tokenOut: hop.tokenOut as string[],
      amountIn: [],
      amountOut: [],
    })),
  };
}

export interface EnsoQuoteRequest {
  fromAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  ignoreAggregators?: string[];
}

/**
 * Output estimate from Enso's quoter (/shortcuts/quote). Use this wherever only the amount
 * (and route hops) are needed: it builds no calldata, costs about half a /route call in Enso
 * credits (~16 vs ~29-42 measured on 2026-10-13) and has its own rate limit. Falls back to
 * /route if the quoter fails, so an outage there degrades cost, not quotes.
 * Client-side: proxied through /api/enso/quote. Server-side: calls the SDK directly.
 */
export async function fetchQuote(params: EnsoQuoteRequest): Promise<EnsoQuoteResponse> {
  try {
    if (typeof window !== "undefined") {
      const res = await fetch("/api/enso/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromAddress: params.fromAddress,
          tokenIn: [params.tokenIn],
          tokenOut: [params.tokenOut],
          amountIn: [params.amountIn],
          ignoreAggregators: params.ignoreAggregators,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
        throw new Error(err.error || `Enso quote proxy error: ${res.status}`);
      }
      return await res.json() as EnsoQuoteResponse;
    }

    const quoteData = await enqueueEnsoCall(() => ensoClient.getQuoteData({
      chainId: CHAIN_ID,
      fromAddress: params.fromAddress as `0x${string}`,
      routingStrategy: "router",
      tokenIn: [params.tokenIn as `0x${string}`],
      tokenOut: [params.tokenOut as `0x${string}`],
      amountIn: [params.amountIn],
      ignoreAggregators: params.ignoreAggregators,
    }));
    if (quoteData?.amountOut == null) throw new Error("Enso quote returned no amountOut");
    return {
      amountOut: String(quoteData.amountOut),
      priceImpact: quoteData.priceImpact != null ? Number(quoteData.priceImpact) : null,
      route: (quoteData.route ?? []).map((hop) => ({
        action: hop.action,
        protocol: hop.protocol,
        tokenIn: hop.tokenIn as string[],
        tokenOut: hop.tokenOut as string[],
      })),
    };
  } catch (error) {
    console.warn("[Enso Quote] quoter failed, falling back to /route:", error instanceof Error ? error.message : error);
    const route = await fetchRoute(params);
    return { amountOut: route.amountOut, priceImpact: route.priceImpact, route: route.route };
  }
}

/**
 * Estimate the output of a runtime-produced balance. This standalone quote is
 * deliberately unrestricted because its amount-specific calldata is never
 * executed. The executable native bundle route receives the dynamic-safe
 * aggregator policy in fetchBundle.
 */
export async function fetchDynamicInputEstimate(
  params: Omit<EnsoRouteRequest, "ignoreAggregators">,
): Promise<EnsoQuoteResponse> {
  return fetchQuote({
    fromAddress: params.fromAddress,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: params.amountIn,
  });
}

/**
 * Estimate output from an Enso route (for min_dy calculations)
 * Uses the route API to get accurate output estimate
 * @param fromAddress - Wallet address
 * @param tokenIn - Input token address
 * @param tokenOut - Output token address
 * @param amountIn - Input amount (wei string)
 * @param slippage - Slippage in basis points (optional)
 * @returns Expected output amount as string
 * @throws Error if estimation fails (never returns fallback value)
 */
export async function estimateRouteOutput(
  fromAddress: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  // Kept for call-site compatibility: a quote's amountOut is the expected output, not
  // slippage-adjusted, so the quoter takes no slippage.
  _slippage?: string
): Promise<string> {
  // If tokens are same, return input
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    return amountIn;
  }

  const result = await fetchQuote({
    fromAddress,
    tokenIn,
    tokenOut,
    amountIn,
  });

  if (!result.amountOut) {
    throw new Error(`Failed to estimate route output for ${tokenIn} → ${tokenOut}`);
  }

  return result.amountOut;
}

const getRpcUrls = (): string[] => {
  if (typeof process !== "undefined" && process.env?.DEBUG_RPC_URL) {
    return [process.env.DEBUG_RPC_URL, ...getAllRpcUrls()];
  }
  return getAllRpcUrls();
};

/**
 * Whether a JSON-RPC reply is worth asking another provider for. A provider can
 * answer HTTP 200 with an `error` body (rate limited, "header not found",
 * internal error); that is not a success. An execution revert is the exception:
 * it is deterministic, so every provider would answer the same.
 */
function rpcReplyNeedsRetry(reply: unknown): boolean {
  if (Array.isArray(reply)) {
    // An empty batch, or any failed entry, means the batch did not really run.
    return reply.length === 0 || reply.some((entry) => rpcReplyNeedsRetry(entry));
  }
  if (reply === null || typeof reply !== "object") return true;
  const error = (reply as { error?: unknown }).error;
  if (error === null || error === undefined) return false;
  if (typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (code === 3) return false;
    if (typeof message === "string" && /execution reverted|revert/i.test(message)) return false;
  }
  return true;
}

/**
 * Make a JSON-RPC request with RPC URL fallback. Tries each available
 * RPC URL until one returns a successful response; a JSON-RPC error body also
 * moves on to the next URL. Works for both single calls and batch calls.
 * An error body is returned only when every URL failed that way.
 * Read methods only: a request is repeated against other providers.
 */
export async function rpcWithFallback<T = unknown>(body: unknown): Promise<T> {
  const rpcUrls = orderRpcUrls(getRpcUrls());
  let lastError: Error | undefined;
  let firstErrorReply: unknown;
  let errorReplies = 0;

  for (const rpcUrl of rpcUrls) {
    const startedAt = Date.now();
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          ...rpcAuthHeaderFor(rpcUrl),
        },
        body: JSON.stringify(body),
      });
      if (!response || !response.ok) {
        lastError = new Error(`RPC ${redactRpcUrl(rpcUrl)} returned ${response?.status}`);
        logRpcAttempt(rpcUrl, startedAt, "http_error", "rpcWithFallback");
        continue;
      }
      const reply = (await response.json()) as unknown;
      if (!rpcReplyNeedsRetry(reply)) {
        logRpcAttempt(rpcUrl, startedAt, "ok", "rpcWithFallback");
        return reply as T;
      }
      if (firstErrorReply === undefined) firstErrorReply = reply;
      lastError = new Error(`RPC ${redactRpcUrl(rpcUrl)} returned a JSON-RPC error`);
      logRpcAttempt(rpcUrl, startedAt, "rpc_error", "rpcWithFallback");
      // Cap the extra calls: a provider that answers an error body may do so for
      // every request, and the caller still gets the first error body to decide on.
      errorReplies += 1;
      if (errorReplies >= 3) break;
      continue;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      const failed = isRpcTimeout(e) ? "timeout" : "error";
      if (failed === "timeout") markRpcTimedOut(rpcUrl);
      logRpcAttempt(rpcUrl, startedAt, failed, "rpcWithFallback");
      continue;
    }
  }
  if (firstErrorReply !== undefined) return firstErrorReply as T;
  throw lastError ?? new Error("All RPC URLs failed");
}


/**
 * Bundle multiple DeFi actions into a single transaction.
 * Server-side only: public clients must use named /api/enso/intent recipes.
 *
 * @param routingStrategy - "router" for standard routing via Enso executor,
 *                          "delegate" for delegateCalls from user's context
 *                          (required for custom call actions without return values)
 */
export async function fetchBundle(params: {
  fromAddress: string;
  actions: EnsoBundleAction[];
  receiver?: string;
  routingStrategy?: "router" | "delegate";
  skipQuote?: boolean;
}): Promise<EnsoBundleResponse> {
  const isDev = process.env.NODE_ENV === "development";

  // Log actions being sent (dev only)
  if (isDev) {
    console.log("[Enso Bundle] Actions:", JSON.stringify(params.actions, null, 2));
  }

  if (typeof window !== "undefined") {
    throw new Error(
      "Raw Enso bundle actions cannot be submitted from the browser; use a server-owned Enso intent"
    );
  }

  assertProtectedEnsoBundleActions(params.actions);

  const dynamicRouteActions = params.actions.filter((action) =>
    action.protocol === "enso" &&
    action.action === "route" &&
    typeof action.args.amountIn === "object" &&
    action.args.amountIn !== null &&
    "useOutputOfCallAt" in action.args.amountIn &&
    !Array.isArray(action.args.ignoreAggregators)
  );
  let actions = params.actions;
  if (dynamicRouteActions.length > 0) {
    const { ignoreAggregators } = await getDynamicInputAggregatorPolicy();
    actions = params.actions.map((action) => {
      const hasDynamicInput =
        action.protocol === "enso" &&
        action.action === "route" &&
        typeof action.args.amountIn === "object" &&
        action.args.amountIn !== null &&
        "useOutputOfCallAt" in action.args.amountIn;
      if (!hasDynamicInput || Array.isArray(action.args.ignoreAggregators)) {
        return action;
      }
      return {
        ...action,
        args: {
          ...action.args,
          ignoreAggregators,
        },
      };
    });
  }

  // Server-side: use SDK directly
  const requestBundle = () => enqueueEnsoCall(() => ensoClient.getBundleData(
    {
      chainId: CHAIN_ID,
      fromAddress: params.fromAddress as `0x${string}`,
      routingStrategy: params.routingStrategy ?? "router",
      referralCode: ENSO_REFERRAL_CODE,
      receiver: params.receiver as `0x${string}` | undefined,
      skipQuote: params.skipQuote ?? isDev,
    },
    actions as unknown as Parameters<typeof ensoClient.getBundleData>[1]
  ));
  let bundleData: Awaited<ReturnType<typeof ensoClient.getBundleData>>;
  try {
    try {
      bundleData = await requestBundle();
    } catch (error: unknown) {
      // A dynamic-input route step may only use grapher/openocean, and Enso
      // intermittently can't route a pair with them ("Swap not found") while
      // the full aggregator set can: 10 Nov 2026, USDC -> cvxCRV failed for
      // ~1 min, then recovered. Retry once, then report it as temporary
      // rather than as missing liquidity.
      if (dynamicRouteActions.length === 0 || !isSwapNotFound(error)) throw error;
      await sleep(1500);
      try {
        bundleData = await requestBundle();
      } catch (retryError: unknown) {
        if (!isSwapNotFound(retryError)) throw retryError;
        throw new Error(
          `${DYNAMIC_ROUTE_UNAVAILABLE_MESSAGE} (${errorMessage(retryError)})`,
        );
      }
    }
  } catch (error: unknown) {
    if (isDev) {
      const errData = (error as { response?: { data?: unknown } })?.response?.data;
      console.error("[Enso Bundle] Error:", errData ?? error);
    }
    throw error;
  }

  if (isDev) {
    console.log("[Enso Bundle] Response:", {
      to: bundleData.tx.to,
      from: bundleData.tx.from,
      value: String(bundleData.tx.value),
      dataLength: bundleData.tx.data.length,
      gas: bundleData.gas,
      amountsOut: bundleData.amountsOut,
      amountsIn: (bundleData as Record<string, unknown>).amountsIn ?? "(not returned)",
      route: bundleData.route,
    });
  }

  return {
    tx: {
      to: bundleData.tx.to,
      data: bundleData.tx.data,
      value: String(bundleData.tx.value),
      from: bundleData.tx.from ?? params.fromAddress,
    },
    gas: String(bundleData.gas ?? "0"),
    amountsOut: bundleData.amountsOut
      ? Object.fromEntries(
          Object.entries(bundleData.amountsOut).map(([k, v]) => [k, String(v)])
        )
      : {},
    minAmountsOut: bundleData.minAmountsOut
      ? Object.fromEntries(
          Object.entries(bundleData.minAmountsOut).map(([k, v]) => [k, String(v)])
        )
      : undefined,
    route: bundleData.route,
    priceImpact: bundleData.priceImpact,
  };
}

/**
 * Legacy MORPHO is not transferable through normal swap routes. Wrap it 1:1
 * into the current MORPHO token, then execute a pre-built Enso route with
 * routeMulti so the wrapped tokens already held by ENSO_SHORTCUTS are consumed
 * atomically. This avoids requiring any new yld contracts.
 */
