import { describe, expect, it } from "vitest";
import { buildReportOnlyCsp } from "@/lib/csp";
import { FLASHBOTS_RPC_URL, RPC_URL_LIST } from "@/config/rpc";

function directivesOf(csp: string): Map<string, string> {
  return new Map(
    csp.split("; ").map((part) => {
      const [name, ...sources] = part.split(" ");
      return [name, sources.join(" ")] as const;
    }),
  );
}

describe("buildReportOnlyCsp", () => {
  it("locks down plugins, base URI, form targets and the default source", () => {
    const csp = buildReportOnlyCsp({ isDev: false });
    const directives = directivesOf(csp);

    expect(directives.get("object-src")).toBe("'none'");
    expect(directives.get("base-uri")).toBe("'self'");
    expect(directives.get("form-action")).toBe("'self'");
    expect(directives.get("default-src")).toBe("'self'");
  });

  it("is a single serialised line without frame-ancestors", () => {
    const csp = buildReportOnlyCsp({ isDev: true });

    expect(csp).not.toContain("\n");
    expect(csp).not.toContain("frame-ancestors");
  });

  it("keeps production free of eval, localhost and plain-http sources", () => {
    const csp = buildReportOnlyCsp({ isDev: false });

    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("localhost");
    expect(csp).not.toMatch(/\shttp:\/\//);
  });

  it("allows eval and the local dev servers in development only", () => {
    const csp = buildReportOnlyCsp({ isDev: true });

    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("ws://localhost:*");
  });

  it("covers every exported RPC URL origin in connect-src", () => {
    const connectSrc = directivesOf(buildReportOnlyCsp({ isDev: false })).get("connect-src");

    expect(connectSrc).toBeDefined();
    for (const url of [...RPC_URL_LIST, FLASHBOTS_RPC_URL]) {
      expect(connectSrc!.split(" ")).toContain(new URL(url).origin);
    }
  });

  it("appends extra connect sources to connect-src only", () => {
    const csp = buildReportOnlyCsp({
      isDev: false,
      extraConnectSrc: ["https://example-rpc.test"],
    });
    const directives = directivesOf(csp);

    expect(directives.get("connect-src")!.split(" ")).toContain("https://example-rpc.test");
    for (const [name, sources] of directives) {
      if (name === "connect-src") continue;
      expect(sources).not.toContain("https://example-rpc.test");
    }
  });

  it("reduces extra connect sources to origins, dropping credentials, paths and queries", () => {
    const csp = buildReportOnlyCsp({
      isDev: false,
      extraConnectSrc: ["https://user:pass@rpc.example.test/v2/SECRETKEY?x=1#y"],
    });
    const connectSrc = directivesOf(csp).get("connect-src")!.split(" ");

    expect(connectSrc).toContain("https://rpc.example.test");
    expect(connectSrc).not.toContain("null");
    expect(csp).not.toContain("SECRETKEY");
    // Not plain "user": the policy legitimately contains raw.githubusercontent.com.
    expect(csp).not.toContain("user:pass");
    expect(csp).not.toContain("user@");
  });

  it("drops extra connect sources that are not plain http(s) origins", () => {
    const csp = buildReportOnlyCsp({
      isDev: false,
      extraConnectSrc: ["not a url", "foo:bar", "file:///etc/hosts", "https://a.com;x"],
    });
    const connectSrc = directivesOf(csp).get("connect-src")!.split(" ");

    expect(connectSrc).not.toContain("null");
    expect(connectSrc).not.toContain("foo:bar");
    expect(connectSrc).not.toContain("file:///etc/hosts");
    expect(connectSrc).not.toContain("https://a.com;x");
    expect(csp).not.toContain("not a url");
  });
});
