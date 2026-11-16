import { isAddress } from "viem";

import type { EnsoToken } from "@/types/enso";

// Shape check only: an entry under a versioned prefix was written by this
// build from a token the user picked, so its metadata can be shown. A URL
// never writes here.
export function toStoredToken(parsed: unknown): EnsoToken | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.address !== "string" || !isAddress(candidate.address)) return undefined;
  if (
    typeof candidate.symbol !== "string" ||
    candidate.symbol.length === 0 ||
    candidate.symbol.length > 32
  ) {
    return undefined;
  }
  const decimals = candidate.decimals;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    return undefined;
  }
  if (candidate.chainId !== undefined && candidate.chainId !== 1) return undefined;
  return {
    address: candidate.address,
    chainId: 1,
    name: typeof candidate.name === "string" && candidate.name ? candidate.name : candidate.symbol,
    symbol: candidate.symbol,
    decimals,
    logoURI: typeof candidate.logoURI === "string" ? candidate.logoURI : undefined,
    type: candidate.type === "defi" ? "defi" : "base",
  };
}

/** Parses a JSON-encoded stored token, rejecting anything that is not the expected shape. */
export function parseStoredToken(raw: string | null | undefined): EnsoToken | undefined {
  if (!raw) return undefined;
  try {
    return toStoredToken(JSON.parse(raw));
  } catch {
    return undefined;
  }
}
