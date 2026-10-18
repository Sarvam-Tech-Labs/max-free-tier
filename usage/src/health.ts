/**
 * The non-usage half of the site: whether each client's sites are up (read from FlareWatch, the uptime Worker in the
 * same account, over the MONITOR_WORKER service binding — GET /view, the same call its own status page makes), and
 * when each domain's registration expires (public RDAP, refreshed daily).
 */
import type { Env } from "./env";

export type UptimeStatus = "up" | "down" | "degraded" | "late" | "pending" | "running";

export interface MonitorState {
  status: UptimeStatus;
  warning?: string;
  /** Downtime stretches, oldest first: unix seconds; `end` absent while still down. */
  incidents: Array<{ start: number[]; end?: number; error: string[] }>;
  latest?: { loc: string; ping: number; time: number };
}

export interface UptimeView {
  /** Last FlareWatch check run, unix seconds (0 before the first). */
  lastUpdate: number;
  monitors: Record<string, MonitorState>;
}

/** FlareWatch's current view, or null when it is not bound, not deployed, or answers something unexpected. */
export async function readUptime(env: Pick<Env, "MONITOR_WORKER">): Promise<UptimeView | null> {
  if (!env.MONITOR_WORKER) return null;
  try {
    const res = await env.MONITOR_WORKER.fetch("https://internal/view"); // the hostname is ignored; routing is by path
    if (!res.ok) return null;
    const v = (await res.json()) as Partial<UptimeView>;
    if (typeof v.lastUpdate !== "number" || typeof v.monitors !== "object" || v.monitors === null)
      return null;
    return { lastUpdate: v.lastUpdate, monitors: v.monitors };
  } catch {
    return null;
  }
}

/** A domain's registration expiry, as last looked up. */
export interface DomainRow {
  domain: string;
  expires: string | null;
  error: string | null;
  checkedAt: string;
}

export const DOMAIN_REFRESH_MS = 24 * 3_600_000;

/** RDAP bootstrap service: redirects to the registry that is authoritative for the TLD. */
const RDAP = "https://rdap.org/domain/";

interface RdapDomain {
  events?: Array<{ eventAction?: string; eventDate?: string }>;
}

/**
 * Look up each domain not checked in the last day and store its expiry. Returns the errors (one per failed domain);
 * a failure keeps the previous expiry so the page does not lose a known date.
 * shortcut: one lookup (~2 subrequests with the redirect) per domain per day inside the hourly collect; split it out if
 * a registry ever grows past ~15 domains.
 */
export async function refreshDomains(
  db: D1Database,
  domains: readonly string[],
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  if (domains.length === 0) return [];
  const known = new Map((await loadDomains(db)).map((d) => [d.domain, d]));
  const due = [...new Set(domains)].filter((d) => {
    const row = known.get(d);
    return !row || now.getTime() - Date.parse(row.checkedAt) >= DOMAIN_REFRESH_MS;
  });
  const errors: string[] = [];
  const at = now.toISOString();
  const upsert = db.prepare(
    `INSERT INTO domain_expiry (domain, expires, error, checked_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (domain) DO UPDATE SET expires = COALESCE(excluded.expires, domain_expiry.expires), error = excluded.error, checked_at = excluded.checked_at`,
  );
  for (const domain of due) {
    let expires: string | null = null;
    let error: string | null = null;
    try {
      const res = await fetchImpl(RDAP + encodeURIComponent(domain), {
        headers: { Accept: "application/rdap+json" },
      });
      if (!res.ok) throw new Error(`RDAP HTTP ${res.status}`);
      const body = (await res.json()) as RdapDomain;
      const date = body.events?.find((e) => e.eventAction === "expiration")?.eventDate;
      if (!date || Number.isNaN(Date.parse(date)))
        throw new Error("no expiration date in the RDAP record");
      expires = new Date(date).toISOString();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      errors.push(`${domain}: ${error}`);
    }
    await upsert.bind(domain, expires, error, at).run();
  }
  return errors;
}

export async function loadDomains(db: D1Database): Promise<DomainRow[]> {
  const res = await db
    .prepare(
      "SELECT domain, expires, error, checked_at AS checkedAt FROM domain_expiry ORDER BY domain",
    )
    .all<DomainRow>();
  return res.results;
}

/** Every live client's domains from CLIENTS_JSON. Missing or invalid JSON → []. */
export function domainsOf(clientsJson: string | undefined): string[] {
  try {
    const clients: unknown = JSON.parse(clientsJson || "[]");
    if (!Array.isArray(clients)) return [];
    return clients.flatMap((c) =>
      Array.isArray(c?.domains)
        ? c.domains.filter((d: unknown): d is string => typeof d === "string")
        : [],
    );
  } catch {
    return [];
  }
}

/** Whole days until `iso` (negative once past). */
export function daysUntil(iso: string, now: Date): number {
  return Math.floor((Date.parse(iso) - now.getTime()) / 86_400_000);
}
