/**
 * D1 access. Everything the page and the spike check read comes through `loadTotals`, so both see
 * the same numbers.
 */
import type { UsageRow } from "./graphql";
import type { MetricKey, Spike } from "./spike";

const UPSERT = `INSERT INTO usage_daily (date, product, metric, dim, value, collected_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6)
ON CONFLICT (date, product, metric, dim) DO UPDATE SET value = excluded.value, collected_at = excluded.collected_at`;

export async function upsertRows(
  db: D1Database,
  rows: UsageRow[],
  collectedAt: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(UPSERT);
  await db.batch(
    rows.map((r) => stmt.bind(r.date, r.product, r.metric, r.dim, r.value, collectedAt)),
  );
  return rows.length;
}

export interface TotalRow {
  date: string;
  metric: MetricKey;
  value: number;
}

/** Account-wide totals per (date, metric) for dates in [from, to], summed across dimensions. */
export async function loadTotals(db: D1Database, from: string, to: string): Promise<TotalRow[]> {
  const res = await db
    .prepare(
      `SELECT date, product || '.' || metric AS metric, SUM(value) AS value
       FROM usage_daily WHERE date >= ?1 AND date <= ?2
       GROUP BY date, product, metric ORDER BY date, metric`,
    )
    .bind(from, to)
    .all<TotalRow>();
  return res.results;
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

/** Drop spikes that were already posted for this date. */
export async function filterUnnotified(
  db: D1Database,
  date: string,
  spikes: Spike[],
): Promise<Spike[]> {
  if (spikes.length === 0) return [];
  const res = await db
    .prepare("SELECT product || '.' || metric AS metric FROM spike_notified WHERE date = ?1")
    .bind(date)
    .all<{ metric: string }>();
  const seen = new Set(res.results.map((r) => r.metric));
  return spikes.filter((s) => !seen.has(s.metric));
}

export async function markNotified(
  db: D1Database,
  date: string,
  spikes: Spike[],
  notifiedAt: string,
): Promise<void> {
  if (spikes.length === 0) return;
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO spike_notified (date, product, metric, notified_at) VALUES (?1, ?2, ?3, ?4)",
  );
  await db.batch(
    spikes.map((s) => {
      const [product, metric] = splitKey(s.metric);
      return stmt.bind(date, product, metric, notifiedAt);
    }),
  );
}

export function splitKey(key: MetricKey): [string, string] {
  const i = key.indexOf(".");
  return i < 0 ? [key, ""] : [key.slice(0, i), key.slice(i + 1)];
}
