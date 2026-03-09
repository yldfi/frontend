import { describe, it, expect } from "vitest";

// Re-implement unexported lookup logic from RouteDisplay.tsx for testing
// (follows avatar.test.ts pattern)

// Token logo paths (exact copy from RouteDisplay.tsx)
const TOKEN_LOGOS: Record<string, string> = {
  eth: "/tokens/eth.png",
  weth: "/tokens/weth.png",
  cvx: "/tokens/cvx.png",
  cvxcrv: "/tokens/cvxcrv.png",
  crv: "/tokens/crv.png",
  cvgcvx: "/tokens/cvgcvx.png",
  pxcvx: "/tokens/pxcvx.png",
  lpxcvx: "/tokens/pxcvx.png",
  usdc: "/tokens/usdc.png",
  usdt: "/tokens/usdt.png",
  dai: "/tokens/dai.png",
  wbtc: "/tokens/wbtc.png",
  crvusd: "/tokens/crvusd.png",
  scrvusd: "/tokens/scrvusd.png",
  ucvx: "/tokens/llama-airforce.png",
  ucrv: "/tokens/llama-airforce.png",
  "yvusdc-1": "/tokens/yearn-v3.svg",
};

// Subset of PROTOCOL_LINKS for testing (exact copy from RouteDisplay.tsx)
const PROTOCOL_LINKS: Record<string, string> = {
  enso: "https://enso.build",
  odos: "https://odos.xyz",
  "1inch": "https://1inch.io",
  "0x": "https://0x.org",
  openocean: "https://openocean.finance",
  paraswap: "https://paraswap.io",
  cowswap: "https://cow.fi",
  "cow swap": "https://cow.fi",
  uniswap: "https://uniswap.org",
  sushiswap: "https://sushi.com",
  sushi: "https://sushi.com",
  balancer: "https://balancer.fi",
  curve: "https://www.curve.finance",
  "curve llamalend": "https://www.curve.finance/lend",
  "curve savings": "https://www.curve.finance/crvusd",
  aave: "https://aave.com",
  compound: "https://compound.finance",
  yearn: "https://yearn.fi",
  convex: "https://convexfinance.com",
  lido: "https://lido.fi",
  "rocket pool": "https://rocketpool.net",
  rocketpool: "https://rocketpool.net",
  etherfi: "https://ether.fi",
  "ether.fi": "https://ether.fi",
  pirex: "https://pirex.io",
  weth: "https://weth.io",
};

// Subset of PROTOCOL_DISPLAY_NAMES for testing
const PROTOCOL_DISPLAY_NAMES: Record<string, string> = {
  enso: "Enso",
  odos: "Odos",
  "1inch": "1inch",
  "0x": "0x",
  openocean: "OpenOcean",
  cowswap: "CoW Swap",
  "cow swap": "CoW Swap",
  uniswap: "Uniswap",
  uniswap_v2: "Uniswap V2",
  uniswap_v3: "Uniswap V3",
  sushiswap: "SushiSwap",
  curve: "Curve",
  "curve llamalend": "Curve LlamaLend",
  aave: "Aave",
  yearn: "Yearn",
  convex: "Convex",
  lido: "Lido",
  "rocket pool": "Rocket Pool",
  rocketpool: "Rocket Pool",
  etherfi: "Ether.fi",
  "ether.fi": "Ether.fi",
  pirex: "Pirex",
  dodo: "DODO",
  benqi: "BENQI",
  mstable: "mStable",
  gmx: "GMX",
  yld: "yld",
};

// Re-implemented from RouteDisplay.tsx
function getTokenLogo(symbol: string): string | undefined {
  const normalized = symbol.toLowerCase();
  if (TOKEN_LOGOS[normalized]) {
    return TOKEN_LOGOS[normalized];
  }
  // We skip the VAULTS lookup in tests since we're testing the pure logic
  return undefined;
}

function getProtocolDisplayName(protocol: string): string {
  const normalized = protocol.toLowerCase();
  if (PROTOCOL_DISPLAY_NAMES[normalized])
    return PROTOCOL_DISPLAY_NAMES[normalized];
  for (const [key, name] of Object.entries(PROTOCOL_DISPLAY_NAMES)) {
    if (normalized.includes(key)) {
      return name;
    }
  }
  return protocol.charAt(0).toUpperCase() + protocol.slice(1);
}

function getProtocolLink(protocol: string): string | undefined {
  const normalized = protocol.toLowerCase();
  if (PROTOCOL_LINKS[normalized]) return PROTOCOL_LINKS[normalized];
  for (const [key, url] of Object.entries(PROTOCOL_LINKS)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return url;
    }
  }
  return undefined;
}

describe("RouteDisplay", () => {
  describe("getTokenLogo", () => {
    it("returns logo for lowercase symbol", () => {
      expect(getTokenLogo("eth")).toBe("/tokens/eth.png");
    });

    it("returns logo for uppercase symbol", () => {
      expect(getTokenLogo("ETH")).toBe("/tokens/eth.png");
    });

    it("returns logo for mixed case symbol", () => {
      expect(getTokenLogo("Eth")).toBe("/tokens/eth.png");
    });

    it("returns undefined for unknown symbol", () => {
      expect(getTokenLogo("UNKNOWN_TOKEN")).toBeUndefined();
    });

    it("returns correct logo for each known token", () => {
      expect(getTokenLogo("weth")).toBe("/tokens/weth.png");
      expect(getTokenLogo("cvx")).toBe("/tokens/cvx.png");
      expect(getTokenLogo("cvxcrv")).toBe("/tokens/cvxcrv.png");
      expect(getTokenLogo("crv")).toBe("/tokens/crv.png");
      expect(getTokenLogo("cvgcvx")).toBe("/tokens/cvgcvx.png");
      expect(getTokenLogo("pxcvx")).toBe("/tokens/pxcvx.png");
      expect(getTokenLogo("usdc")).toBe("/tokens/usdc.png");
      expect(getTokenLogo("usdt")).toBe("/tokens/usdt.png");
      expect(getTokenLogo("dai")).toBe("/tokens/dai.png");
      expect(getTokenLogo("wbtc")).toBe("/tokens/wbtc.png");
      expect(getTokenLogo("crvusd")).toBe("/tokens/crvusd.png");
      expect(getTokenLogo("scrvusd")).toBe("/tokens/scrvusd.png");
    });

    it("maps lpxCVX to pxcvx logo", () => {
      expect(getTokenLogo("lpxcvx")).toBe("/tokens/pxcvx.png");
    });

    it("maps ucvx and ucrv to llama-airforce logo", () => {
      expect(getTokenLogo("ucvx")).toBe("/tokens/llama-airforce.png");
      expect(getTokenLogo("ucrv")).toBe("/tokens/llama-airforce.png");
    });

    it("handles yearn vault tokens with dashes", () => {
      expect(getTokenLogo("yvusdc-1")).toBe("/tokens/yearn-v3.svg");
    });

    it("returns undefined for empty string", () => {
      expect(getTokenLogo("")).toBeUndefined();
    });
  });

  describe("getProtocolDisplayName", () => {
    it("returns correct display name for direct match", () => {
      expect(getProtocolDisplayName("enso")).toBe("Enso");
      expect(getProtocolDisplayName("uniswap")).toBe("Uniswap");
      expect(getProtocolDisplayName("curve")).toBe("Curve");
      expect(getProtocolDisplayName("aave")).toBe("Aave");
    });

    it("is case-insensitive", () => {
      expect(getProtocolDisplayName("ENSO")).toBe("Enso");
      expect(getProtocolDisplayName("Uniswap")).toBe("Uniswap");
      expect(getProtocolDisplayName("CURVE")).toBe("Curve");
    });

    it("handles underscored variants via partial match", () => {
      expect(getProtocolDisplayName("uniswap_v2")).toBe("Uniswap V2");
      expect(getProtocolDisplayName("uniswap_v3")).toBe("Uniswap V3");
    });

    it("handles compound protocol names", () => {
      expect(getProtocolDisplayName("curve llamalend")).toBe(
        "Curve LlamaLend"
      );
      expect(getProtocolDisplayName("cow swap")).toBe("CoW Swap");
      expect(getProtocolDisplayName("rocket pool")).toBe("Rocket Pool");
    });

    it("preserves special casing", () => {
      expect(getProtocolDisplayName("dodo")).toBe("DODO");
      expect(getProtocolDisplayName("benqi")).toBe("BENQI");
      expect(getProtocolDisplayName("mstable")).toBe("mStable");
      expect(getProtocolDisplayName("gmx")).toBe("GMX");
    });

    it("capitalizes first letter for unknown protocols", () => {
      expect(getProtocolDisplayName("newprotocol")).toBe("Newprotocol");
      expect(getProtocolDisplayName("xyzDex")).toBe("XyzDex");
    });

    it("handles partial substring match (first key wins)", () => {
      // "uniswap_v3_pool" contains "uniswap" which appears before "uniswap_v3" in iteration order
      const result = getProtocolDisplayName("uniswap_v3_pool");
      // First matching key in object iteration order is "uniswap"
      expect(result).toBe("Uniswap");
    });

    it("handles yld protocol", () => {
      expect(getProtocolDisplayName("yld")).toBe("yld");
    });

    it("handles ether.fi variants", () => {
      expect(getProtocolDisplayName("etherfi")).toBe("Ether.fi");
      expect(getProtocolDisplayName("ether.fi")).toBe("Ether.fi");
    });
  });

  describe("getProtocolLink", () => {
    it("returns link for known protocol", () => {
      expect(getProtocolLink("enso")).toBe("https://enso.build");
      expect(getProtocolLink("uniswap")).toBe("https://uniswap.org");
      expect(getProtocolLink("curve")).toBe("https://www.curve.finance");
      expect(getProtocolLink("aave")).toBe("https://aave.com");
    });

    it("is case-insensitive", () => {
      expect(getProtocolLink("ENSO")).toBe("https://enso.build");
      expect(getProtocolLink("Uniswap")).toBe("https://uniswap.org");
      expect(getProtocolLink("CURVE")).toBe("https://www.curve.finance");
    });

    it("returns undefined for unknown protocol", () => {
      expect(getProtocolLink("totallyunknownprotocol")).toBeUndefined();
    });

    it("finds partial match (protocol name contains key)", () => {
      // "uniswap_v3" contains "uniswap"
      expect(getProtocolLink("uniswap_v3")).toBe("https://uniswap.org");
    });

    it("finds partial match (key contains protocol name)", () => {
      // "cow" is included in key "cow swap" and key "cowswap"
      expect(getProtocolLink("cow")).toBeDefined();
    });

    it("handles compound names", () => {
      expect(getProtocolLink("curve llamalend")).toBe("https://www.curve.finance/lend");
      expect(getProtocolLink("cow swap")).toBe("https://cow.fi");
    });

    it("handles ether.fi variants", () => {
      expect(getProtocolLink("etherfi")).toBe("https://ether.fi");
      expect(getProtocolLink("ether.fi")).toBe("https://ether.fi");
    });

    it("handles rocket pool variants", () => {
      expect(getProtocolLink("rocket pool")).toBe("https://rocketpool.net");
      expect(getProtocolLink("rocketpool")).toBe("https://rocketpool.net");
    });

    it("returns sushi link for sushiswap", () => {
      expect(getProtocolLink("sushiswap")).toBe("https://sushi.com");
      expect(getProtocolLink("sushi")).toBe("https://sushi.com");
    });
  });
});
