import { NextRequest, NextResponse } from "next/server";
import { EnsoClient } from "@ensofinance/sdk";
import {
  assertEnsoIntentTxTarget,
  assertValidEnsoIntentRequest,
  getIntentVault,
} from "@/lib/enso-intents";
import { assertSlippage } from "@/lib/enso-intent-validation";
import { getExternalVaultConfig, LLAMA_AIRFORCE, TOKENS } from "@/config/vaults";

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

function getFriendlyEnsoError(message: string, body?: Record<string, unknown>): string {
  const lower = message.toLowerCase();
  if (lower.includes("could not quote shortcuts") || lower.includes("could not quote")) {
    if (body?.closeLoan === true) {
      return "No swap route could produce enough crvUSD for this close. Increase the amount, increase slippage, or use crvUSD.";
    }
    return "No swap route could be quoted for this transaction. Increase the amount, increase slippage, or use a different token.";
  }
  return message;
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
          fetchAnyFromBeefyRoute,
          fetchAnyFromCvgCvxRoute,
          fetchAnyFromErc4626ExternalVaultRoute,
          fetchAnyFromLpxCvxRoute,
          fetchAnyFromPxCvxRoute,
          fetchAnyFromUCvxRoute,
          fetchAnyFromUCrvRoute,
          fetchAnyToExternalVaultRoute,
          fetchAnyToCvgCvxRoute,
          fetchAnyToLpxCvxRoute,
          fetchAnyToPxCvxRoute,
          fetchExternalVaultZapInRoute,
          fetchLegacyMorphoWrapRoute,
          fetchLegacyMorphoZapInRoute,
          fetchPxCvxZapInRoute,
          fetchPxCvxZapOutRoute,
          fetchRoute,
          fetchSpecialTokenToExternalVaultRoute,
          fetchSpecialTokenToIlliquidRoute,
          fetchYldVaultToExternalVaultRoute,
          fetchYldVaultToIlliquidRoute,
          fetchZapInRoute,
          fetchZapOutRoute,
          fetchVaultToVaultRoute,
        } = await import("@/lib/enso");
        const {
          fetchRepayBundle,
          fetchRepayWithSwapBundle,
        } = await import("@/lib/curve-lending");

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
            assertEnsoIntentTxTarget(body.intent, route);
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
            assertEnsoIntentTxTarget(body.intent, bundle);
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
            assertEnsoIntentTxTarget(body.intent, bundle);
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
            assertEnsoIntentTxTarget(body.intent, bundle);
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
            assertEnsoIntentTxTarget(body.intent, bundle);
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
            assertEnsoIntentTxTarget(body.intent, bundle);
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
            assertEnsoIntentTxTarget(body.intent, bundle);
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
            assertEnsoIntentTxTarget(body.intent, bundle);
            return NextResponse.json(bundle, { headers: cors });
          }

          case "externalVaultZapInToYld": {
            const bundle = await fetchExternalVaultZapInRoute({
              fromAddress: body.fromAddress,
              vaultAddress: body.vaultAddress,
              externalVaultAddress: body.externalVaultAddress,
              amountIn: body.amountIn,
              slippage: body.slippage,
            });
            assertEnsoIntentTxTarget(body.intent, bundle);
            return NextResponse.json(bundle, { headers: cors });
          }

          case "anyToExternalVault": {
            const bundle = await fetchAnyToExternalVaultRoute({
              fromAddress: body.fromAddress,
              inputToken: body.inputToken,
              externalVaultAddress: body.externalVaultAddress,
              amountIn: body.amountIn,
              slippage: body.slippage,
            });
            assertEnsoIntentTxTarget(body.intent, bundle);
            return NextResponse.json(bundle, { headers: cors });
          }

          case "yldVaultToExternalVault": {
            const sourceVault = getIntentVault(body.sourceVault);
            const targetVault = getExternalVaultConfig(body.targetVault);
            if (!sourceVault || !targetVault) {
              throw new Error("sourceVault and targetVault must be known vaults");
            }

            const bundle = await fetchYldVaultToExternalVaultRoute({
              fromAddress: body.fromAddress,
              sourceVault: body.sourceVault,
              sourceUnderlying: sourceVault.assetAddress,
              targetVault: targetVault.address,
              targetUnderlying: targetVault.underlying,
              targetInterface: targetVault.interface,
              targetSymbol: targetVault.symbol,
              targetProtocol: targetVault.protocol,
              amountIn: body.amountIn,
              slippage: body.slippage,
            });
            assertEnsoIntentTxTarget(body.intent, bundle);
            return NextResponse.json(bundle, { headers: cors });
          }

          case "yldVaultToIlliquid": {
            const sourceVault = getIntentVault(body.sourceVault);
            if (!sourceVault) throw new Error("sourceVault must be a known YLD vault");

            const bundle = await fetchYldVaultToIlliquidRoute({
              fromAddress: body.fromAddress,
              sourceVault: body.sourceVault,
              sourceUnderlying: sourceVault.assetAddress,
              outputToken: body.outputToken,
              amountIn: body.amountIn,
              slippage: body.slippage,
            });
            assertEnsoIntentTxTarget(body.intent, bundle);
            return NextResponse.json(bundle, { headers: cors });
          }

          case "specialTokenToExternalVault": {
            const bundle = await fetchSpecialTokenToExternalVaultRoute({
              fromAddress: body.fromAddress,
              inputToken: body.inputToken,
              outputVault: body.outputVault,
              amountIn: body.amountIn,
              slippage: body.slippage,
            });
            assertEnsoIntentTxTarget(body.intent, bundle);
            return NextResponse.json(bundle, { headers: cors });
          }

          case "specialTokenToIlliquid": {
            const bundle = await fetchSpecialTokenToIlliquidRoute({
              fromAddress: body.fromAddress,
              inputToken: body.inputToken,
              outputToken: body.outputToken,
              amountIn: body.amountIn,
              slippage: body.slippage,
            });
            assertEnsoIntentTxTarget(body.intent, bundle);
            return NextResponse.json(bundle, { headers: cors });
          }

          case "externalVaultToAny": {
            const config = getExternalVaultConfig(body.externalVaultAddress);
            if (!config) throw new Error("externalVaultAddress must be a known external vault");

            const bundle =
              config.address.toLowerCase() === LLAMA_AIRFORCE.UCVX.toLowerCase()
                ? await fetchAnyFromUCvxRoute({
                    fromAddress: body.fromAddress,
                    outputToken: body.outputToken,
                    amountIn: body.amountIn,
                    slippage: body.slippage,
                  })
                : config.interface === "ucrv"
                  ? await fetchAnyFromUCrvRoute({
                      fromAddress: body.fromAddress,
                      outputToken: body.outputToken,
                      amountIn: body.amountIn,
                      slippage: body.slippage,
                    })
                  : config.interface === "beefy"
                    ? await fetchAnyFromBeefyRoute({
                        fromAddress: body.fromAddress,
                        beefyVault: config.address,
                        beefyVaultUnderlying: config.underlying,
                        beefyVaultSymbol: config.symbol,
                        outputToken: body.outputToken,
                        amountIn: body.amountIn,
                        slippage: body.slippage,
                      })
                    : await fetchAnyFromErc4626ExternalVaultRoute({
                        fromAddress: body.fromAddress,
                        externalVault: config.address,
                        externalVaultUnderlying: config.underlying,
                        outputToken: body.outputToken,
                        amountIn: body.amountIn,
                        slippage: body.slippage,
                        protocolLabel: config.protocol,
                      });
            assertEnsoIntentTxTarget(body.intent, bundle);
            return NextResponse.json(bundle, { headers: cors });
          }

          case "illiquidToAny": {
            const input = body.inputToken.toLowerCase();
            const bundle =
              input === TOKENS.PXCVX.toLowerCase()
                ? await fetchAnyFromPxCvxRoute({
                    fromAddress: body.fromAddress,
                    outputToken: body.outputToken,
                    amountIn: body.amountIn,
                    slippage: body.slippage,
                  })
                : input === TOKENS.CVGCVX.toLowerCase()
                  ? await fetchAnyFromCvgCvxRoute({
                      fromAddress: body.fromAddress,
                      outputToken: body.outputToken,
                      amountIn: body.amountIn,
                      slippage: body.slippage,
                    })
                  : await fetchAnyFromLpxCvxRoute({
                      fromAddress: body.fromAddress,
                      outputToken: body.outputToken,
                      amountIn: body.amountIn,
                      slippage: body.slippage,
                    });
            assertEnsoIntentTxTarget(body.intent, bundle);
            return NextResponse.json(bundle, { headers: cors });
          }

          case "anyToIlliquid": {
            const output = body.outputToken.toLowerCase();
            const bundle =
              output === TOKENS.PXCVX.toLowerCase()
                ? await fetchAnyToPxCvxRoute({
                    fromAddress: body.fromAddress,
                    inputToken: body.inputToken,
                    amountIn: body.amountIn,
                    slippage: body.slippage,
                  })
                : output === TOKENS.CVGCVX.toLowerCase()
                  ? await fetchAnyToCvgCvxRoute({
                      fromAddress: body.fromAddress,
                      inputToken: body.inputToken,
                      amountIn: body.amountIn,
                      slippage: body.slippage,
                    })
                  : await fetchAnyToLpxCvxRoute({
                      fromAddress: body.fromAddress,
                      inputToken: body.inputToken,
                      amountIn: body.amountIn,
                      slippage: body.slippage,
                    });
            assertEnsoIntentTxTarget(body.intent, bundle);
            return NextResponse.json(bundle, { headers: cors });
          }

          case "legacyMorphoWrap": {
            const bundle = await fetchLegacyMorphoWrapRoute({
              fromAddress: body.fromAddress,
              outputToken: body.outputToken,
              amountIn: body.amountIn,
              slippage: body.slippage,
            });
            assertEnsoIntentTxTarget(body.intent, bundle);
            return NextResponse.json(bundle, { headers: cors });
          }

          case "legacyMorphoZapIn": {
            const vault = getIntentVault(body.vaultAddress);
            if (!vault) throw new Error("vaultAddress must be a known YLD vault");

            const bundle = await fetchLegacyMorphoZapInRoute({
              fromAddress: body.fromAddress,
              vaultAddress: body.vaultAddress,
              amountIn: body.amountIn,
              slippage: body.slippage,
              underlyingToken: vault.assetAddress,
            });
            assertEnsoIntentTxTarget(body.intent, bundle);
            return NextResponse.json(bundle, { headers: cors });
          }

          case "curveLendingRepay": {
            const bundle = await fetchRepayBundle({
              fromAddress: body.fromAddress,
              vaultAddress: body.vaultAddress as `0x${string}`,
              repayAmount: body.amountIn,
            });
            assertEnsoIntentTxTarget(body.intent, bundle);
            return NextResponse.json(bundle, { headers: cors });
          }

          case "curveLendingRepayWithSwap": {
            const bundle = await fetchRepayWithSwapBundle({
              fromAddress: body.fromAddress,
              vaultAddress: body.vaultAddress as `0x${string}`,
              tokenIn: body.tokenIn,
              amountIn: body.amountIn,
              slippage: Number(body.slippage),
              inSoftLiquidation: body.inSoftLiquidation,
              closeLoan: body.closeLoan,
              maxRepayAmount: body.maxRepayAmount,
            });
            assertEnsoIntentTxTarget(body.intent, bundle);
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
            assertEnsoIntentTxTarget(body.intent, bundle);
            return NextResponse.json(bundle, { headers: cors });
          }

          default:
            throw new Error(`Unhandled Enso intent: ${(body as { intent: string }).intent}`);
        }
      }

      case "route": {
        const slippage = (body.slippage as string | undefined) ?? "100";
        assertSlippage(slippage);
        const routeData = await ensoClient.getRouteData({
          chainId: CHAIN_ID,
          fromAddress: body.fromAddress as `0x${string}`,
          tokenIn: body.tokenIn as [`0x${string}`],
          tokenOut: body.tokenOut as [`0x${string}`],
          amountIn: body.amountIn as [string],
          slippage,
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
        return NextResponse.json(
          { error: "Raw Enso bundle actions are disabled; use /api/enso/intent" },
          { status: 410, headers: cors }
        );
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
    const message = getFriendlyEnsoError(err.message || "Enso API error", body);
    console.error(`[Enso Proxy] ${method} error:`, err.response?.data ?? message);
    return NextResponse.json({ error: message }, { status, headers: cors });
  }
}
