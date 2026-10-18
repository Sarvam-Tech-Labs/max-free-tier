/**
 * Free-plan checks for platforms other than Cloudflare: GitHub Actions minutes, Resend quotas, Supabase database /
 * storage size + project status, Vercel blocks. Each check is one or two read-only API calls returning the current
 * reading, so nothing is stored except which alert levels were already posted.
 *
 * Endpoints, token scopes and the Free-plan gaps come from free-tier-maxxer's live-verified research
 * (https://github.com/alemalvarez/free-tier-maxxer, MIT, feasibility/ — verified 2026-10-11 / 2026-10-16).
 * Not covered, because the platforms only show them in their logged-in dashboards: Vercel bandwidth / requests /
 * invocations, Supabase egress / realtime / edge invocations.
 */
import { type LimitStatus, toStatus } from "./limits";

export type ProviderKind = "github" | "resend" | "supabase" | "vercel";

/** One platform account of one client, from PROVIDERS_JSON (generated from the registry). No secrets in here. */
export interface ProviderTarget {
  /** Client id from the registry; with `kind` it keys the "already alerted" rows. */
  id: string;
  /** Client name, shown in the alert. */
  client: string;
  kind: ProviderKind;
  /** Key of this target's token inside the PROVIDER_TOKENS secret. */
  token: string;
  /** github: user or organization login. vercel: team id (team_…) or slug. */
  account?: string;
  /** github: `account` is an organization. */
  org?: boolean;
  /** supabase: project refs to watch. */
  projects?: string[];
}

export const KINDS: readonly ProviderKind[] = ["github", "resend", "supabase", "vercel"];

/**
 * Included amounts the APIs do not return (Resend returns its own limits).
 *   GitHub Actions  https://docs.github.com/en/billing/concepts/product-billing/github-actions (Free: 2,000 min/month, private repos)
 *   Supabase        https://supabase.com/pricing (Free: 500 MB database → read-only mode above it, 1 GB file storage)
 * Decimal units on purpose: alerts fire slightly early rather than late.
 */
export const PROVIDER_LIMITS = {
  githubActionsMinutes: 2_000,
  supabaseDbBytes: 500e6,
  supabaseStorageBytes: 1e9,
} as const;

const GITHUB_API = "https://api.github.com";
const RESEND_API = "https://api.resend.com";
const SUPABASE_API = "https://api.supabase.com";
const VERCEL_API = "https://api.vercel.com";

/** PROVIDERS_JSON → targets. Empty → []. Invalid → throws (shows up in the run log). */
export function parseProviders(json: string | undefined): ProviderTarget[] {
  if (!json || json.trim() === "") return [];
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("PROVIDERS_JSON must be a JSON array");
  for (const t of parsed as ProviderTarget[]) {
    if (!t?.id || !t.client || !t.token || !KINDS.includes(t.kind)) {
      throw new Error(
        `PROVIDERS_JSON: each entry needs id, client, token and kind (${KINDS.join(" | ")})`,
      );
    }
    if ((t.kind === "github" || t.kind === "vercel") && !t.account) {
      throw new Error(`PROVIDERS_JSON: ${t.id} ${t.kind} needs account`);
    }
    if (t.kind === "supabase" && !(Array.isArray(t.projects) && t.projects.length > 0)) {
      throw new Error(`PROVIDERS_JSON: ${t.id} supabase needs projects`);
    }
  }
  return parsed as ProviderTarget[];
}

/** PROVIDER_TOKENS secret → { key: token }. Empty → {}. Invalid → throws. */
export function parseTokens(json: string | undefined): Record<string, string> {
  if (!json || json.trim() === "") return {};
  const parsed: unknown = JSON.parse(json);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((v) => typeof v !== "string")
  ) {
    throw new Error("PROVIDER_TOKENS must be a JSON object of key → token");
  }
  return parsed as Record<string, string>;
}

/** GET/POST JSON; a non-2xx throws with the label and status only (never the URL or token). */
async function json<T>(
  label: string,
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<T> {
  const res = await fetchImpl(url, init);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** A state problem as a status: always "crossed", re-alerted once per day while it lasts. */
function problem(metric: string, note: string, today: string): LimitStatus {
  return { metric, used: 1, limit: 1, period: "day", periodKey: today, pct: 100, level: 100, note };
}

interface GitHubSummary {
  usageItems?: Array<{ product?: string; unitType?: string; grossQuantity?: number }>;
}

/**
 * Actions minutes this UTC calendar month. Token: fine-grained PAT owned by the account, user permission
 * "Plan: read" (organizations: "Administration: read"). SKUs that were not used are absent, so absent = 0.
 * shortcut: Windows / macOS minutes are counted 1:1 like Linux, while GitHub may burn the allowance faster for them;
 * add per-SKU weights if a client runs non-Linux jobs.
 */
async function github(
  t: ProviderTarget,
  token: string,
  now: Date,
  levels: readonly number[],
  f: typeof fetch,
) {
  const today = now.toISOString().slice(0, 10);
  const owner = `${t.org ? "organizations" : "users"}/${encodeURIComponent(t.account as string)}`;
  const q = `year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`;
  const body = await json<GitHubSummary>(
    "github",
    `${GITHUB_API}/${owner}/settings/billing/usage/summary?${q}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "max-free-tier", // GitHub rejects requests without one
      },
    },
    f,
  );
  const minutes = (body.usageItems ?? [])
    .filter((i) => /actions/i.test(i.product ?? "") && /minute/i.test(i.unitType ?? ""))
    .reduce((a, i) => a + (i.grossQuantity ?? 0), 0);
  if (minutes <= 0) return [];
  return [
    toStatus(
      "github.actions_minutes",
      minutes,
      PROVIDER_LIMITS.githubActionsMinutes,
      "month",
      today,
      levels,
    ),
  ];
}

interface Quota {
  used?: number;
  limit?: number | null;
}
type ResendUsage = { object?: string; emails?: { daily?: Quota; monthly?: Quota } } & Record<
  string,
  unknown
>;

/**
 * Every Resend quota with its own limit, one call (GET /usage, since 2026-10-01). Resend has no read-only key: it needs a
 * full-access key, so create one just for this and revoke it any time. `limit: null` = uncapped, skipped.
 */
async function resend(
  _t: ProviderTarget,
  token: string,
  now: Date,
  levels: readonly number[],
  f: typeof fetch,
) {
  const today = now.toISOString().slice(0, 10);
  const u = await json<ResendUsage>(
    "resend",
    `${RESEND_API}/usage`,
    { headers: { Authorization: `Bearer ${token}` } },
    f,
  );
  if (u.object !== "usage") throw new Error("resend: unexpected /usage response");
  const quotas: Array<[string, Quota | undefined, "day" | "month"]> = [
    ["resend.emails_daily", u.emails?.daily, "day"],
    ["resend.emails_monthly", u.emails?.monthly, "month"],
  ];
  for (const [k, v] of Object.entries(u)) {
    if (k !== "emails" && typeof v === "object" && v !== null && "used" in v)
      quotas.push([`resend.${k}`, v as Quota, "month"]);
  }
  return quotas
    .filter(([, q]) => typeof q?.limit === "number" && q.limit > 0 && (q.used ?? 0) > 0)
    .map(([m, q, p]) => toStatus(m, q?.used as number, q?.limit as number, p, today, levels))
    .sort((a, b) => a.metric.localeCompare(b.metric));
}

interface SupabaseProject {
  ref: string;
  name?: string;
  status?: string;
}

/**
 * Per watched project: status (paused / unhealthy alerts daily) and, when healthy, database + file storage size via
 * read-only SQL. Token: scoped PAT with projects_read + database_read (one token can cover every org you belong to).
 */
async function supabase(
  t: ProviderTarget,
  token: string,
  now: Date,
  levels: readonly number[],
  f: typeof fetch,
) {
  const today = now.toISOString().slice(0, 10);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const list = await json<SupabaseProject[]>(
    "supabase projects",
    `${SUPABASE_API}/v1/projects`,
    { headers },
    f,
  );
  const out: LimitStatus[] = [];
  for (const ref of t.projects ?? []) {
    const p = list.find((x) => x.ref === ref);
    const name = p?.name ? `${p.name} (${ref})` : ref;
    if (!p) {
      out.push(
        problem(
          `supabase.${ref}.status`,
          `project ${ref} not visible to the token (deleted, or token scope)`,
          today,
        ),
      );
      continue;
    }
    if (p.status === "INACTIVE") {
      out.push(
        problem(
          `supabase.${ref}.status`,
          `${name} is PAUSED — Free projects pause after 7 days without activity; restore it in the dashboard`,
          today,
        ),
      );
      continue;
    }
    if (p.status !== "ACTIVE_HEALTHY") {
      out.push(problem(`supabase.${ref}.status`, `${name} is ${p.status ?? "UNKNOWN"}`, today));
      continue;
    }
    const rows = await json<Array<{ db?: number | string; storage?: number | string }>>(
      `supabase ${ref} sql`,
      `${SUPABASE_API}/v1/projects/${encodeURIComponent(ref)}/database/query`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          query:
            "select pg_database_size(current_database()) as db, (select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects) as storage",
          read_only: true,
        }),
      },
      f,
    );
    const db = Number(rows[0]?.db ?? 0);
    const storage = Number(rows[0]?.storage ?? 0);
    // Sizes are levels, not monthly totals: "month" just makes each level re-alert once a month while it lasts.
    if (db > 0)
      out.push(
        toStatus(
          `supabase.${ref}.db_bytes`,
          db,
          PROVIDER_LIMITS.supabaseDbBytes,
          "month",
          today,
          levels,
        ),
      );
    if (storage > 0)
      out.push(
        toStatus(
          `supabase.${ref}.storage_bytes`,
          storage,
          PROVIDER_LIMITS.supabaseStorageBytes,
          "month",
          today,
          levels,
        ),
      );
  }
  return out;
}

/**
 * Vercel Hobby has no usage API (its charges endpoint 404s on Hobby), but the team record says when Vercel has
 * blocked the account for going over. Token: team-scoped access token.
 */
async function vercel(
  t: ProviderTarget,
  token: string,
  now: Date,
  _levels: readonly number[],
  f: typeof fetch,
) {
  const today = now.toISOString().slice(0, 10);
  const team = await json<{ softBlock?: { reason?: string } | null }>(
    "vercel",
    `${VERCEL_API}/v2/teams/${encodeURIComponent(t.account as string)}`,
    { headers: { Authorization: `Bearer ${token}` } },
    f,
  );
  if (!team.softBlock) return [];
  return [
    problem(
      "vercel.blocked",
      `account BLOCKED by Vercel (${team.softBlock.reason ?? "see the dashboard"})`,
      today,
    ),
  ];
}

const CHECKS = { github, resend, supabase, vercel };

/** All readings for one target. Throws on a missing token or a failed call; the caller isolates targets. */
export function checkTarget(
  t: ProviderTarget,
  tokens: Readonly<Record<string, string>>,
  now: Date,
  levels: readonly number[],
  fetchImpl: typeof fetch,
): Promise<LimitStatus[]> {
  const token = tokens[t.token];
  if (!token) return Promise.reject(new Error(`token ${t.token} missing from PROVIDER_TOKENS`));
  return CHECKS[t.kind](t, token, now, levels, fetchImpl);
}

export const KIND_LABEL: Readonly<Record<ProviderKind, string>> = {
  github: "GitHub",
  resend: "Resend",
  supabase: "Supabase",
  vercel: "Vercel",
};
