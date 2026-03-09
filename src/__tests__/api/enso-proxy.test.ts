import { describe, it, expect } from "vitest";

// Re-implement logic from src/app/api/enso/[method]/route.ts

// Known API methods
const KNOWN_METHODS = new Set([
  "route",
  "bundle",
  "tokens",
  "prices",
  "balances",
]);

function isKnownMethod(method: string): boolean {
  return KNOWN_METHODS.has(method);
}

// BigInt serialization for route response
function serializeRouteResponse(routeData: {
  tx: { to: string; data: string; value: bigint };
  gas: bigint;
  amountOut: bigint;
  priceImpact?: number | null;
}) {
  return {
    tx: {
      to: routeData.tx.to,
      data: routeData.tx.data,
      value: String(routeData.tx.value),
    },
    gas: String(routeData.gas),
    amountOut: String(routeData.amountOut),
    priceImpact:
      routeData.priceImpact != null ? Number(routeData.priceImpact) : undefined,
  };
}

// BigInt serialization for bundle response
function serializeBundleAmountsOut(
  amountsOut: Record<string, bigint> | undefined
): Record<string, string> {
  if (!amountsOut) return {};
  return Object.fromEntries(
    Object.entries(amountsOut).map(([k, v]) => [k, String(v)])
  );
}

// CORS logic (re-implemented)
const ALLOWED_ORIGINS = ["https://yldfi.co", "https://www.yldfi.co"];

function getCorsOrigin(origin: string): string {
  const isAllowed = ALLOWED_ORIGINS.includes(origin);
  return isAllowed ? origin : ALLOWED_ORIGINS[0];
}

describe("Enso Proxy API", () => {
  describe("method validation", () => {
    it("accepts known methods", () => {
      expect(isKnownMethod("route")).toBe(true);
      expect(isKnownMethod("bundle")).toBe(true);
      expect(isKnownMethod("tokens")).toBe(true);
      expect(isKnownMethod("prices")).toBe(true);
      expect(isKnownMethod("balances")).toBe(true);
    });

    it("rejects unknown methods", () => {
      expect(isKnownMethod("unknown")).toBe(false);
      expect(isKnownMethod("swap")).toBe(false);
      expect(isKnownMethod("")).toBe(false);
      expect(isKnownMethod("ROUTE")).toBe(false); // case-sensitive
    });
  });

  describe("BigInt serialization - route", () => {
    it("serializes tx.value as string", () => {
      const result = serializeRouteResponse({
        tx: {
          to: "0xRouter",
          data: "0xCalldata",
          value: 1000000000000000000n,
        },
        gas: 200000n,
        amountOut: 5000000n,
      });
      expect(result.tx.value).toBe("1000000000000000000");
      expect(typeof result.tx.value).toBe("string");
    });

    it("serializes gas as string", () => {
      const result = serializeRouteResponse({
        tx: { to: "0x", data: "0x", value: 0n },
        gas: 300000n,
        amountOut: 0n,
      });
      expect(result.gas).toBe("300000");
      expect(typeof result.gas).toBe("string");
    });

    it("serializes amountOut as string", () => {
      const result = serializeRouteResponse({
        tx: { to: "0x", data: "0x", value: 0n },
        gas: 0n,
        amountOut: 123456789012345678901234n,
      });
      expect(result.amountOut).toBe("123456789012345678901234");
    });

    it("converts priceImpact to number", () => {
      const result = serializeRouteResponse({
        tx: { to: "0x", data: "0x", value: 0n },
        gas: 0n,
        amountOut: 0n,
        priceImpact: 0.5,
      });
      expect(result.priceImpact).toBe(0.5);
      expect(typeof result.priceImpact).toBe("number");
    });

    it("sets priceImpact to undefined when null", () => {
      const result = serializeRouteResponse({
        tx: { to: "0x", data: "0x", value: 0n },
        gas: 0n,
        amountOut: 0n,
        priceImpact: null,
      });
      expect(result.priceImpact).toBeUndefined();
    });

    it("preserves to and data fields", () => {
      const result = serializeRouteResponse({
        tx: {
          to: "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf",
          data: "0xabcdef",
          value: 0n,
        },
        gas: 0n,
        amountOut: 0n,
      });
      expect(result.tx.to).toBe(
        "0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf"
      );
      expect(result.tx.data).toBe("0xabcdef");
    });
  });

  describe("BigInt serialization - bundle amountsOut", () => {
    it("serializes BigInt values to strings", () => {
      const result = serializeBundleAmountsOut({
        "0xTokenA": 1000000000000000000n,
        "0xTokenB": 2000000n,
      });
      expect(result["0xTokenA"]).toBe("1000000000000000000");
      expect(result["0xTokenB"]).toBe("2000000");
    });

    it("returns empty object for undefined", () => {
      expect(serializeBundleAmountsOut(undefined)).toEqual({});
    });

    it("handles empty object", () => {
      expect(serializeBundleAmountsOut({})).toEqual({});
    });

    it("preserves keys exactly", () => {
      const result = serializeBundleAmountsOut({
        "0xAbCdEf": 42n,
      });
      expect(Object.keys(result)).toEqual(["0xAbCdEf"]);
    });
  });

  describe("CORS origin matching", () => {
    it("returns origin when allowed", () => {
      expect(getCorsOrigin("https://yldfi.co")).toBe("https://yldfi.co");
    });

    it("returns www origin when allowed", () => {
      expect(getCorsOrigin("https://www.yldfi.co")).toBe(
        "https://www.yldfi.co"
      );
    });

    it("falls back to first origin for unknown", () => {
      expect(getCorsOrigin("https://attacker.com")).toBe("https://yldfi.co");
    });
  });
});
