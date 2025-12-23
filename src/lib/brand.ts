/**
 * Brand constants - centralized branding configuration
 *
 * Note: Next.js metadata (in layout.tsx, page.tsx) requires static values,
 * so those must be updated manually. This file centralizes the brand name
 * for runtime components.
 */

export const BRAND = {
  /** Brand name for display (matches stylized version with underscore) */
  name: "yld_fi",

  /** Full tagline */
  tagline: "Automated Yield Optimization",

  /** Copyright text */
  copyright: (year: number = new Date().getFullYear()) =>
    `© ${year} yld_fi. All rights reserved.`,

  /** User-Agent for API requests */
  userAgent: "yld_fi ENS Avatar Proxy",

  /** App name for wallet connections */
  walletAppName: "yld_fi",
} as const;

export const URLS = {
  /** Main website domain */
  domain: "yldfi.co",

  /** Full website URL */
  website: "https://yldfi.co",

  /** Documentation */
  docs: "https://yldfi.gitbook.io/docs",

  /** GitHub organization */
  github: "https://github.com/yldfi",

  /** Telegram community */
  telegram: "https://t.me/yld_fi",

  /** Contact email */
  email: "contact@yldfi.co",
} as const;

export const CONTRACTS = {
  /** yCVXCRV vault - auto-compounding cvxCRV with LlamaLend collateral */
  YCVXCRV: "0x95f19B19aff698169a1A0BBC28a2e47B14CB9a86" as const,

  /** yscvxCRV strategy - auto-compounding cvxCRV (lower fee, no collateral) */
  YSCVXCRV: "0xCa960E6DF1150100586c51382f619efCCcF72706" as const,
} as const;
