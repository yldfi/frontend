import { NextRequest, NextResponse } from "next/server";
import { EnsoClient } from "@ensofinance/sdk";
import {
  assertEnsoIntentTxTarget,
  assertValidEnsoIntentRequest,
  getIntentVault,
} from "@/lib/enso-intents";

export const dynamic = "force-dynamic";

const CHAIN_ID = 1;
const REFERRAL_CODE = "yldfi";

// Server-side Enso client — API key is never exposed to the browser
const ensoClient = new EnsoClient({
  apiKey: process.env.ENSO_API_KEY || "",
});

// Simple origin check to prevent external abuse
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

import { createRateLimiter, getClientIp } from "@/lib/rate-limit";

const isRateLimited = createRateLimiter(120);

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: getCorsHeaders(request) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ method: string }> }
) {
  const { method } = await params;
  const cors = getCorsHeaders(request);

  const clientIp = getClientIp(request);
  if (isRateLimited(clientIp)) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: cors }
    );
  }

  if (!process.env.ENSO_API_KEY) {
    return NextResponse.json(
      { error: "Enso API key not configured" },
      { status: 500, headers: cors }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: cors }
    );
  }

  try {
    switch (method) {
      case "intent": {
        assertValidEnsoIntentRequest(body);

        const {
          fetchCvgCvxZapInRoute,
          fetchCvgCvxZapOutRoute,
          fetchPxCvxZapInRoute,
          fetchPxCvxZapOutRoute,
          fetchRoute,
          fetchZapInRoute,
          fetchZapOutRoute,
          fetchVaultToVaultRoute,
        } = await import("@/lib/enso");

        switch (body.intent) {
          case "plainTokenSwap": {
            const route = await fetchRoute({
              fromAddress: body.fromAddress,
              tokenIn: body.tokenIn,
              tokenOut: body.tokenOut,
              amountIn: body.amountIn,
              slippage: body.slippage,
              receiver: body.receiver ?? body.fromAddress,
            });
            assertEnsoIntentTxTarget(route);
            return NextResponse.json(route, { headers: cors });
          }

          case "yldVaultZapIn": {
            const vault = getIntentVault(body.vaultAddress);
            if (!vault) throw new Error("vaultAddress must be a known YLD vault");

            const bundle = await fetchZapInRoute({
              fromAddress: body.fromAddress,
              vaultAddress: body.vaultAddress,
              inputToken: body.inputToken,
              amountIn: body.amountIn,
              slippage: body.slippage,
              underlyingToken: vault.assetAddress,
            });
            assertEnsoIntentTxTarget(bundle);
            return NextResponse.json(bundle, { headers: cors });
          }

          case "yldVaultZapOut": {
            const vault = getIntentVault(body.vaultAddress);
            if (!vault) throw new Error("vaultAddress must be a known YLD vault");

            const bundle = await fetchZapOutRoute({
              fromAddress: body.fromAddress,
              vaultAddress: body.vaultAddress,
              outputToken: body.outputToken,
              amountIn: body.amountIn,
              slippage: body.slippage,
              underlyingToken: vault.assetAddress,
            });
            assertEnsoIntentTxTarget(bundle);
            return NextResponse.json(bundle, { headers: cors });
          }

          case "yldVaultToCvgCvxVault":
          case "cvgCvxVaultToYldVault":
          case "yldVaultToPxCvxVault":
          case "pxCvxVaultToYldVault": {
            const sourceVault = getIntentVault(body.sourceVault);
            const targetVault = getIntentVault(body.targetVault);
            if (!sourceVault || !targetVault) {
              throw new Error("sourceVault and targetVault must be known YLD vaults");
            }

            const bundle = await fetchVaultToVaultRoute({
              fromAddress: body.fromAddress,
              sourceVault: body.sourceVault,
              targetVault: body.targetVault,
              amountIn: body.amountIn,
              sourceUnderlyingToken: sourceVault.assetAddress,
              targetUnderlyingToken: targetVault.assetAddress,
              slippage: body.slippage,
            });
            assertEnsoIntentTxTarget(bundle);
            return NextResponse.json(bundle, { headers: cors });
          }

          case "cvgCvxZapIn": {
            const bundle = await fetchCvgCvxZapInRoute({
              fromAddress: body.fromAddress,
              vaultAddress: body.vaultAddress,
              inputToken: body.inputToken,
              amountIn: body.amountIn,
              slippage: body.slippage,
            });
            assertEnsoIntentTxTarget(bundle);
            return NextResponse.json(bundle, { headers: cors });
          }

          case "cvgCvxZapOut": {
            const bundle = await fetchCvgCvxZapOutRoute({
              fromAddress: body.fromAddress,
              vaultAddress: body.vaultAddress,
              outputToken: body.outputToken,
              amountIn: body.amountIn,
              slippage: body.slippage,
            });
            assertEnsoIntentTxTarget(bundle);
            return NextResponse.json(bundle, { headers: cors });
          }

          case "pxCvxZapIn": {
            const bundle = await fetchPxCvxZapInRoute({
              fromAddress: body.fromAddress,
              vaultAddress: body.vaultAddress,
              inputToken: body.inputToken,
              amountIn: body.amountIn,
              slippage: body.slippage,
            });
            assertEnsoIntentTxTarget(bundle);
            return NextResponse.json(bundle, { headers: cors });
          }

          case "pxCvxZapOut": {
            const bundle = await fetchPxCvxZapOutRoute({
              fromAddress: body.fromAddress,
              vaultAddress: body.vaultAddress,
              outputToken: body.outputToken,
              amountIn: body.amountIn,
              slippage: body.slippage,
            });
            assertEnsoIntentTxTarget(bundle);
            return NextResponse.json(bundle, { headers: cors });
          }

          case "yldVaultToVault": {
            const sourceVault = getIntentVault(body.sourceVault);
            const targetVault = getIntentVault(body.targetVault);
            if (!sourceVault || !targetVault) {
              throw new Error("sourceVault and targetVault must be known YLD vaults");
            }

            const bundle = await fetchVaultToVaultRoute({
              fromAddress: body.fromAddress,
              sourceVault: body.sourceVault,
              targetVault: body.targetVault,
              amountIn: body.amountIn,
              sourceUnderlyingToken: sourceVault.assetAddress,
              targetUnderlyingToken: targetVault.assetAddress,
              slippage: body.slippage,
            });
            assertEnsoIntentTxTarget(bundle);
            return NextResponse.json(bundle, { headers: cors });
          }
        }
      }

      case "route": {
        const routeData = await ensoClient.getRouteData({
          chainId: CHAIN_ID,
          fromAddress: body.fromAddress as `0x${string}`,
          tokenIn: body.tokenIn as [`0x${string}`],
          tokenOut: body.tokenOut as [`0x${string}`],
          amountIn: body.amountIn as [string],
          slippage: (body.slippage as string) ?? "100",
          routingStrategy: "router",
          referralCode: REFERRAL_CODE,
          receiver: body.receiver as `0x${string}` | undefined,
        });
        // Serialize BigInts to strings for JSON transport
        return NextResponse.json({
          tx: {
            to: routeData.tx.to,
            data: routeData.tx.data,
            value: String(routeData.tx.value),
          },
          gas: String(routeData.gas),
          amountOut: String(routeData.amountOut),
          priceImpact: routeData.priceImpact != null ? Number(routeData.priceImpact) : undefined,
          route: routeData.route.map((hop) => ({
            action: hop.action,
            protocol: hop.protocol,
            tokenIn: hop.tokenIn as string[],
            tokenOut: hop.tokenOut as string[],
            amountIn: [],
            amountOut: [],
          })),
        }, { headers: cors });
      }

      case "bundle": {
        const { actions, ...config } = body;
        const bundleData = await ensoClient.getBundleData(
          {
            chainId: CHAIN_ID,
            fromAddress: config.fromAddress as `0x${string}`,
            routingStrategy: (config.routingStrategy as "router" | "delegate") ?? "router",
            referralCode: REFERRAL_CODE,
            receiver: config.receiver as `0x${string}` | undefined,
            skipQuote: config.skipQuote as boolean | undefined,
          },
          actions as Parameters<typeof ensoClient.getBundleData>[1]
        );
        return NextResponse.json({
          tx: {
            to: bundleData.tx.to,
            data: bundleData.tx.data,
            value: String(bundleData.tx.value),
            from: bundleData.tx.from ?? config.fromAddress,
          },
          gas: String(bundleData.gas ?? "0"),
          amountsOut: bundleData.amountsOut
            ? Object.fromEntries(
                Object.entries(bundleData.amountsOut).map(([k, v]) => [k, String(v)])
              )
            : {},
          route: bundleData.route,
          priceImpact: bundleData.priceImpact,
        }, { headers: cors });
      }

      case "tokens": {
        const tokenData = await ensoClient.getTokenData({
          chainId: body.chainId as number ?? CHAIN_ID,
          type: body.type as "base" | "defi" | undefined,
          page: body.page as number | undefined,
          includeMetadata: body.includeMetadata as boolean | undefined,
        });
        return NextResponse.json(tokenData, { headers: cors });
      }

      case "prices": {
        const priceData = await ensoClient.getMultiplePriceData({
          chainId: CHAIN_ID,
          addresses: body.addresses as `0x${string}`[],
        });
        return NextResponse.json(priceData, { headers: cors });
      }

      case "balances": {
        const balances = await ensoClient.getBalances({
          chainId: CHAIN_ID,
          eoaAddress: body.eoaAddress as `0x${string}`,
          useEoa: true,
        });
        return NextResponse.json(balances, { headers: cors });
      }

      default:
        return NextResponse.json(
          { error: `Unknown method: ${method}` },
          { status: 404, headers: cors }
        );
    }
  } catch (error: unknown) {
    const err = error as { statusCode?: number; message?: string; response?: { data?: unknown } };
    const status = err.statusCode || 500;
    const message = err.message || "Enso API error";
    console.error(`[Enso Proxy] ${method} error:`, err.response?.data ?? message);
    return NextResponse.json({ error: message }, { status, headers: cors });
  }
}
