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
    // Keys live in some RPC URL paths (a private node, Alchemy); a full URL in an error reaches Workers Logs.
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

  it("loses the character that ends a quoted URL (cosmetic cost in a log line)", () => {
    expect(redactUrlsInText("see (https://rpc.example.invalid/key)")).toBe("see (rpc.example.invalid");
    expect(redactUrlsInText('at "https://rpc.example.invalid/key"')).toBe('at "rpc.example.invalid');
  });

  it.each([
    ["a closing paren in the path", "https://rpc.example.invalid/rpc/SECRET)KEY"],
    ["a closing bracket in the path", "https://rpc.example.invalid/rpc/SECRET]KEY"],
    ["an apostrophe in the path", "https://rpc.example.invalid/rpc/SECRET'KEY"],
    ["a double quote in the path", 'https://rpc.example.invalid/rpc/SECRET"KEY'],
    ["a closing paren in the query", "https://rpc.example.invalid/rpc?key=SECRET)KEY"],
    ["a closing bracket in the query", "https://rpc.example.invalid/rpc?key=SECRET]KEY"],
    ["an apostrophe in the query", "https://rpc.example.invalid/rpc?key=SECRET'KEY"],
    ["a double quote in the query", 'https://rpc.example.invalid/rpc?key=SECRET"KEY'],
  ])("fully removes a key containing %s", (_label, text) => {
    // The exact output: a key that survives after the delimiter used to stay
    // visible, so asserting only that "SECRET" is gone would pass either way.
    expect(redactUrlsInText(`call to ${text} failed`)).toBe("call to rpc.example.invalid failed");
  });

  it.each([
    ["junk after the host with no slash", "https://h.example)SECRET", "h.example", "secret"],
    ["a URL inside a JSON body", '{"e":"https://h.example","next":"x"}', "h.example", "next"],
  ])("keeps only the host of %s", (_label, text, host, hidden) => {
    const output = redactUrlsInText(text).toLowerCase();
    expect(output).toContain(host);
    expect(output).not.toContain(hidden);
  });

  it("drops userinfo in front of the host", () => {
    const output = redactUrlsInText("https://user:pass@h.example/k");
    expect(output).toContain("h.example");
    expect(output).not.toContain("user");
    expect(output).not.toContain("pass");
  });

  it("keeps the port of a URL inside text", () => {
    expect(redactUrlsInText("https://h.example:8443/k")).toBe("h.example:8443");
  });

  it("falls back to <rpc> when the match has no valid host", () => {
    expect(redactUrlsInText("https://)x")).toBe("<rpc>");
  });

  it("scrubs a URL glued directly to a preceding letter", () => {
    expect(redactUrlsInText("xhttps://node.example/rpc/SECRETKEY")).toBe("xnode.example");
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

  it.each([
    ["an unterminated IPv6 host", "http://[".repeat(500)],
    ["a URL followed by closing parens", "https://a.example/" + ")".repeat(3900)],
    ["a 3990 character single-label host", "https://" + "a".repeat(3990)],
    ["a 3990 character dotted host", "https://a" + ".a".repeat(1990) + "a"],
  ])("scrubs %s in under 50 ms", (_label, text) => {
    const started = performance.now();
    redactUrlsInText(text);
    expect(performance.now() - started).toBeLessThan(50);
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
    ["a port and digit", "id:1https://node.example/rpc/SECRETKEY"],
    ["an underscore", "_https://node.example/rpc/SECRETKEY"],
  ])("scrubs a URL glued to %s", (_label, text) => {
    expect(redactUrlsInText(text)).not.toContain("SECRETKEY");
  });

  it("scans only the first 4000 characters of a long message", () => {
    const output = redactUrlsInText("a".repeat(10_000));
    expect(output.length).toBeLessThan(4200);
    expect(output.endsWith("…")).toBe(true);
  });
});

