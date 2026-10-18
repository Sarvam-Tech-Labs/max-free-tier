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
  githubPackagesTransferBytes: 1e9,
  githubCodespacesCoreHours: 120,
  supabaseDbBytes: 500e6,
  supabaseStorageBytes: 1e9,
} as const;

export const GITHUB_API = "https://api.github.com";
const RESEND_API = "https://api.resend.com";
export const SUPABASE_API = "https://api.supabase.com";
export const VERCEL_API = "https://api.vercel.com";

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

interface GitHubItem {
  product?: string;
  sku?: string;
  unitType?: string;
  grossQuantity?: number;
}
interface GitHubSummary {
  usageItems?: GitHubItem[];
}

const sum = (items: readonly GitHubItem[], pick: (i: GitHubItem) => number) =>
  items.reduce((a, i) => a + pick(i), 0);
const qty = (i: GitHubItem) => i.grossQuantity ?? 0;
const isStorage = (i: GitHubItem) =>
  /storage/i.test(i.sku ?? "") || /(gigabyte|gb).?(hour|month)/i.test(i.unitType ?? "");

/**
 * Packages data transfer (GB) this month, in bytes. GitHub leaves a product out of the report until it is used, so none
 * = 0. Storage items share the product and are not transfer. null when an item here is not something we can read: better
 * no number than a false zero.
 */
function packagesTransferBytes(items: readonly GitHubItem[]): number | null {
  const mine = items.filter((i) => /packages/i.test(i.product ?? "") && !isStorage(i));
  const gigabytes = mine.filter((i) => /^(gb|gigabytes?)$/i.test(i.unitType ?? ""));
  return gigabytes.length === mine.length ? sum(gigabytes, qty) * 1e9 : null;
}

/**
 * Codespaces compute in core-hours. A unit saying "core-hours" is taken as is; plain "hours" is scaled by the core count
 * in the SKU name ("…_4_core"). null if an item cannot be read either way.
 */
function codespacesCoreHours(items: readonly GitHubItem[]): number | null {
  const mine = items.filter((i) => /codespaces/i.test(i.product ?? "") && !isStorage(i));
  let total = 0;
  for (const i of mine) {
    const unit = i.unitType ?? "";
    const cores = /(\d+)[-_ ]?core/i.exec(i.sku ?? "")?.[1];
    if (/core.?hour/i.test(unit)) total += qty(i);
    else if (/hour/i.test(unit) && cores) total += qty(i) * Number(cores);
    else return null;
  }
  return total;
}

/**
 * Actions minutes this UTC calendar month. Token: fine-grained PAT owned by the account, user permission
 * "Plan: read" (organizations: "Administration: read"). SKUs that were not used are absent, so absent = 0. The same
 * response carries Packages transfer and Codespaces; Actions storage and the per-repository cache are not measured here.
 * shortcut: Windows / macOS minutes are counted 1:1 like Linux, while GitHub may burn the allowance faster for them;
 * add per-SKU weights if a client runs non-Linux jobs.
 */
async function github(
  t: ProviderTarget,
  token: string,
  now: Date,
  levels: readonly number[],
  f: typeof fetch,
  info?: TokenInfo,
) {
  const today = now.toISOString().slice(0, 10);
  const owner = `${t.org ? "organizations" : "users"}/${encodeURIComponent(t.account as string)}`;
  const q = `year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`;
  const res = await f(`${GITHUB_API}/${owner}/settings/billing/usage/summary?${q}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "max-free-tier", // GitHub rejects requests without one
    },
  });
  if (!res.ok) throw new Error(`github: HTTP ${res.status}`);
  // Fine-grained tokens say when they expire ("2026-11-17 11:07:28 UTC"): worth a warning before they silently stop.
  const exp = res.headers.get("github-authentication-token-expiration");
  const expMs = exp ? Date.parse(exp.replace(" UTC", "Z").replace(" ", "T")) : Number.NaN;
  if (info && !Number.isNaN(expMs)) info.expiresAt = new Date(expMs).toISOString();
  const body = (await res.json()) as GitHubSummary;
  const items = body.usageItems ?? [];
  const minutes = sum(
    items.filter((i) => /actions/i.test(i.product ?? "") && /minute/i.test(i.unitType ?? "")),
    qty,
  );
  const readings = [
    toStatus(
      "github.actions_minutes",
      minutes,
      PROVIDER_LIMITS.githubActionsMinutes,
      "month",
      today,
      levels,
    ),
  ];
  const transfer = packagesTransferBytes(items);
  if (transfer !== null)
    readings.push(
      toStatus(
        "github.packages_transfer_bytes",
        transfer,
        PROVIDER_LIMITS.githubPackagesTransferBytes,
        "month",
        today,
        levels,
      ),
    );
  const coreHours = codespacesCoreHours(items);
  if (coreHours !== null)
    readings.push(
      toStatus(
        "github.codespaces_core_hours",
        coreHours,
        PROVIDER_LIMITS.githubCodespacesCoreHours,
        "month",
        today,
        levels,
      ),
    );
  return readings;
}

interface Quota {
  used?: number;
  limit?: number | null;
  /** Resend: when this quota resets (emails, automation runs) or, for AI credits, when it next increases. */
  resets_at?: string;
  next_increase_at?: string;
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
    .filter(([, q]) => typeof q?.limit === "number" && q.limit > 0)
    .map(([m, q, p]) => {
      const status = toStatus(m, q?.used ?? 0, q?.limit as number, p, today, levels);
      const at = q?.resets_at ?? q?.next_increase_at;
      return at && !Number.isNaN(Date.parse(at))
        ? { ...status, resetsAt: new Date(at).toISOString() }
        : status;
    })
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
    if (rows[0])
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
    if (rows[0])
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
  info?: TokenInfo,
) {
  const today = now.toISOString().slice(0, 10);
  const headers = { Authorization: `Bearer ${token}` };
  const team = await json<{ softBlock?: { reason?: string } | null }>(
    "vercel",
    `${VERCEL_API}/v2/teams/${encodeURIComponent(t.account as string)}`,
    { headers },
    f,
  );
  const out: LimitStatus[] = [];
  // The token's own record (GET /v5/user/tokens/current) says when it expires, and whether Vercel found it leaked
  // publicly. Best effort: a token too narrowly scoped to read it must not fail the check.
  try {
    const meta = await json<{
      token?: { expiresAt?: number | string; leakedAt?: number | string };
    }>("vercel token", `${VERCEL_API}/v5/user/tokens/current`, { headers }, f);
    const exp = Number(meta.token?.expiresAt);
    if (info && Number.isFinite(exp) && exp > 0) info.expiresAt = new Date(exp).toISOString();
    if (meta.token?.leakedAt !== undefined) {
      out.push(
        problem(
          "vercel.token_leaked",
          "Vercel flagged this token as LEAKED (found exposed publicly): revoke it at vercel.com/account/tokens and paste a new one on the Tokens page",
          today,
        ),
      );
    }
  } catch {
    // no token metadata available: the date can still be entered by hand
  }
  if (team.softBlock) {
    out.push(
      problem(
        "vercel.blocked",
        `account BLOCKED by Vercel (${team.softBlock.reason ?? "see the dashboard"})`,
        today,
      ),
    );
  }
  return out;
}

const CHECKS = { github, resend, supabase, vercel };

/** Facts about the token itself that a check can learn, filled in by checkTarget when the platform says so. */
export interface TokenInfo {
  /** When the token expires (ISO), if the platform reports it. */
  expiresAt?: string;
}

/** The error a check throws when no token with that name has been added. */
export const MISSING_TOKEN = "is not set";

/** All readings for one target. Throws on a missing token or a failed call; the caller isolates targets. */
export function checkTarget(
  t: ProviderTarget,
  tokens: Readonly<Record<string, string>>,
  now: Date,
  levels: readonly number[],
  fetchImpl: typeof fetch,
  info?: TokenInfo,
): Promise<LimitStatus[]> {
  const token = tokens[t.token];
  if (!token) {
    return Promise.reject(
      new Error(`token ${t.token} ${MISSING_TOKEN} (add it on the site's Tokens page)`),
    );
  }
  return CHECKS[t.kind](t, token, now, levels, fetchImpl, info);
}

export const KIND_LABEL: Readonly<Record<ProviderKind, string>> = {
  github: "GitHub",
  resend: "Resend",
  supabase: "Supabase",
  vercel: "Vercel",
};
