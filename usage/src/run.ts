/**
 * Collect cycle and page model. Kept out of index.ts because workerd requires every named export of
 * the entry module to be a handler.
 *
 * runCollect(): pull yesterday + today from GraphQL Analytics → upsert into your D1 → spike check →
 *               optional webhook. Nothing here calls a Cloudflare write API.
 */
import type { Env } from "./env";
import { fetchUsage, toRows } from "./graphql";
import { formatMessage, notify } from "./notify";
import { renderPage } from "./page";
import { parseThresholds, spike } from "./spike";
import {
  buildSeries,
  filterUnnotified,
  loadTotals,
  markNotified,
  pivot,
  upsertRows,
} from "./store";

export const HISTORY_DAYS = 7;

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return isoDate(d);
}

export interface RunSummary {
  date: string;
  written: number;
  spikes: number;
  notified: number;
  error?: string;
}

/** One collect cycle. `now` and `fetchImpl` are injected for tests. */
export async function runCollect(
  env: Env,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<RunSummary> {
  const today = isoDate(now);
  const summary: RunSummary = { date: today, written: 0, spikes: 0, notified: 0 };
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
    summary.error = "CF_API_TOKEN / CF_ACCOUNT_ID not set";
    return summary;
  }
  try {
    const collectedAt = now.toISOString();
    // Yesterday again so the final hours of the previous UTC day land in the row.
    for (const date of [addDays(today, -1), today]) {
      const account = await fetchUsage(env.CF_API_TOKEN, env.CF_ACCOUNT_ID, date, fetchImpl);
      summary.written += await upsertRows(env.USAGE, toRows(date, account), collectedAt);
    }

    const totals = await loadTotals(env.USAGE, addDays(today, -HISTORY_DAYS), today);
    const series = buildSeries(totals, today);
    const spikes = spike(series.today, series.last7, parseThresholds(env.THRESHOLDS_JSON));
    summary.spikes = spikes.length;

    const fresh = await filterUnnotified(env.USAGE, today, spikes);
    if (fresh.length > 0) {
      const results = await notify(env, formatMessage(today, fresh), fetchImpl);
      summary.notified = results.filter((r) => r.ok).length;
      if (results.length > 0 && results.every((r) => r.ok)) {
        await markNotified(env.USAGE, today, fresh, collectedAt);
      }
    }
  } catch (e) {
    summary.error = e instanceof Error ? e.message : String(e);
  }
  return summary;
}

export async function renderIndex(env: Env, now: Date = new Date()): Promise<string> {
  const today = isoDate(now);
  const from = addDays(today, -(HISTORY_DAYS - 1));
  const totals = await loadTotals(env.USAGE, addDays(today, -HISTORY_DAYS), today);
  const series = buildSeries(totals, today);
  const spikes = spike(series.today, series.last7, parseThresholds(env.THRESHOLDS_JSON));
  const last = await env.USAGE.prepare("SELECT MAX(collected_at) AS t FROM usage_daily").first<{
    t: string | null;
  }>();
  const dates: string[] = [];
  for (let d = from; d <= today; d = addDays(d, 1)) dates.push(d);
  return renderPage({
    dates,
    table: pivot(totals.filter((r) => r.date >= from)),
    spikes,
    lastCollected: last?.t ?? null,
  });
}
