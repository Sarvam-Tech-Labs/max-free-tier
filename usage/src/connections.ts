/**
 * Platforms connected on the site (Tokens page → Connect a platform), kept in D1 next to the registry's own. At read time
 * `withConnections` folds them into PROVIDERS_JSON (what to check) and CLIENTS_JSON (who owns it), so the hourly checks, the
 * Consumption page, the Tokens page and the alerts all see them with no other change. The registry always wins: a
 * connection never replaces a registry target for the same client and platform.
 * No secrets here: the token is in `tokens` (tokens.ts), encrypted.
 */
import type { Env } from "./env";
import type { ProviderKind, ProviderTarget } from "./providers";

export interface Connection {
  id: string;
  kind: ProviderKind;
  clientId: string;
  clientName: string;
  email: string | null;
  account: string | null;
  org: boolean;
  projects: string[];
  tokenName: string;
  createdAt: string;
}

interface Row {
  id: string;
  kind: ProviderKind;
  clientId: string;
  clientName: string;
  email: string | null;
  account: string | null;
  org: number;
  projects: string | null;
  tokenName: string;
  createdAt: string;
}

export async function loadConnections(db: D1Database): Promise<Connection[]> {
  const res = await db
    .prepare(
      `SELECT id, kind, client_id AS clientId, client_name AS clientName, email, account, org, projects,
              token_name AS tokenName, created_at AS createdAt FROM connections ORDER BY client_name, kind`,
    )
    .all<Row>();
  return res.results.map((r) => {
    let projects: string[] = [];
    try {
      const parsed: unknown = JSON.parse(r.projects ?? "[]");
      if (Array.isArray(parsed))
        projects = parsed.filter((p): p is string => typeof p === "string");
    } catch {
      // A corrupt list only costs this connection its project refs.
    }
    return { ...r, org: r.org === 1, projects };
  });
}

/** A saved connection that cannot be loaded (table not migrated yet) must never take a page or a run down. */
export async function safeConnections(db: D1Database): Promise<Connection[]> {
  try {
    return await loadConnections(db);
  } catch {
    return [];
  }
}

export function targetOf(c: Connection): ProviderTarget {
  return {
    id: c.clientId,
    client: c.clientName,
    kind: c.kind,
    token: c.tokenName,
    ...(c.account ? { account: c.account } : {}),
    ...(c.org ? { org: true } : {}),
    ...(c.projects.length > 0 ? { projects: c.projects } : {}),
  };
}

function asArray(json: string | undefined): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(json || "[]");
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The environment with this site's connections folded in. Safe to call twice (an entry is added once, and never over a
 * registry one). If the registry's own JSON is unreadable it is left alone, so the run still reports that problem.
 */
export async function withConnections(env: Env): Promise<Env> {
  const rows = await safeConnections(env.USAGE);
  if (rows.length === 0) return env;
  const targets = asArray(env.PROVIDERS_JSON);
  const clients = asArray(env.CLIENTS_JSON);
  if (targets === null || clients === null) return env;

  const have = new Set(
    targets.map((t) => `${(t as ProviderTarget)?.kind}:${(t as ProviderTarget)?.id}`),
  );
  const added = rows.filter((c) => !have.has(`${c.kind}:${c.clientId}`));
  if (added.length === 0) return env;

  const known = new Map(
    clients.map((c) => [(c as { id?: string })?.id, c as { platforms?: unknown }]),
  );
  const fresh = new Map<string, Record<string, unknown>>();
  for (const c of added) {
    if (known.has(c.clientId)) continue; // a registry client: only its targets grow
    const cur = fresh.get(c.clientId);
    if (cur) (cur.platforms as string[]).push(c.kind);
    else {
      fresh.set(c.clientId, {
        id: c.clientId,
        name: c.clientName,
        ...(c.email ? { email: c.email } : {}),
        status: "live",
        platforms: [c.kind],
        accounts: [],
        monitors: [],
        domains: [],
      });
    }
  }
  return {
    ...env,
    PROVIDERS_JSON: JSON.stringify([...targets, ...added.map(targetOf)]),
    CLIENTS_JSON: JSON.stringify([...clients, ...fresh.values()]),
  };
}

/** "Prasadam (Bhakta Bandhu)" → "prasadam-bhakta-bandhu". Empty when nothing usable is left. */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}
