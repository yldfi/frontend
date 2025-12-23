import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
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
        // Global coverage thresholds - reasonable targets for a DeFi app
        lines: 30,
        functions: 30,
        branches: 20,
        statements: 30,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
