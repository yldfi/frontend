import type { Page } from "@playwright/test";
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters } from "viem";
import { protectEnsoIntentResponse } from "../../src/lib/enso-intents";

type IntentRequest = Parameters<typeof protectEnsoIntentResponse>[0];
type IntentResponse = Parameters<typeof protectEnsoIntentResponse>[1];

const ENSO_ROUTER_V2 = "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf";
const NATIVE_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ROUTER_ABI = parseAbi([
  "function routeSingle((uint8 tokenType, bytes data) tokenIn, bytes data) payable returns (bytes)",
]);

export type MockQuote = {
  amountOut: string;
  gas?: string;
  route?: unknown[];
  /** Zap intents come back from Enso's bundle API (amountsOut map); plain swaps use route (amountOut). */
  shape?: "bundle" | "route";
};

/** The tokens a zap intent pulls from and delivers to the wallet (the only intents E2E quotes so far). */
function zapTokens(request: Record<string, string>): { input: string; output: string } {
  if (/ZapIn$/.test(request.intent)) return { input: request.inputToken, output: request.vaultAddress };
  if (/ZapOut$/.test(request.intent)) return { input: request.vaultAddress, output: request.outputToken };
  throw new Error(`intent mock: ${request.intent} is not handled; add it to zapTokens`);
}

/**
 * Build the raw Enso route the server would get back for `request`, then pass it through the
 * app's own protectEnsoIntentResponse, so the browser's re-validation accepts the mock.
 */
export function buildIntentResponse(
  request: IntentRequest,
  quote: MockQuote,
): IntentResponse {
  const fields = request as unknown as Record<string, string>;
  const { input: inputToken, output: outputToken } = zapTokens(fields);
  const native = inputToken.toLowerCase() === NATIVE_TOKEN;
  const amountIn = BigInt(fields.amountIn);
  const tokenIn = native
    ? { tokenType: 0, data: encodeAbiParameters(parseAbiParameters("uint256 amount"), [amountIn]) }
    : {
        tokenType: 1,
        data: encodeAbiParameters(parseAbiParameters("address token, uint256 amount"), [
          inputToken as `0x${string}`,
          amountIn,
        ]),
      };
  const raw = {
    tx: {
      to: ENSO_ROUTER_V2,
      data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "routeSingle", args: [tokenIn, "0x1234"] }),
      value: native ? amountIn.toString() : "0",
      from: fields.fromAddress,
    },
    gas: quote.gas ?? "500000",
    ...(quote.shape === "route"
      ? { amountOut: quote.amountOut }
      : { amountsOut: { [outputToken.toLowerCase()]: quote.amountOut } }),
    route: quote.route ?? [],
  } as unknown as IntentResponse;
  return protectEnsoIntentResponse(request, raw);
}

/** Answer /api/enso/intent with a valid protected quote; returns a live count of requests. */
export async function mockZapIntent(
  page: Page,
  quote: MockQuote,
): Promise<{ readonly count: number }> {
  const calls = { count: 0 };
  await page.route("**/api/enso/intent", (route) => {
    calls.count++;
    const request = route.request().postDataJSON() as IntentRequest;
    return route.fulfill({ json: buildIntentResponse(request, quote) });
  });
  return calls;
}
