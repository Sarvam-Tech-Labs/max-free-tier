/**
 * When each kind of data on the site refreshes, so the Consumption tab can say how often and count down to the next one.
 * The two crons must match what scripts/sync.mjs generates into the Worker's triggers (a test checks), and `index.ts` routes
 * a scheduled run on them. All times are UTC; the page shows them in the viewer's zone.
 *
 *   COLLECT_CRON    hourly at :00   Cloudflare usage, plus the domain-expiry lookup when it is due (once a day)
 *   PROVIDERS_CRON  hourly at :30   GitHub, Vercel, Resend, Supabase (its own invocation: own subrequest budget)
 *   uptime          every minute    FlareWatch's engine; the site reads its latest state whenever it is opened
 */
import { DOMAIN_REFRESH_MS, type DomainRow } from "./health";
import type { CheckRun } from "./store";

export const COLLECT_CRON = "0 * * * *";
export const PROVIDERS_CRON = "30 * * * *";

const MINUTE = 60_000;

const minuteOf = (cron: string): number => Number(cron.split(" ")[0]);

/** The next time the clock reads `:minute` UTC, strictly after `from`. */
export function nextHourlyAt(minute: number, from: Date): Date {
  const d = new Date(from.getTime());
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(minute);
  if (d.getTime() <= from.getTime()) d.setUTCHours(d.getUTCHours() + 1);
  return d;
}

export function nextMinuteAt(from: Date): Date {
  return new Date((Math.floor(from.getTime() / MINUTE) + 1) * MINUTE);
}

/**
 * The next collect run that will look a domain up: a domain is due 24 hours after its last good lookup, or on the very next
 * run if the last lookup failed (health.ts), and lookups only happen inside the hourly collect.
 */
export function nextDomainLookup(rows: readonly DomainRow[], from: Date): Date {
  const due = rows.map((r) =>
    r.error !== null ? from.getTime() : Date.parse(r.checkedAt) + DOMAIN_REFRESH_MS,
  );
  const earliest = due.length > 0 ? Math.min(...due) : from.getTime();
  // The first collect run at or after the due time, and never one that has already passed.
  const t = new Date(Math.max(earliest, from.getTime() + 1));
  const atRun = t.getUTCMinutes() === minuteOf(COLLECT_CRON) && t.getUTCSeconds() === 0;
  return atRun && t.getUTCMilliseconds() === 0 ? t : nextHourlyAt(minuteOf(COLLECT_CRON), t);
}

export interface RefreshRow {
  key: "cloudflare" | "platforms" | "uptime" | "domains";
  label: string;
  /** "Every hour", "Every minute", "Daily" */
  every: string;
  /** ISO time of the last run, or null when it never ran (or the source is continuous). */
  lastAt: string | null;
  /** The last run finished with errors. */
  failed: boolean;
  /** What the last run reported (shown on hover). */
  note: string;
  /** ISO time of the next run. */
  nextAt: string;
  /** Re-runs every `period` ms: the countdown loops by itself instead of reloading the page. */
  period?: number;
}

export interface RefreshInput {
  runs: readonly CheckRun[];
  domains: readonly DomainRow[];
  now: Date;
  cloudflare: boolean;
  /** Platform names behind the cards on this page (GitHub, Vercel…). */
  platforms: readonly string[];
  sites: boolean;
  domainCount: number;
}

/** Only the rows that apply to what is on the page. */
export function refreshRows(i: RefreshInput): RefreshRow[] {
  const run = (name: string) => i.runs.find((r) => r.name === name);
  const rows: RefreshRow[] = [];
  if (i.cloudflare) {
    const r = run("collect");
    rows.push({
      key: "cloudflare",
      label: "Cloudflare usage",
      every: "Every hour",
      lastAt: r?.at ?? null,
      failed: r ? !r.ok : false,
      note: r?.summary ?? "",
      nextAt: nextHourlyAt(minuteOf(COLLECT_CRON), i.now).toISOString(),
    });
  }
  if (i.platforms.length > 0) {
    const r = run("providers");
    rows.push({
      key: "platforms",
      label: i.platforms.join(", "),
      every: "Every hour",
      lastAt: r?.at ?? null,
      failed: r ? !r.ok : false,
      note: r?.summary ?? "",
      nextAt: nextHourlyAt(minuteOf(PROVIDERS_CRON), i.now).toISOString(),
    });
  }
  if (i.sites) {
    rows.push({
      key: "uptime",
      label: "Site uptime",
      every: "Every minute",
      lastAt: null,
      failed: false,
      note: "Checked continuously; the site shows the latest state whenever it loads.",
      nextAt: nextMinuteAt(i.now).toISOString(),
      period: MINUTE,
    });
  }
  if (i.domainCount > 0) {
    const dates = i.domains.map((r) => Date.parse(r.checkedAt)).filter((n) => !Number.isNaN(n));
    rows.push({
      key: "domains",
      label: "Domain expiry",
      every: "Daily",
      lastAt: dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : null,
      failed: i.domains.some((r) => r.error !== null),
      note: i.domains.find((r) => r.error !== null)?.error ?? "",
      nextAt: nextDomainLookup(i.domains, i.now).toISOString(),
    });
  }
  return rows;
}
