/**
 * Spike detection. Pure functions only.
 *
 * A metric spikes when today's account-wide total is at least SPIKE_RATIO × the median of the
 * previous 7 days AND at least the absolute threshold for that metric. The absolute floor stops
 * "3 requests vs. 0 yesterday" from paging you.
 */

export const SPIKE_RATIO = 10;

/** Metric key = `${product}.${metric}`, matching the / page and THRESHOLDS_JSON. */
export type MetricKey = string;

export const THRESHOLDS_AS_OF = "2026-09-15";

/**
 * Default absolute thresholds = 1% of the monthly included quota on Workers Paid, per
 * https://developers.cloudflare.com/{workers,d1,durable-objects,kv,r2,queues}/…/pricing/ (2026-09-15).
 * Items that Cloudflare does not bill (errors, D1 query counts, R2 "other") get a flat floor instead.
 */
export const DEFAULT_THRESHOLDS: Readonly<Record<MetricKey, number>> = {
  "workers.requests": 100_000, // 10M / month
  "workers.errors": 1_000, // not billed
  "workers.cpu_ms": 300_000, // 30M CPU-ms / month
  "d1.rows_read": 250_000_000, // 25B / month
  "d1.rows_written": 500_000, // 50M / month
  "d1.read_queries": 100_000, // not billed
  "d1.write_queries": 10_000, // not billed
  "do.requests": 10_000, // 1M / month
  "kv.read": 100_000, // 10M / month
  "kv.write": 10_000, // 1M / month
  "kv.delete": 10_000, // 1M / month
  "kv.list": 10_000, // 1M / month
  "kv.other": 10_000,
  "r2.class_a": 10_000, // 1M / month
  "r2.class_b": 100_000, // 10M / month
  "r2.other": 10_000,
  "queues.operations": 10_000, // 1M / month
};

/** Floor for metrics not in the table (e.g. a KV actionType Cloudflare adds later). */
export const FALLBACK_THRESHOLD = 10_000;

/**
 * Merge THRESHOLDS_JSON overrides onto the defaults. Empty / missing → defaults.
 * Invalid JSON or non-object throws so a typo in wrangler.jsonc is visible in the run log.
 */
export function parseThresholds(json: string | undefined): Record<MetricKey, number> {
  const out: Record<MetricKey, number> = { ...DEFAULT_THRESHOLDS };
  if (!json || json.trim() === "") return out;
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("THRESHOLDS_JSON must be a JSON object");
  }
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new Error(`THRESHOLDS_JSON[${k}] must be a non-negative number`);
    }
    out[k] = v;
  }
  return out;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid] as number;
  return ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export interface Spike {
  metric: MetricKey;
  today: number;
  /** Median of the previous days. 0 when every previous day was 0. */
  baseline: number;
  /** today / baseline; Infinity when baseline is 0. */
  ratio: number;
}

/**
 * @param today   account-wide totals for the current day, keyed by metric
 * @param last7   per-metric totals for the previous days (up to 7). A metric with no history is skipped:
 *                on the first day after deploy there is no baseline to compare against.
 */
export function spike(
  today: Readonly<Record<MetricKey, number>>,
  last7: Readonly<Record<MetricKey, readonly number[]>>,
  thresholds: Readonly<Record<MetricKey, number>> = DEFAULT_THRESHOLDS,
): Spike[] {
  const out: Spike[] = [];
  for (const metric of Object.keys(today).sort()) {
    const value = today[metric] as number;
    const history = last7[metric];
    if (!history || history.length === 0) continue;
    const floor = thresholds[metric] ?? FALLBACK_THRESHOLD;
    if (value < floor) continue;
    const baseline = median(history);
    const ratio = baseline === 0 ? Number.POSITIVE_INFINITY : value / baseline;
    if (ratio < SPIKE_RATIO) continue;
    out.push({ metric, today: value, baseline, ratio });
  }
  return out;
}

export function formatRatio(ratio: number): string {
  return Number.isFinite(ratio) ? `${ratio.toFixed(1)}×` : "new";
}
