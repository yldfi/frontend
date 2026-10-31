import { describe, it, expect } from "vitest";

import { pruneLogs, LOG_PRUNE_BATCH, LOG_RETENTION_DAYS } from "../../../workers/log-retention";

class FakeD1 {
  sql = "";
  args: unknown[] = [];
  constructor(private changes: number | undefined) {}
  prepare(sql: string) {
    this.sql = sql;
    return {
      bind: (...args: unknown[]) => {
        this.args = args;
        return { run: async () => ({ meta: { changes: this.changes } }) };
      },
    };
  }
}

describe("pruneLogs", () => {
  it("deletes a bounded batch of rows older than the retention window", async () => {
    const db = new FakeD1(42);
    const now = new Date("2026-11-01T00:00:00.000Z");

    const deleted = await pruneLogs(db as unknown as D1Database, now);

    expect(deleted).toBe(42);
    expect(db.sql).toMatch(/DELETE FROM logs WHERE id IN \(SELECT id FROM logs WHERE timestamp < \? LIMIT \?\)/);
    expect(db.args).toEqual(["2026-10-02T00:00:00.000Z", LOG_PRUNE_BATCH]);
  });

  it("keeps the daily write budget under the D1 Free plan cap", () => {
    // 96 history-cron runs/day, ~3 rows written per deleted row (row + 2 indexes),
    // plus ~7.5k/day from normal inserts; leave at least half of the 100k cap free.
    const pruneWrites = 96 * LOG_PRUNE_BATCH * 3;
    expect(pruneWrites + 7_500).toBeLessThan(50_000);
    expect(LOG_RETENTION_DAYS).toBeGreaterThanOrEqual(7);
  });

  it("returns 0 when D1 reports no change count", async () => {
    const db = new FakeD1(undefined);
    expect(await pruneLogs(db as unknown as D1Database)).toBe(0);
  });
});
