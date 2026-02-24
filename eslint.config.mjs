import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import evmAddressChecksum from "./eslint-rules/evm-address-checksum.js";

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
    // Build output directories:
    ".open-next/**",
    ".wrangler/**",
    "workers/**",
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
]);

export default eslintConfig;
