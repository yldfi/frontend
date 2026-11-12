// @vitest-environment node
/**
 * Keeps the rate limits in wrangler.jsonc and the binding names the routes ask
 * for in step.
 *
 * Neither drift fails loudly at runtime: a renamed or removed binding silently
 * falls back to the per-isolate counter (so the shared limit stops applying),
 * and a namespace_id collision is only reported at deploy time, or worse,
 * quietly shares a counter with another app on the same Cloudflare account.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const { mockGetCloudflareContext } = vi.hoisted(() => ({
  mockGetCloudflareContext: vi.fn(),
}));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: mockGetCloudflareContext,
}));

import { createSharedRateLimiter } from "@/lib/rate-limit";

type RateLimitEntry = {
  name: string;
  namespace_id: string;
  simple: { limit: number; period: number };
};

type WranglerConfig = { ratelimits?: RateLimitEntry[] };

/**
 * wrangler.jsonc is JSON with comments. Only `//` comments that start a line
 * (after optional whitespace) are stripped, so a `//` inside a JSON string
 * such as a URL survives; block comments are removed wherever they appear.
 */
function stripJsoncComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

const ROOT = process.cwd();

function readRepoFile(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf-8");
}

const NAMESPACE_MIN = 3001;
const NAMESPACE_MAX = 3099;

// Binding name -> the limit its route was written against, and that route.
const EXPECTED: Record<string, { limit: number; route: string }> = {
  RL_ENSO: { limit: 120, route: "src/app/api/enso/[method]/route.ts" },
  RL_SIMULATE: { limit: 8, route: "src/app/api/simulate/route.ts" },
  RL_SIMULATE_NONCE: { limit: 20, route: "src/app/api/simulate/nonce/route.ts" },
  RL_TOKEN_HOLDERS: { limit: 30, route: "src/app/api/token-holders/route.ts" },
  RL_EXPLORER: { limit: 30, route: "src/app/api/explorer/route.ts" },
};

const CASES = Object.entries(EXPECTED).map(([name, { limit, route }]) => ({ name, limit, route }));

const config = JSON.parse(stripJsoncComments(readRepoFile("wrangler.jsonc"))) as WranglerConfig;
const ratelimits = config.ratelimits ?? [];

beforeEach(() => {
  mockGetCloudflareContext.mockReset();
});

describe("rate limit bindings", () => {
  it("declares exactly the expected limits, all per minute", () => {
    expect(
      ratelimits.map((entry) => ({
        name: entry.name,
        limit: entry.simple.limit,
        period: entry.simple.period,
      })),
    ).toEqual(
      Object.entries(EXPECTED).map(([name, { limit }]) => ({ name, limit, period: 60 })),
    );
  });

  it("keeps every namespace_id a distinct string in the reserved range", () => {
    const ids = ratelimits.map((entry) => entry.namespace_id);

    for (const id of ids) {
      expect(typeof id).toBe("string");
      expect(/^\d+$/.test(id)).toBe(true);
      expect(Number(id)).toBeGreaterThanOrEqual(NAMESPACE_MIN);
      expect(Number(id)).toBeLessThanOrEqual(NAMESPACE_MAX);
    }

    // Duplicates across the account make unrelated apps share one counter.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(CASES)("route for $name asks for that exact binding", ({ name, route }) => {
    expect(readRepoFile(route)).toContain(`createSharedRateLimiter("${name}"`);
  });

  it.each(CASES)("$name is the key the Worker env is read with", async ({ name }) => {
    const limit = vi.fn(async () => ({ success: true }));
    mockGetCloudflareContext.mockReturnValue({ env: { [name]: { limit } } });

    const isRateLimited = createSharedRateLimiter(name, 1);

    // The in-memory layer passes the first call, so a binding lookup confirms
    // the config name is the key the route's limiter will find in `env`.
    await expect(isRateLimited("203.0.113.7")).resolves.toBe(false);
    expect(limit).toHaveBeenCalledWith({ key: "203.0.113.7" });
  });
});
