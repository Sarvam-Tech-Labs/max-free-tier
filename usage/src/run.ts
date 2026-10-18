/**
 * Collect cycle and page model. Kept out of index.ts because workerd requires every named export of
 * the entry module to be a handler.
 *
 * runCollect(): for each watched account, pull yesterday + today from GraphQL Analytics → upsert into your
 *               D1 → spike check → (opt-in) free-plan limit check → one combined, optional notification.
 *               Nothing here calls a Cloudflare write API.
 */
import { withConnections } from "./connections";
import type { Env } from "./env";
import { fetchUsage, toRows } from "./graphql";
import { domainsOf, refreshDomains } from "./health";
import { type LimitStatus, limitStatus, parseLevels, parseLimits } from "./limits";
import { formatReport, notify, type ReportSection } from "./notify";
import { renderPage, type Section } from "./page";
import {
  checkTarget,
  KIND_LABEL,
  MISSING_TOKEN,
  type ProviderTarget,
  parseProviders,
  parseTokens,
  type TokenInfo,
} from "./providers";
import { parseThresholds, spike } from "./spike";
import {
  buildSeries,
  filterUnnotified,
  filterUnnotifiedLimits,
  loadTotals,
  logAlert,
  markLimitNotified,
  markNotified,
  pivot,
  recordRun,
  saveReadings,
  sumByMetric,
  upsertRows,
} from "./store";
import {
  loadManagedTokens,
  loadTargetStatus,
  saveTargetStatus,
  setReportedExpiry,
  type TargetStatusRow,
  targetKey,
  tokenAlerts,
} from "./tokens";
import { alertIfStale } from "./watchdog";

export const HISTORY_DAYS = 7;

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return isoDate(d);
}

/** "a, b ,a" → ["a", "b"]. Empty / missing → []. */
export function parseAccounts(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/** ACCOUNT_LABELS_JSON → { accountId: label }. Empty → {}. Invalid → throws. */
export function parseLabels(json: string | undefined): Record<string, string> {
  if (!json || json.trim() === "") return {};
  const parsed: unknown = JSON.parse(json);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((v) => typeof v !== "string")
  ) {
    throw new Error("ACCOUNT_LABELS_JSON must be a JSON object of account id → label");
  }
  return parsed as Record<string, string>;
}

/** Storage key: "" on a single-account deploy, so history written before multi-account support carries on. */
export function accountKey(accounts: readonly string[], id: string): string {
  return accounts.length === 1 ? "" : id;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Opt-in limit check for one account: today's totals for daily limits, month-to-date for monthly ones. */
async function checkLimits(env: Env, key: string, today: string): Promise<LimitStatus[]> {
  if (!env.LIMIT_LEVELS || env.LIMIT_LEVELS.trim() === "") return [];
  const limits = parseLimits(env.LIMITS_JSON);
  const levels = parseLevels(env.LIMIT_LEVELS);
  const day = sumByMetric(await loadTotals(env.USAGE, today, today, key));
  const month = sumByMetric(await loadTotals(env.USAGE, `${today.slice(0, 8)}01`, today, key));
  return limitStatus(today, day, month, limits, levels);
}

export interface RunSummary {
  date: string;
  written: number;
  spikes: number;
  notified: number;
  /** Limit levels currently crossed (only present when limit alerts are on and something crossed). */
  limitAlerts?: number;
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
  // The platform check runs half an hour after this one: if it has gone quiet, say so (whatever else this run does).
  const errors: string[] = await alertIfStale(
    env,
    now,
    fetchImpl,
    "providers",
    "platform check (GitHub, Vercel, Resend, Supabase)",
  );
  const accounts = parseAccounts(env.CF_ACCOUNT_ID);
  if (!env.CF_API_TOKEN || accounts.length === 0) {
    // Recorded, so the site shows the misconfiguration instead of "not run yet".
    return finish(
      env,
      "collect",
      summary,
      ["CF_API_TOKEN / CF_ACCOUNT_ID not set", ...errors],
      now.toISOString(),
    );
  }
  let labels: Record<string, string> = {};
  try {
    labels = parseLabels(env.ACCOUNT_LABELS_JSON);
  } catch (e) {
    errors.push(message(e));
  }
  const multi = accounts.length > 1;
  const collectedAt = now.toISOString();
  const sections: Array<ReportSection & { key: string }> = [];

  // One account failing (revoked membership, GraphQL error) must not stop the others.
  for (const id of accounts) {
    const key = accountKey(accounts, id);
    const label = multi ? (labels[id] ?? id) : undefined;
    try {
      // Yesterday again so the final hours of the previous UTC day land in the row.
      for (const date of [addDays(today, -1), today]) {
        const account = await fetchUsage(env.CF_API_TOKEN, id, date, fetchImpl);
        summary.written += await upsertRows(env.USAGE, toRows(date, account), collectedAt, key);
      }

      const totals = await loadTotals(env.USAGE, addDays(today, -HISTORY_DAYS), today, key);
      const series = buildSeries(totals, today);
      const spikes = spike(series.today, series.last7, parseThresholds(env.THRESHOLDS_JSON));
      summary.spikes += spikes.length;

      const limits = await checkLimits(env, key, today);
      const crossed = limits.filter((l) => l.level !== null).length;
      if (crossed > 0) summary.limitAlerts = (summary.limitAlerts ?? 0) + crossed;

      const freshSpikes = await filterUnnotified(env.USAGE, today, spikes, key);
      const freshLimits = await filterUnnotifiedLimits(env.USAGE, key, limits);
      if (freshSpikes.length > 0 || freshLimits.length > 0) {
        sections.push({
          key,
          ...(label ? { label } : {}),
          spikes: freshSpikes,
          limits: freshLimits,
        });
      }
    } catch (e) {
      errors.push(label ? `${label}: ${message(e)}` : message(e));
    }
  }

  if (sections.length > 0) {
    try {
      const text = formatReport(today, sections);
      const results = await notify(env, text, fetchImpl);
      summary.notified = results.filter((r) => r.ok).length;
      const delivered = results.length > 0 && results.every((r) => r.ok);
      await logAlert(env.USAGE, "usage", logText(text, results.length, delivered), collectedAt);
      if (delivered) {
        for (const s of sections) {
          await markNotified(env.USAGE, today, s.spikes, collectedAt, s.key);
          await markLimitNotified(env.USAGE, s.key, s.limits, collectedAt);
        }
      }
    } catch (e) {
      errors.push(message(e));
    }
  }

  // Domain expiry for the site (once a day per domain). A lookup failure is reported, never fatal.
  try {
    for (const e of await refreshDomains(env.USAGE, domainsOf(env.CLIENTS_JSON), now, fetchImpl))
      errors.push(e);
  } catch (e) {
    errors.push(`domain lookups: ${message(e)}`);
  }

  return finish(env, "collect", summary, errors, collectedAt);
}

/** What the activity log keeps for one alert message: the text, plus why it may not have reached anyone. */
function logText(text: string, channels: number, delivered: boolean): string {
  if (channels === 0) return `${text}\n(no alert channel configured)`;
  return delivered ? text : `${text}\n(delivery failed; retried next run)`;
}

/** Record the run for the site ("checked N minutes ago") and set the summary's error. Never throws. */
async function finish(
  env: Env,
  name: string,
  summary: RunSummary,
  errors: string[],
  at: string,
): Promise<RunSummary> {
  const line = (s: RunSummary) =>
    s.error ??
    (name === "collect"
      ? `${s.written} rows, ${s.spikes} spike(s), ${s.limitAlerts ?? 0} limit level(s) crossed`
      : `${s.limitAlerts ?? 0} limit level(s) crossed`);
  if (errors.length > 0) summary.error = errors.join("; ");
  try {
    await recordRun(env.USAGE, name, !summary.error, line(summary), at);
  } catch (e) {
    summary.error = [summary.error, `recording the run: ${message(e)}`].filter(Boolean).join("; ");
  }
  return summary;
}

/** Cron that runs the other-platform checks; its own invocation, so it gets its own 50-subrequest budget. */
export { PROVIDERS_CRON } from "./refresh";

/**
 * Other-platform checks (providers.ts): GitHub, Resend, Supabase, Vercel. Same alert levels, de-duplication and
 * channels as the Cloudflare limits. One target failing never stops the others.
 * shortcut: ~1-3 subrequests per target, all in one invocation (free-plan cap 50) → about 15 clients' worth; split
 * PROVIDERS_JSON across more crons past that.
 */
export async function runProviders(
  rawEnv: Env,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<RunSummary> {
  const env = await withConnections(rawEnv); // the registry's targets plus those connected on the site
  const today = isoDate(now);
  const summary: RunSummary = { date: today, written: 0, spikes: 0, notified: 0 };
  const errors: string[] = [];
  let targets: ProviderTarget[] = [];
  let tokens: Record<string, string> = {};
  let levels: number[] = [];
  try {
    targets = parseProviders(env.PROVIDERS_JSON);
    tokens = parseTokens(env.PROVIDER_TOKENS);
    levels = parseLevels(env.LIMIT_LEVELS?.trim() || "50,80,95");
  } catch (e) {
    return finish(env, "providers", summary, [message(e)], now.toISOString());
  }
  // Tokens pasted into the site win over the deployment secret of the same name.
  try {
    const managed = await loadManagedTokens(env);
    tokens = { ...tokens, ...managed.tokens };
    errors.push(...managed.errors);
  } catch (e) {
    errors.push(`saved tokens: ${message(e)}`);
  }

  const collectedAt = now.toISOString();
  errors.push(...(await alertIfStale(env, now, fetchImpl, "collect", "Cloudflare usage check")));
  // A token that was failing and had been alerted about: if it works now, say so once.
  const before = new Map<string, TargetStatusRow>();
  try {
    for (const s of await loadTargetStatus(env.USAGE)) before.set(s.target, s);
  } catch {
    // no table yet: nothing to recover from
  }
  const recovered: string[] = [];
  const sections: Array<ReportSection & { key: string }> = [];
  for (const t of targets) {
    const label = `${t.client} · ${KIND_LABEL[t.kind]}`;
    const key = targetKey(t);
    const info: TokenInfo = {};
    try {
      const statuses = await checkTarget(t, tokens, now, levels, fetchImpl, info);
      const crossed = statuses.filter((s) => s.level !== null).length;
      if (crossed > 0) summary.limitAlerts = (summary.limitAlerts ?? 0) + crossed;
      await saveReadings(env.USAGE, key, statuses, collectedAt); // for the site
      const prev = before.get(key);
      if (prev && !prev.ok && prev.alertedAt !== null)
        recovered.push(`• ${t.token} (${label}) is working again`);
      await saveTargetStatus(env.USAGE, key, t.token, true, null, collectedAt);
      if (info.expiresAt) await setReportedExpiry(env.USAGE, t.token, info.expiresAt);
      const fresh = await filterUnnotifiedLimits(env.USAGE, key, statuses);
      if (fresh.length > 0) sections.push({ key, label, spikes: [], limits: fresh });
    } catch (e) {
      // A token that was never added is "not connected", not a failing token: no alert, and not an error of the run
      // either (the Tokens page already says "Missing", and a run that shows "had errors" for it would cry wolf).
      if (!message(e).includes(MISSING_TOKEN)) {
        errors.push(`${label}: ${message(e)}`);
        await saveTargetStatus(env.USAGE, key, t.token, false, message(e), collectedAt).catch(
          () => {},
        );
      }
    }
  }
  errors.push(...(await tokenAlerts(env, now, fetchImpl, recovered)));

  if (sections.length > 0) {
    try {
      const text = formatReport(today, sections);
      const results = await notify(env, text, fetchImpl);
      summary.notified = results.filter((r) => r.ok).length;
      const delivered = results.length > 0 && results.every((r) => r.ok);
      await logAlert(env.USAGE, "providers", logText(text, results.length, delivered), collectedAt);
      if (delivered) {
        for (const s of sections) await markLimitNotified(env.USAGE, s.key, s.limits, collectedAt);
      }
    } catch (e) {
      errors.push(message(e));
    }
  }

  return finish(env, "providers", summary, errors, collectedAt);
}

export async function renderIndex(env: Env, now: Date = new Date()): Promise<string> {
  const today = isoDate(now);
  const from = addDays(today, -(HISTORY_DAYS - 1));
  const accounts = parseAccounts(env.CF_ACCOUNT_ID);
  let labels: Record<string, string> = {};
  try {
    labels = parseLabels(env.ACCOUNT_LABELS_JSON);
  } catch {
    // A bad label map only costs the page its labels; the run log reports it.
  }
  const thresholds = parseThresholds(env.THRESHOLDS_JSON);
  const ids = accounts.length > 1 ? accounts : [accounts[0] ?? ""];

  const sections: Section[] = [];
  for (const id of ids) {
    const key = accountKey(ids, id);
    const totals = await loadTotals(env.USAGE, addDays(today, -HISTORY_DAYS), today, key);
    const series = buildSeries(totals, today);
    sections.push({
      ...(ids.length > 1 ? { label: labels[id] ?? id } : {}),
      table: pivot(totals.filter((r) => r.date >= from)),
      spikes: spike(series.today, series.last7, thresholds),
      limits: await checkLimits(env, key, today),
    });
  }

  const last = await env.USAGE.prepare("SELECT MAX(collected_at) AS t FROM usage_daily").first<{
    t: string | null;
  }>();
  const dates: string[] = [];
  for (let d = from; d <= today; d = addDays(d, 1)) dates.push(d);
  const lastCollected = last?.t ?? null;
  return sections.length === 1
    ? renderPage({ dates, lastCollected, ...(sections[0] as Section) })
    : renderPage({ dates, lastCollected, table: new Map(), spikes: [], sections });
}
