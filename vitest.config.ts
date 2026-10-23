import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import * as dotenv from "dotenv";

// Load env from .env.local for tests
dotenv.config({ path: ".env.local" });

const UNIT_INCLUDE = "src/**/*.{test,spec}.{ts,tsx}";
const INTEGRATION_DIR = "src/__tests__/integration";
const INTEGRATION_INCLUDE = `${INTEGRATION_DIR}/**/*.{test,spec}.{ts,tsx}`;

// Integration tests that need a DOM: React hooks rendered with
// @testing-library/react, and modules that read `window` directly (gtag).
// Everything else runs in node so libraries take their server-side path
// instead of the browser `/api/*` proxies (and so `typeof window` checks in
// src/lib/enso.ts pick the SDK branch the tests mock).
const INTEGRATION_DOM_MODULES = [
  "useZapActions",
  "useZapQuote",
  "usePricePerShare",
  "useVaultBalance",
  "useVaultCache",
  "useVaultData",
  "useYearnVault",
  "analytics",
  "direct-vault-deposit",
];
const INTEGRATION_DOM_INCLUDE = INTEGRATION_DOM_MODULES.map(
  (name) => `${INTEGRATION_DIR}/${name}.*.{test,spec}.{ts,tsx}`
);

export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.ENSO_API_KEY": JSON.stringify(process.env.ENSO_API_KEY),
  },
  test: {
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    projects: [
      {
        test: {
          name: "unit",
          environment: "jsdom",
          include: [UNIT_INCLUDE],
          exclude: [...configDefaults.exclude, `${INTEGRATION_DIR}/**`],
        },
      },
      {
        // Server-side libraries, SDK calls and on-chain/RPC probes.
        test: {
          name: "integration",
          environment: "node",
          include: [INTEGRATION_INCLUDE],
          exclude: [...configDefaults.exclude, ...INTEGRATION_DOM_INCLUDE],
        },
      },
      {
        // Hooks and browser-only modules still need jsdom.
        test: {
          name: "integration-dom",
          environment: "jsdom",
          include: INTEGRATION_DOM_INCLUDE,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      exclude: [
        "node_modules/",
        "vitest.setup.ts",
        "src/__tests__/**",
        "**/*.d.ts",
        "**/*.config.*",
        "src/app/**", // Next.js pages/layouts use RSC patterns
        "src/components/ui/**", // UI primitives from shadcn
        "src/config/**", // Config files with static data
        "src/components/Providers.tsx", // Provider wrapper
        "src/components/PixelAnimation.tsx", // Canvas animation
        "src/components/Logo.tsx", // SVG component
        "src/components/CustomConnectButton.tsx", // Wallet connect wrapper
        "src/components/AnalyticsProvider.tsx", // Analytics wrapper
        "src/lib/explorer/**", // Contract explorer utilities
        "src/components/ContractExplorer.tsx", // Contract explorer modal
        "src/components/ContractView.tsx", // Contract view component
        "src/types/explorer.ts", // Explorer type definitions
      ],
      include: ["src/**/*.{ts,tsx}"],
      thresholds: {
        // Ratchet floor, enforced in CI: ~1 point below unit-test coverage
        // in Oct 2026 (lines 26.1, functions 25.9, branches 21.6, statements 25.3).
        // Raise these as coverage improves; don't lower them.
        lines: 25,
        functions: 24,
        branches: 20,
        statements: 24,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "../.open-next/worker.js": path.resolve(__dirname, "./src/__tests__/workers/opennext-edge-worker-stub.ts"),
      "../../../.open-next/worker.js": path.resolve(__dirname, "./src/__tests__/workers/opennext-edge-worker-stub.ts"),
    },
  },
});
