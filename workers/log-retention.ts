/**
 * Retention for the D1 `logs` table, which otherwise grows without bound.
 *
 * The Workers Free plan caps D1 at 100k rows written per day, and every deleted
 * row counts as written (plus its two index entries). A single unbounded DELETE
 * of old rows used 91k of that cap on 2026-10-31. So each run removes at most
 * LOG_PRUNE_BATCH rows. Run on the 15-minute history cron (96 runs/day), that
 * clears up to 9,600 rows/day (~29k rows written), leaving plenty of headroom for
 * normal inserts (~1,440 rows/day). Once the backlog is gone it only deletes the
 * ~1,440 rows/day that age out.
 */
export const LOG_RETENTION_DAYS = 30;
export const LOG_PRUNE_BATCH = 100;

/**
 * Delete up to `batch` log rows older than the retention window.
 * The inner SELECT uses idx_logs_timestamp and stops at the LIMIT, so it reads
 * about `batch` rows rather than scanning the table. Returns the number deleted.
 */
export async function pruneLogs(
  db: D1Database,
  now: Date = new Date(),
  retentionDays: number = LOG_RETENTION_DAYS,
  batch: number = LOG_PRUNE_BATCH,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  const result = await db
    .prepare("DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE timestamp < ? LIMIT ?)")
    .bind(cutoff, batch)
    .run();
  return result.meta?.changes ?? 0;
}
