/**
 * ESLint rule: evm-address-checksum
 *
 * Enforces that Ethereum addresses (0x + 40 hex chars) are either:
 *   - Fully lowercase (for lookup maps / normalized keys)
 *   - Properly EIP-55 checksummed
 *
 * Mixed-case addresses that don't match the EIP-55 checksum are flagged
 * and auto-fixed to the correct checksummed form.
 */

const { getAddress } = require("viem");

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Enforce EIP-55 checksummed or fully lowercase Ethereum addresses",
    },
    fixable: "code",
    schema: [],
    messages: {
      badChecksum:
        'Ethereum address "{{address}}" has invalid mixed-case checksum. Use checksummed "{{checksummed}}" or fully lowercase "{{lowercase}}".',
    },
  },

  create(context) {
    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        if (!ETH_ADDRESS_RE.test(node.value)) return;

        const address = node.value;
        const lowercase = address.toLowerCase();

        // Fully lowercase is OK (used in lookup maps)
        if (address === lowercase) return;

        // Proper EIP-55 checksum is OK
        let checksummed;
        try {
          checksummed = getAddress(lowercase);
        } catch {
          return; // Not a valid address
        }

        if (address === checksummed) return;

        // Mixed-case but doesn't match checksum — report
        context.report({
          node,
          messageId: "badChecksum",
          data: { address, checksummed, lowercase },
          fix(fixer) {
            return fixer.replaceText(node, `"${checksummed}"`);
          },
        });
      },
    };
  },
};
