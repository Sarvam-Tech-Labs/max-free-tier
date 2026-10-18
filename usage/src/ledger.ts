/**
 * The overview page's data: every client × platform meter against its free limit, in the shape free-tier-maxxer's
 * dashboard reads (https://github.com/alemalvarez/free-tier-maxxer, MIT; public/index.html is adapted from it).
 * Cloudflare meters come from usage_daily (with a 30-day series for projections); other platforms from the latest
 * stored reading (provider_readings). Pure data: no HTML here.
 */
import type { Env } from "./env";
import { FREE_PLAN_LIMITS, type Limit, parseLimits } from "./limits";
import { KIND_LABEL, type ProviderKind, type ProviderTarget, parseProviders } from "./providers";
import { accountKey, addDays, isoDate, parseAccounts, parseLabels } from "./run";
import { loadReadings, loadTotals, type ReadingRow, sumByMetric } from "./store";

export interface Period {
  start: string;
  end: string;
  anchor: "api";
}

export interface Meter {
  key: string;
  label: string;
  used: number;
  limit: number;
  unit: "count" | "bytes" | "minutes";
  resets: boolean;
  period?: Period;
  confidence?: string;
  note?: string;
}

export type Platform = ProviderKind | "cloudflare";

/** One client of the registry (CLIENTS_JSON). `email` identifies the client on the by-client page. */
export interface ClientInfo {
  id: string;
  name: string;
  email?: string;
  status: string;
  platforms: string[];
  /** Cloudflare account ids of this client. */
  accounts: string[];
}

export interface LedgerProvider {
  id: string;
  /** Which platform this card measures, and which client it belongs to (absent for an account not in the registry). */
  platform: Platform;
  clientId?: string;
  name: string;
  account: string;
  plan: string;
  source: "official";
  auth: string;
  period: Period;
  status?: { label: string; value: string };
  metrics: Meter[];
}

export interface SeriesPoint {
  provider: string;
  metric: string;
  date: string;
  value: number;
  kind: "delta";
}

export interface Ledger {
  data: {
    generatedAt: string;
    project: string;
    providers: LedgerProvider[];
    clients: ClientInfo[];
  };
  series: SeriesPoint[];
}

/** A reading older than this is shown with a "latest check failed" note: the hourly check normally refreshes it. */
export const STALE_AFTER_MS = 3 * 3_600_000;

const CF_LABELS: Readonly<Record<string, string>> = {
  "workers.requests": "Workers requests (per day)",
  "d1.rows_read": "D1 rows read (per day)",
  "d1.rows_written": "D1 rows written (per day)",
  "do.requests": "Durable Object requests (per day)",
  "kv.read": "KV reads (per day)",
  "kv.write": "KV writes (per day)",
  "kv.delete": "KV deletes (per day)",
  "kv.list": "KV lists (per day)",
  "queues.operations": "Queue operations (per day)",
  "r2.class_a": "R2 Class A operations (per month)",
  "r2.class_b": "R2 Class B operations (per month)",
};

const RESEND_LABELS: Readonly<Record<string, string>> = {
  "resend.emails_daily": "Emails (per day)",
  "resend.emails_monthly": "Emails (per month)",
};

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function labelFor(metric: string): string {
  const sb = /^supabase\.([^.]+)\.(db_bytes|storage_bytes)$/.exec(metric);
  if (sb) return `${sb[2] === "db_bytes" ? "Database size" : "File storage"} · ${sb[1]}`;
  if (metric === "github.actions_minutes") return "Actions minutes (private repos, per month)";
  const known = CF_LABELS[metric] ?? RESEND_LABELS[metric];
  if (known) return known;
  return capitalise((metric.split(".").pop() ?? metric).replace(/_/g, " "));
}

function dayPeriod(today: string): Period {
  return {
    start: `${today}T00:00:00.000Z`,
    end: `${addDays(today, 1)}T00:00:00.000Z`,
    anchor: "api",
  };
}

function monthPeriod(today: string): Period {
  const first = `${today.slice(0, 8)}01`;
  const next = new Date(`${first}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { start: `${first}T00:00:00.000Z`, end: next.toISOString(), anchor: "api" };
}

function safeLimits(json: string | undefined): Record<string, Limit> {
  try {
    return parseLimits(json);
  } catch {
    return { ...FREE_PLAN_LIMITS }; // a bad LIMITS_JSON is reported by the collect run; the page keeps working
  }
}

function safeTargets(json: string | undefined): ProviderTarget[] {
  try {
    return parseProviders(json);
  } catch {
    return [];
  }
}

function safeLabels(json: string | undefined): Record<string, string> {
  try {
    return parseLabels(json);
  } catch {
    return {};
  }
}

/** CLIENTS_JSON → clients. Missing or invalid → [] (the by-client page then groups what it can). */
export function parseClients(json: string | undefined): ClientInfo[] {
  try {
    const parsed: unknown = JSON.parse(json || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c): c is ClientInfo => typeof c?.id === "string" && typeof c?.name === "string")
      .map((c) => ({
        ...c,
        platforms: Array.isArray(c.platforms) ? c.platforms : [],
        accounts: Array.isArray(c.accounts) ? c.accounts : [],
        status: typeof c.status === "string" ? c.status : "live",
      }));
  } catch {
    return [];
  }
}

async function cloudflareProviders(
  env: Env,
  today: string,
  clients: readonly ClientInfo[],
): Promise<{ providers: LedgerProvider[]; series: SeriesPoint[] }> {
  const accounts = parseAccounts(env.CF_ACCOUNT_ID);
  const labels = safeLabels(env.ACCOUNT_LABELS_JSON);
  const limits = safeLimits(env.LIMITS_JSON);
  const monthStart = `${today.slice(0, 8)}01`;
  const day = dayPeriod(today);
  const month = monthPeriod(today);
  const providers: LedgerProvider[] = [];
  const series: SeriesPoint[] = [];

  for (const id of accounts) {
    const totals = await loadTotals(
      env.USAGE,
      addDays(today, -30),
      today,
      accountKey(accounts, id),
    );
    const todayTotals = sumByMetric(totals.filter((r) => r.date === today));
    const monthTotals = sumByMetric(totals.filter((r) => r.date >= monthStart));
    const pid = `cloudflare-${id.slice(0, 8)}`;
    const metrics = Object.keys(limits)
      .sort()
      .map((metric): Meter => {
        const { limit, period } = limits[metric] as Limit;
        return {
          key: metric,
          label: CF_LABELS[metric] ?? labelFor(metric),
          used: (period === "day" ? todayTotals : monthTotals)[metric] ?? 0,
          limit,
          unit: "count",
          resets: true,
          period: period === "day" ? day : month,
          confidence: "exact",
        };
      });
    const known = new Set(Object.keys(limits));
    for (const r of totals) {
      if (known.has(r.metric)) {
        series.push({
          provider: pid,
          metric: r.metric,
          date: r.date,
          value: r.value,
          kind: "delta",
        });
      }
    }
    const owner = clients.find((c) => c.accounts.includes(id));
    const ownerName = owner?.name ?? labels[id];
    providers.push({
      id: pid,
      platform: "cloudflare",
      ...(owner ? { clientId: owner.id } : {}),
      name: ownerName ? `${ownerName} · Cloudflare` : "Cloudflare",
      account: id,
      plan: "Workers Free",
      source: "official",
      auth: "read-only token, Account Analytics: Read",
      period: month,
      metrics,
    });
  }
  return { providers, series };
}

function unitFor(metric: string): Meter["unit"] {
  if (metric.endsWith("_bytes")) return "bytes";
  return metric === "github.actions_minutes" ? "minutes" : "count";
}

function targetProvider(
  t: ProviderTarget,
  rows: readonly ReadingRow[],
  now: Date,
  today: string,
): LedgerProvider | null {
  if (rows.length === 0) return null; // no successful check yet
  const month = monthPeriod(today);
  const day = dayPeriod(today);
  const notes = rows.filter((r) => r.note !== null).map((r) => r.note as string);
  const metrics = rows
    .filter((r) => r.note === null)
    .map((r): Meter => {
      const size = r.metric.endsWith("_bytes");
      const stale = now.getTime() - Date.parse(r.checkedAt) > STALE_AFTER_MS;
      return {
        key: r.metric,
        label: labelFor(r.metric),
        used: r.used,
        limit: r.limit,
        unit: unitFor(r.metric),
        resets: !size,
        ...(size ? {} : { period: r.period === "day" ? day : month }),
        ...(t.kind === "supabase" ? { confidence: "approximate" } : {}),
        ...(stale ? { note: `Last successful check ${r.checkedAt}; the latest check failed` } : {}),
      };
    });
  return {
    id: `${t.kind}-${t.id}`,
    platform: t.kind,
    clientId: t.id,
    name: `${t.client} · ${KIND_LABEL[t.kind]}`,
    account: t.account ?? t.projects?.join(", ") ?? "team",
    plan: "Free",
    source: "official",
    auth:
      t.kind === "resend" ? "full-access API key (Resend has no read-only key)" : "read-only token",
    period: month,
    ...(notes.length > 0 ? { status: { label: "Alert", value: notes.join("; ") } } : {}),
    metrics,
  };
}

export async function buildLedger(env: Env, now: Date = new Date()): Promise<Ledger> {
  const today = isoDate(now);
  const clients = parseClients(env.CLIENTS_JSON);
  const cf = await cloudflareProviders(env, today, clients);
  const readings = await loadReadings(env.USAGE);
  const others = safeTargets(env.PROVIDERS_JSON)
    .map((t) =>
      targetProvider(
        t,
        readings.filter((r) => r.target === `${t.kind}:${t.id}`),
        now,
        today,
      ),
    )
    .filter((p): p is LedgerProvider => p !== null);
  return {
    data: {
      generatedAt: now.toISOString(),
      project: env.ORG_NAME?.trim() || "max-free-tier",
      providers: [...cf.providers, ...others],
      clients,
    },
    series: cf.series,
  };
}

export const dataJs = (l: Ledger): string => `window.FTM_DATA = ${JSON.stringify(l.data)};\n`;
export const seriesJs = (l: Ledger): string => `window.FTM_SERIES = ${JSON.stringify(l.series)};\n`;
