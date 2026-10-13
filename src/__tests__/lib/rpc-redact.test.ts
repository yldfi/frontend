import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { redactRpcUrl } from "@/lib/rpc-redact";

describe("redactRpcUrl", () => {
  it.each([
    ["https://muupe.com/rpc/abcdef0123456789secretkey", "muupe.com"],
    ["https://eth-mainnet.g.alchemy.com/v2/AlchemyKey123", "eth-mainnet.g.alchemy.com"],
    ["https://rpc.example.org:8545/path?apikey=xyz", "rpc.example.org:8545"],
    ["not a url", "<rpc>"],
  ])("keeps only the host of %s", (url, expected) => {
    expect(redactRpcUrl(url)).toBe(expected);
  });

  it("never interpolates a raw RPC URL into error messages", () => {
    // Keys live in some RPC URL paths (muupe, Alchemy); a full URL in an error reaches Workers Logs.
    for (const file of ["src/lib/curve/rpc.ts", "src/lib/enso.ts"]) {
      const source = readFileSync(join(process.cwd(), file), "utf-8");
      expect(source, file).not.toMatch(/new Error\(`[^`]*\$\{rpcUrl\}/);
    }
  });
});
