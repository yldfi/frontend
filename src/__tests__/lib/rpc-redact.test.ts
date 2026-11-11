import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { redactRpcUrl, redactUrlsInText } from "@/lib/rpc-redact";

// enso.ts plus the modules it was split into; the RPC calls may live in any of them.
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

describe("redactRpcUrl", () => {
  it.each([
    ["https://rpc.example/rpc/abcdef0123456789secretkey", "rpc.example"],
    ["https://eth-mainnet.g.alchemy.com/v2/AlchemyKey123", "eth-mainnet.g.alchemy.com"],
    ["https://rpc.example.org:8545/path?apikey=xyz", "rpc.example.org:8545"],
    ["not a url", "<rpc>"],
  ])("keeps only the host of %s", (url, expected) => {
    expect(redactRpcUrl(url)).toBe(expected);
  });

  it("never interpolates a raw RPC URL into error messages", () => {
    // Keys live in some RPC URL paths (private-node, Alchemy); a full URL in an error reaches Workers Logs.
    const ensoFiles = ensoSourceFiles();
    // The RPC code lives in modules, not the barrel, so a fallback to enso.ts alone would make
    // this pass without reading what it guards.
    expect(ensoFiles.length).toBeGreaterThan(1);
    for (const file of [join(process.cwd(), "src/lib/curve/rpc.ts"), ...ensoFiles]) {
      const source = readFileSync(file, "utf-8");
      expect(source, file).not.toMatch(/new Error\(`[^`]*\$\{rpcUrl\}/);
    }
  });
});

describe("redactUrlsInText", () => {
  it("strips the path of a URL so an embedded key never reaches the caller", () => {
    expect(
      redactUrlsInText("fetch failed for https://rpc.example.invalid/v2/abcdef123 (timeout)")
    ).toBe("fetch failed for rpc.example.invalid (timeout)");
  });

  it("strips every URL in a message", () => {
    expect(
      redactUrlsInText(
        "no route: https://a.example.invalid/rpc/key1 then https://b.example.invalid/v2/key2"
      )
    ).toBe("no route: a.example.invalid then b.example.invalid");
  });

  it("scrubs a ws or wss URL", () => {
    expect(redactUrlsInText("wss://rpc.example.test/v2/KEY")).toBe("rpc.example.test");
    expect(redactUrlsInText("ws://rpc.example.test/v2/KEY")).toBe("rpc.example.test");
  });

  it("keeps a bracketed IPv6 host and drops its path", () => {
    const output = redactUrlsInText("rpc at http://[::1]:8545/KEY failed");
    expect(output).toBe("rpc at [::1]:8545 failed");
    expect(output).not.toContain("KEY");
  });

  it("drops userinfo, path and query but keeps the host and port", () => {
    expect(
      redactUrlsInText("https://user:pass@rpc.example.org:8545/v2/KEY?apikey=secret")
    ).toBe("rpc.example.org:8545");
  });

  it("leaves prose mentioning https and an address unchanged", () => {
    const message = "HTTPS is required before retrying 0xa0b8 for this route";
    expect(redactUrlsInText(message)).toBe(message);
  });

  it("keeps the character that ends a URL", () => {
    expect(redactUrlsInText("see (https://rpc.example.invalid/key)")).toBe(
      "see (rpc.example.invalid)"
    );
    expect(redactUrlsInText('at "https://rpc.example.invalid/key"')).toBe(
      'at "rpc.example.invalid"'
    );
  });

  it("leaves a message without URLs untouched, so UI substring matching still works", () => {
    const message = "Swap not found for 0xa0b8 -> 0x62b9";
    expect(redactUrlsInText(message)).toBe(message);
  });

  it.each([
    ["an unterminated IPv6 host with spaces", "http://[ ".repeat(20_000)],
    ["an unterminated IPv6 host without spaces", "http://[".repeat(50_000)],
    ["an over-long bracketed host", ("http://[" + "a".repeat(64) + " ").repeat(20_000)],
  ])("scrubs %s in well under a second", (_label, text) => {
    const started = performance.now();
    const output = redactUrlsInText(text);
    expect(performance.now() - started).toBeLessThan(200);
    expect(output).not.toContain("[");
  });

  it("drops the path of an IPv6 URL with a zone id", () => {
    const output = redactUrlsInText("https://[fe80::1%25eth0]:1/SECRETKEY");
    expect(output).not.toContain("SECRETKEY");
  });

  it("leaves nothing behind after an over-long bracketed host", () => {
    expect(redactUrlsInText("x https://[" + "a".repeat(65) + "]/SECRETKEY")).not.toContain(
      "SECRETKEY"
    );
  });

  it("leaves nothing behind after an over-long bracketed host with a zone id", () => {
    expect(
      redactUrlsInText("https://[fe80::1%25" + "a".repeat(60) + "]:1/SECRETKEY")
    ).not.toContain("SECRETKEY");
  });

  it.each([
    ["a port and digit", "id:1https://rpc.example/rpc/SECRETKEY"],
    ["an underscore", "_https://rpc.example/rpc/SECRETKEY"],
  ])("scrubs a URL glued to %s", (_label, text) => {
    expect(redactUrlsInText(text)).not.toContain("SECRETKEY");
  });

  it("scans only the first 4000 characters of a long message", () => {
    const output = redactUrlsInText("a".repeat(10_000));
    expect(output.length).toBeLessThan(4200);
    expect(output.endsWith("…")).toBe(true);
  });
});

