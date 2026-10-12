import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";

import { BEEFY, LLAMA_AIRFORCE, PIREX, TANGENT, TOKENS } from "@/config/vaults";
import fixture from "@/__tests__/fixtures/contract-selectors.json";

const CURVE_ROUTER = "0x99a58482BD75cbab83b27EC03CA68fF489b5788f";
const selectorsOf = (address: string) => new Set<string>((fixture.contracts as Record<string, string[]>)[address.toLowerCase()] ?? []);

// Static call targets in enso.ts, resolved to their mainnet addresses.
const STATIC_TARGETS: Record<string, string> = {
  CURVE_ROUTER,
  "LLAMA_AIRFORCE.UCRV": LLAMA_AIRFORCE.UCRV,
  "PIREX.LPXCVX": PIREX.LPXCVX,
  "pirex.LPXCVX": PIREX.LPXCVX,
  "PIREX.LPXCVX_CVX_POOL": PIREX.LPXCVX_CVX_POOL,
  "PIREX.PIREX_CVX": PIREX.PIREX_CVX,
  "TANGENT.CVGCVX_CONTRACT": TANGENT.CVGCVX_CONTRACT,
  "TANGENT.CVX1_CVGCVX_POOL": TANGENT.CVX1_CVGCVX_POOL,
  "TOKENS.CVX1": TOKENS.CVX1,
};
// Calls whose target is chosen at runtime must match a function on every vault of the family they
// can point to (uCRV-style or Beefy-style external vaults).
const DYNAMIC_FAMILIES: Record<string, string[]> = {
  ucrv: [LLAMA_AIRFORCE.UCRV],
  beefy: [BEEFY.MOO_CVX_CRV, BEEFY.MOO_CVX_CVX],
};

function rawCalls(): Array<{ target: string; signature: string; line: number }> {
  const source = readFileSync(join(process.cwd(), "src/lib/enso.ts"), "utf-8");
  const calls: Array<{ target: string; signature: string; line: number }> = [];
  const pattern = /action: "call",\s*args: \{\s*address: ([^,\n]+),\s*method: "\w+",\s*(?:\/\/[^\n]*\n\s*)*abi: "function ([^"]+?)\)/g;
  for (const match of source.matchAll(pattern)) {
    calls.push({ target: match[1].trim(), signature: `${match[2]})`, line: source.slice(0, match.index).split("\n").length });
  }
  return calls;
}

describe("raw Enso call signatures", () => {
  const calls = rawCalls();

  it("finds the raw calls in enso.ts", () => {
    expect(calls.length).toBeGreaterThan(20);
  });

  it.each(calls.map((call) => [`${call.target} ${call.signature} (enso.ts:${call.line})`, call] as const))(
    "%s exists on the target contract",
    (_label, call) => {
      const selector = toFunctionSelector(`function ${call.signature}`);
      const isApprove = selector === "0x095ea7b3";
      if (call.target === "token" && isApprove) return; // rawApproveCallAction on an ERC20
      const staticTarget = STATIC_TARGETS[call.target];
      if (staticTarget) {
        expect(selectorsOf(staticTarget).has(selector), `${call.signature} is not a function on ${call.target}`).toBe(true);
        return;
      }
      // Dynamic external-vault targets: the signature must exist on the vaults of its family.
      const family = Object.entries(DYNAMIC_FAMILIES).find(([, vaults]) => vaults.every((vault) => selectorsOf(vault).has(selector)));
      expect(family, `${call.signature} on dynamic target ${call.target} matches no external vault family`).toBeDefined();
    },
  );
});
