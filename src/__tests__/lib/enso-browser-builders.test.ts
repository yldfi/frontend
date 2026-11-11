import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchLpxCvxZapInRoute, fetchPxCvxTokenZapInRoute } from "@/lib/enso";
import { TOKENS, VAULT_ADDRESSES } from "@/config/vaults";

const USER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

function listSource(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : listSource(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

// enso.ts plus the modules it was split into. Each file is sliced on its own, so a body can
// never run on into the next file's exports.
function ensoSourceFiles(): string[] {
  const entry = join(process.cwd(), "src/lib/enso.ts");
  let modules: string[] = [];
  try {
    modules = readdirSync(join(process.cwd(), "src/lib/enso"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(process.cwd(), "src/lib/enso", name));
  } catch {
    modules = []; // the directory does not exist (older checkouts): scan enso.ts alone
  }
  return [entry, ...modules.sort()];
}

describe("browser-reachable Enso bundle builders", () => {
  it("never build raw bundles in the browser: client-imported builders that call fetchBundle must route through an intent", () => {
    const sources = ensoSourceFiles().map((path) => readFileSync(path, "utf-8"));
    const clientSource = ["src/hooks", "src/components", "src/app"]
      .flatMap((dir) => listSource(join(process.cwd(), dir)))
      .filter((path) => !path.includes(`${join("src", "app", "api")}`))
      .map((path) => readFileSync(path, "utf-8"))
      .join("\n");

    const functions = sources.flatMap((source) => {
      const starts = [...source.matchAll(/\nexport async function (\w+)\(/g)].map((m) => ({ name: m[1], index: m.index! }));
      return starts.map((start, i) => ({ name: start.name, body: source.slice(start.index, starts[i + 1]?.index ?? source.length) }));
    });
    const offenders = functions
      .filter(({ body }) => body.includes("fetchBundle(") && !body.includes('typeof window !== "undefined"'))
      .filter(({ name }) => new RegExp(`\\b${name}\\b`).test(clientSource))
      .map(({ name }) => name);

    // fetchBundle throws in the browser, so any of these would make its zap pair unquotable.
    expect(offenders).toEqual([]);

    // 44 exported async functions lived in enso.ts alone at a98ab82. If the scan finds fewer
    // across the modules, it has stopped looking at the code and is passing vacuously.
    expect(functions.length).toBeGreaterThanOrEqual(44);
    expect(functions.some(({ body }) => body.includes("fetchBundle("))).toBe(true);

    // The count can stay high on helpers alone (they are exported now), so pin the builders by
    // name: a renamed or relocated builder must fail here instead of silently leaving the scan.
    const scannedNames = new Set(functions.map(({ name }) => name));
    for (const name of ["fetchZapInRoute", "fetchZapOutRoute", "fetchVaultToVaultRoute", "fetchBundle"]) {
      expect(scannedNames.has(name), `${name} is missing from the scanned Enso modules`).toBe(true);
    }
  });

  describe("in the browser", () => {
    afterEach(() => vi.unstubAllGlobals());

    it.each([
      ["pxCVX", () => fetchPxCvxTokenZapInRoute({ fromAddress: USER, vaultAddress: VAULT_ADDRESSES.YSCVX, amountIn: "1", slippage: "100" }), TOKENS.PXCVX],
      ["lpxCVX", () => fetchLpxCvxZapInRoute({ fromAddress: USER, vaultAddress: VAULT_ADDRESSES.YSCVX, amountIn: "1", slippage: "100" }), TOKENS.LPXCVX],
    ])("sends %s -> yld vault zaps to the illiquidToYldVault intent", async (_label, build, inputToken) => {
      expect(typeof window).toBe("object");
      const fetchMock = vi.fn(async () => ({ ok: false, statusText: "stub", json: async () => ({ error: "stub" }) }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(build()).rejects.toThrow("stub");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("/api/enso/intent");
      expect(JSON.parse(String(init.body))).toEqual({
        intent: "illiquidToYldVault",
        fromAddress: USER,
        inputToken,
        vaultAddress: VAULT_ADDRESSES.YSCVX,
        amountIn: "1",
        slippage: "100",
        receiver: USER,
      });
    });
  });
});
