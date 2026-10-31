// Helpers for decoding Enso route API calldata.

import { decodeFunctionData } from "viem";

// ABI for decoding routeSingle from Enso route API responses.
// routeSingle(Token tokenIn, bytes data) where Token = (uint8 tokenType, bytes data)
const ROUTE_SINGLE_ABI = [{
  name: "routeSingle",
  type: "function",
  inputs: [
    { name: "tokenIn", type: "tuple", components: [
      { name: "tokenType", type: "uint8" },
      { name: "data", type: "bytes" },
    ]},
    { name: "data", type: "bytes" },
  ],
  outputs: [{ name: "", type: "bytes" }],
}] as const;

/**
 * Extract inner swap data from an Enso route response.
 *
 * The Enso route API returns routeSingle(Token tokenIn, bytes innerData) calldata.
 * routeSingle pulls tokenIn from the user BEFORE executing innerData.
 * We extract innerData to use with routeMulti([], innerData) which skips the pull.
 */
export function extractInnerSwapData(routeTxData: string): `0x${string}` {
  const decoded = decodeFunctionData({
    abi: ROUTE_SINGLE_ABI,
    data: routeTxData as `0x${string}`,
  });
  if (!decoded.args) {
    throw new Error("Failed to decode routeSingle calldata — no args returned");
  }
  return decoded.args[1] as `0x${string}`;
}
