/**
 * Free-plan limit alerts. Pure functions only.
 *
 * Opt-in: nothing here runs unless LIMIT_LEVELS is set (e.g. "50,80,95"), so Workers Paid users see no
 * free-plan noise. A metric "crosses" a level when today's total (or month-to-date, for monthly limits)
 * reaches that percentage of its included amount. Each level alerts once per account and period.
 */
import type { MetricKey } from "./spike";

export type Period = "day" | "month";

export interface Limit {
  limit: number;
  period: Period;
}

export const LIMITS_AS_OF = "2026-10-18";

/**
 * Workers Free plan included usage, per account. Daily limits reset at 00:00 UTC.
 *   Workers https://developers.cloudflare.com/workers/platform/pricing/
 *   D1      https://developers.cloudflare.com/d1/platform/pricing/
 *   DO      https://developers.cloudflare.com/durable-objects/platform/pricing/ (SQLite-backed, the only kind on Free)
 *   KV      https://developers.cloudflare.com/kv/platform/pricing/
 *   R2      https://developers.cloudflare.com/r2/pricing/ (per month)
 *   Queues  https://developers.cloudflare.com/queues/platform/pricing/
 * Storage limits (D1 GB, R2 GB-month, DO GB) are not in the daily analytics query, so they are not here.
 */
export const FREE_PLAN_LIMITS: Readonly<Record<MetricKey, Limit>> = {
  "workers.requests": { limit: 100_000, period: "day" },
  "d1.rows_read": { limit: 5_000_000, period: "day" },
  "d1.rows_written": { limit: 100_000, period: "day" },
  "do.requests": { limit: 100_000, period: "day" },
  "kv.read": { limit: 100_000, period: "day" },
  "kv.write": { limit: 1_000, period: "day" },
  "kv.delete": { limit: 1_000, period: "day" },
  "kv.list": { limit: 1_000, period: "day" },
  "queues.operations": { limit: 10_000, period: "day" },
  "r2.class_a": { limit: 1_000_000, period: "month" },
  "r2.class_b": { limit: 10_000_000, period: "month" },
};

/**
 * Merge LIMITS_JSON overrides onto the free-plan table. A number replaces the included amount (keeping the
 * metric's period, "day" for metrics not in the table); 0 removes the metric. Invalid input throws so a typo
 * shows up in the run log.
 */
export function parseLimits(json: string | undefined): Record<MetricKey, Limit> {
  const out: Record<MetricKey, Limit> = { ...FREE_PLAN_LIMITS };
  if (!json || json.trim() === "") return out;
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("LIMITS_JSON must be a JSON object");
  }
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new Error(`LIMITS_JSON[${k}] must be a non-negative number`);
    }
    if (v === 0) delete out[k];
    else out[k] = { limit: v, period: FREE_PLAN_LIMITS[k]?.period ?? "day" };
  }
  return out;
}

/** "50, 80,95" → [50, 80, 95]. Whole percentages 1–100, de-duplicated and sorted; anything else throws. */
export function parseLevels(raw: string): number[] {
  const levels = raw.split(",").map((s) => Number(s.trim()));
  if (levels.length === 0 || levels.some((n) => !Number.isInteger(n) || n < 1 || n > 100)) {
    throw new Error("LIMIT_LEVELS must be comma-separated whole percentages from 1 to 100");
  }
  return [...new Set(levels)].sort((a, b) => a - b);
}

export interface LimitStatus {
  metric: MetricKey;
  used: number;
  limit: number;
  period: Period;
  /** "YYYY-MM-DD" for daily limits, "YYYY-MM" for monthly ones: alerts repeat once per period. */
  periodKey: string;
  pct: number;
  /** Highest configured level reached, or null when below the lowest one. */
  level: number | null;
  /** A state problem rather than a percentage (e.g. "project is paused"); replaces the numbers in the alert. */
  note?: string;
  /** When this quota next resets, if the platform's API says so (ISO). Otherwise the calendar rule applies. */
  resetsAt?: string;
}

/**
 * @param today   "YYYY-MM-DD" (UTC)
 * @param day     today's totals by metric
 * @param month   month-to-date totals by metric (used for monthly limits)
 * Metrics with no usage are left out.
 */
export function limitStatus(
  today: string,
  day: Readonly<Record<MetricKey, number>>,
  month: Readonly<Record<MetricKey, number>>,
  limits: Readonly<Record<MetricKey, Limit>>,
  levels: readonly number[],
): LimitStatus[] {
  const out: LimitStatus[] = [];
  for (const metric of Object.keys(limits).sort()) {
    const { limit, period } = limits[metric] as Limit;
    const used = (period === "day" ? day : month)[metric] ?? 0;
    if (used <= 0) continue;
    out.push(toStatus(metric, used, limit, period, today, levels));
  }
  return out;
}

/** One reading against its limit: percentage, period key and highest level crossed. */
export function toStatus(
  metric: MetricKey,
  used: number,
  limit: number,
  period: Period,
  today: string,
  levels: readonly number[],
): LimitStatus {
  const pct = (used / limit) * 100;
  const crossed = levels.filter((l) => pct >= l);
  return {
    metric,
    used,
    limit,
    period,
    periodKey: period === "day" ? today : today.slice(0, 7),
    pct,
    level: crossed.length > 0 ? (crossed[crossed.length - 1] as number) : null,
  };
}

export function formatPct(pct: number): string {
  return pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
}

export function formatLimitLine(s: LimitStatus): string {
  if (s.note) return `• ${s.metric}: ${s.note}`;
  return `• ${s.metric}: ${s.used.toLocaleString("en-US")} of ${s.limit.toLocaleString("en-US")} per ${s.period} (${formatPct(s.pct)}) — past ${s.level}% of the free-plan limit`;
}
