/**
 * D1 access. Everything the page, the spike check and the limit check read comes through `loadTotals`, so
 * they all see the same numbers.
 *
 * `account` is "" on a single-account deploy (so pre-multi-account history keeps working) and the account
 * id when several accounts are watched. It is a trailing, defaulted parameter everywhere.
 */
import type { UsageRow } from "./graphql";
import type { LimitStatus } from "./limits";
import type { MetricKey, Spike } from "./spike";

const UPSERT = `INSERT INTO usage_daily (account, date, product, metric, dim, value, collected_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
ON CONFLICT (account, date, product, metric, dim) DO UPDATE SET value = excluded.value, collected_at = excluded.collected_at`;

export async function upsertRows(
  db: D1Database,
  rows: UsageRow[],
  collectedAt: string,
  account = "",
): Promise<number> {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(UPSERT);
  await db.batch(
    rows.map((r) => stmt.bind(account, r.date, r.product, r.metric, r.dim, r.value, collectedAt)),
  );
  return rows.length;
}

export interface TotalRow {
  date: string;
  metric: MetricKey;
  value: number;
}

/** Totals per (date, metric) for dates in [from, to], summed across dimensions, for one account. */
export async function loadTotals(
  db: D1Database,
  from: string,
  to: string,
  account = "",
): Promise<TotalRow[]> {
  const res = await db
    .prepare(
      `SELECT date, product || '.' || metric AS metric, SUM(value) AS value
       FROM usage_daily WHERE date >= ?1 AND date <= ?2 AND account = ?3
       GROUP BY date, product, metric ORDER BY date, metric`,
    )
    .bind(from, to, account)
    .all<TotalRow>();
  return res.results;
}

/** Pure: sum totals per metric across the dates given (e.g. month-to-date). */
export function sumByMetric(rows: readonly TotalRow[]): Record<MetricKey, number> {
  const out: Record<MetricKey, number> = {};
  for (const r of rows) out[r.metric] = (out[r.metric] ?? 0) + r.value;
  return out;
}

export interface Series {
  today: Record<MetricKey, number>;
  last7: Record<MetricKey, number[]>;
}

/** Pure: split totals into today's values and per-metric history (dates before `today`). */
export function buildSeries(rows: readonly TotalRow[], today: string): Series {
  const out: Series = { today: {}, last7: {} };
  for (const r of rows) {
    if (r.date === today) {
      out.today[r.metric] = r.value;
    } else if (r.date < today) {
      const hist = out.last7[r.metric] ?? [];
      hist.push(r.value);
      out.last7[r.metric] = hist;
    }
  }
  return out;
}

/** Pure: metric → date → value, for the table on the / page. */
export function pivot(rows: readonly TotalRow[]): Map<MetricKey, Map<string, number>> {
  const m = new Map<MetricKey, Map<string, number>>();
  for (const r of rows) {
    const byDate = m.get(r.metric) ?? new Map<string, number>();
    byDate.set(r.date, r.value);
    m.set(r.metric, byDate);
  }
  return m;
}

/** Drop spikes that were already posted for this date and account. */
export async function filterUnnotified(
  db: D1Database,
  date: string,
  spikes: Spike[],
  account = "",
): Promise<Spike[]> {
  if (spikes.length === 0) return [];
  const res = await db
    .prepare(
      "SELECT product || '.' || metric AS metric FROM spike_notified WHERE date = ?1 AND account = ?2",
    )
    .bind(date, account)
    .all<{ metric: string }>();
  const seen = new Set(res.results.map((r) => r.metric));
  return spikes.filter((s) => !seen.has(s.metric));
}

export async function markNotified(
  db: D1Database,
  date: string,
  spikes: readonly Spike[],
  notifiedAt: string,
  account = "",
): Promise<void> {
  if (spikes.length === 0) return;
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO spike_notified (account, date, product, metric, notified_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  );
  await db.batch(
    spikes.map((s) => {
      const [product, metric] = splitKey(s.metric);
      return stmt.bind(account, date, product, metric, notifiedAt);
    }),
  );
}

/**
 * Keep only limit statuses that crossed a level higher than any already posted for the same account,
 * period and metric. So 50% → 80% → 95% each alert once, and a lower level never re-alerts.
 */
export async function filterUnnotifiedLimits(
  db: D1Database,
  account: string,
  statuses: readonly LimitStatus[],
): Promise<LimitStatus[]> {
  const crossed = statuses.filter((s) => s.level !== null);
  if (crossed.length === 0) return [];
  const periods = [...new Set(crossed.map((s) => s.periodKey))];
  const res = await db
    .prepare(
      `SELECT period, product || '.' || metric AS metric, MAX(level) AS level FROM limit_notified
       WHERE account = ?1 AND period IN (${periods.map((_, i) => `?${i + 2}`).join(", ")})
       GROUP BY period, product, metric`,
    )
    .bind(account, ...periods)
    .all<{ period: string; metric: string; level: number }>();
  const seen = new Map(res.results.map((r) => [`${r.period}|${r.metric}`, r.level]));
  return crossed.filter((s) => (s.level as number) > (seen.get(`${s.periodKey}|${s.metric}`) ?? 0));
}

export async function markLimitNotified(
  db: D1Database,
  account: string,
  statuses: readonly LimitStatus[],
  notifiedAt: string,
): Promise<void> {
  if (statuses.length === 0) return;
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO limit_notified (account, period, product, metric, level, notified_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  );
  await db.batch(
    statuses.map((s) => {
      const [product, metric] = splitKey(s.metric);
      return stmt.bind(account, s.periodKey, product, metric, s.level, notifiedAt);
    }),
  );
}

export function splitKey(key: MetricKey): [string, string] {
  const i = key.indexOf(".");
  return i < 0 ? [key, ""] : [key.slice(0, i), key.slice(i + 1)];
}
