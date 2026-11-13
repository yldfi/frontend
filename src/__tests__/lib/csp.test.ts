import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy } from "@/lib/csp";
import {
  FLASHBOTS_RPC_URL,
  PRIVACY_SAFE_DOMAINS,
  RPC_URL_LIST,
} from "@/config/rpc";

function directivesOf(csp: string): Map<string, string> {
  return new Map(
    csp.split("; ").map((part) => {
      const [name, ...sources] = part.split(" ");
      return [name, sources.join(" ")] as const;
    }),
  );
}

describe("buildContentSecurityPolicy", () => {
  it("locks down plugins, base URI, form targets and the default source", () => {
    const csp = buildContentSecurityPolicy({ isDev: false });
    const directives = directivesOf(csp);

    expect(directives.get("object-src")).toBe("'none'");
    expect(directives.get("base-uri")).toBe("'self'");
    expect(directives.get("form-action")).toBe("'self'");
    expect(directives.get("default-src")).toBe("'self'");
  });

  it("is a single serialised line without frame-ancestors", () => {
    const csp = buildContentSecurityPolicy({ isDev: true });

    expect(csp).not.toContain("\n");
    expect(csp).not.toContain("frame-ancestors");
  });

  it("keeps production free of eval, localhost and plain-http sources", () => {
    const csp = buildContentSecurityPolicy({ isDev: false });

    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("localhost");
    expect(csp).not.toMatch(/\shttp:\/\//);
  });

  it("allows eval and the local dev servers in development only", () => {
    const csp = buildContentSecurityPolicy({ isDev: true });

    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("ws://localhost:*");
  });

  it("covers every exported RPC URL origin in connect-src", () => {
    const connectSrc = directivesOf(buildContentSecurityPolicy({ isDev: false })).get("connect-src");

    expect(connectSrc).toBeDefined();
    for (const url of [...RPC_URL_LIST, FLASHBOTS_RPC_URL]) {
      expect(connectSrc!.split(" ")).toContain(new URL(url).origin);
    }
  });

  it("covers every dynamic-discovery host in connect-src", () => {
    const connectSrc = directivesOf(buildContentSecurityPolicy({ isDev: false })).get("connect-src");

    expect(connectSrc).toBeDefined();
    for (const host of PRIVACY_SAFE_DOMAINS) {
      expect(connectSrc!.split(" ")).toContain(`https://${host}`);
    }
  });

  it("covers the Coinbase Wallet SDK origins in connect-src only", () => {
    const directives = directivesOf(buildContentSecurityPolicy({ isDev: false }));
    const connectSrc = directives.get("connect-src")!.split(" ");
    const coinbaseSources = [
      "https://*.coinbase.com",
      "https://www.walletlink.org",
      "wss://www.walletlink.org",
    ];

    for (const source of coinbaseSources) {
      expect(connectSrc).toContain(source);
      for (const [name, value] of directives) {
        if (name === "connect-src") continue;
        expect(value.split(" ")).not.toContain(source);
      }
    }
  });

  it("allows the MetaMask SDK relay in connect-src in production and development", () => {
    for (const isDev of [false, true]) {
      const connectSrc = directivesOf(buildContentSecurityPolicy({ isDev })).get("connect-src")!.split(" ");

      expect(connectSrc).toContain("https://metamask-sdk.api.cx.metamask.io");
      expect(connectSrc).toContain("wss://metamask-sdk.api.cx.metamask.io");
    }
  });

  it("leaves frame-src, style-src and font-src unchanged", () => {
    for (const isDev of [false, true]) {
      const directives = directivesOf(buildContentSecurityPolicy({ isDev }));

      expect(directives.get("frame-src")).toBe(
        "'self' https://verify.walletconnect.com https://verify.walletconnect.org",
      );
      expect(directives.get("style-src")).toBe("'self' 'unsafe-inline'");
      expect(directives.get("font-src")).toBe("'self' data:");
    }
  });

  it("lists no source twice in connect-src", () => {
    for (const isDev of [false, true]) {
      const connectSrc = directivesOf(buildContentSecurityPolicy({ isDev })).get("connect-src")!.split(" ");

      expect(connectSrc).toHaveLength(new Set(connectSrc).size);
    }
  });

  it("appends extra connect sources to connect-src only", () => {
    const csp = buildContentSecurityPolicy({
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
    const csp = buildContentSecurityPolicy({
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
    const csp = buildContentSecurityPolicy({
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

  it("adds no frame-ancestors directive by default", () => {
    expect(buildContentSecurityPolicy({ isDev: false })).not.toContain("frame-ancestors");
  });

  it("appends frame-ancestors as the last directive when asked", () => {
    const withoutOption = buildContentSecurityPolicy({ isDev: false });
    const withOption = buildContentSecurityPolicy({
      isDev: false,
      frameAncestors: "'self' https://app.safe.global",
    });
    const directives = withOption.split("; ");

    expect(directives.at(-1)).toBe("frame-ancestors 'self' https://app.safe.global");
    expect(directives.slice(0, -1).join("; ")).toBe(withoutOption);
  });

  it("adds nothing for an empty frame-ancestors string", () => {
    expect(buildContentSecurityPolicy({ isDev: false, frameAncestors: "" })).toBe(
      buildContentSecurityPolicy({ isDev: false }),
    );
  });
});
