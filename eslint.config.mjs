import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import evmAddressChecksum from "./eslint-rules/evm-address-checksum.js";
import testImportsSource from "./eslint-rules/test-imports-source.js";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "cloudflare-runtime.d.ts",
    "cloudflare-env.d.ts",
    // Build output directories:
    ".open-next/**",
    ".wrangler/**",
    // Generated Worker types and Node replay scripts/fixtures (not app code):
    "workers/*.d.ts",
    "workers/testing/**",
    // Test output:
    "coverage/**",
    // Custom ESLint rules (CJS, not part of the app):
    "eslint-rules/**",
  ]),
  // Configure no-unused-vars to ignore underscore-prefixed variables
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  // Enforce EIP-55 checksummed or fully lowercase Ethereum addresses
  {
    plugins: {
      "evm-address": { rules: { checksum: evmAddressChecksum } },
    },
    rules: {
      "evm-address/checksum": "error",
    },
  },
  // Cloudflare Workers are not React/Next code. A default-exported
  // `{ scheduled, fetch }` handler object is the idiomatic Worker shape, and
  // the Next.js preset's no-anonymous-default-export rule does not apply.
  {
    files: ["workers/**/*.ts"],
    rules: {
      "import/no-anonymous-default-export": "off",
    },
  },
  // Unit tests must exercise real source code, not a copy of it.
  {
    files: ["src/**/*.{test,spec}.ts", "src/**/*.{test,spec}.tsx"],
    // Deprecated lending tests are exempt; they are deleted with the lending code.
    ignores: [
      "src/__tests__/hooks/useCurveLendingData.test.ts",
      "src/__tests__/components/LendingInterface.test.ts",
    ],
    plugins: { "yld-tests": { rules: { "imports-source": testImportsSource } } },
    rules: { "yld-tests/imports-source": "error" },
  },
]);

export default eslintConfig;
