/**
 * Email-first accounts. An email owns one account per platform (one GitHub token, one Vercel token, one Resend key…), and
 * its projects (the registry's clients) are what runs on those accounts. Usage is per platform account, so the token and the
 * meters belong to (email, platform), never to a project.
 *
 * Connections made on the site (Tokens → Connect a platform) live in D1. At read time `withConnections` rewrites the
 * environment so everything downstream sees that one model:
 *   - registry `usage:` targets are re-keyed from their client to the client's email (several clients under one email that
 *     name the same platform share one account; the first wins),
 *   - site connections are added unless the registry already covers that email and platform (the registry wins),
 *   - an email with a connection but no registry client gets a placeholder entry so it appears in the Consumption sidebar.
 * A registry client with no email keeps its own identity. No secrets here: the token is in `tokens` (tokens.ts), encrypted.
 */
import type { Env } from "./env";
import type { ProviderKind, ProviderTarget } from "./providers";

export interface Connection {
  id: string;
  email: string;
  kind: ProviderKind;
  account: string | null;
  org: boolean;
  projects: string[];
  tokenName: string;
  createdAt: string;
}

interface Row extends Omit<Connection, "org" | "projects"> {
  org: number;
  projects: string | null;
}

export async function loadConnections(db: D1Database): Promise<Connection[]> {
  const res = await db
    .prepare(
      `SELECT id, email, kind, account, org, projects, token_name AS tokenName, created_at AS createdAt
       FROM email_connections ORDER BY email, kind`,
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

/** A connection that cannot be loaded (table not migrated yet) must never take a page or a run down. */
export async function safeConnections(db: D1Database): Promise<Connection[]> {
  try {
    return await loadConnections(db);
  } catch {
    return [];
  }
}

/** The check target for an email's platform account. The email is the identity and the label. */
export function targetOf(c: Connection): ProviderTarget {
  return {
    id: c.email,
    client: c.email,
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

/** "Prasadam (Bhakta Bandhu)" → "prasadam-bhakta-bandhu". Empty when nothing usable is left. */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/**
 * The environment with accounts keyed by email and this site's connections folded in. Safe to call twice. If the registry's
 * own JSON is unreadable it is left alone, so the run still reports that problem.
 */
export async function withConnections(env: Env): Promise<Env> {
  const rows = await safeConnections(env.USAGE);
  const targets = asArray(env.PROVIDERS_JSON);
  const clients = asArray(env.CLIENTS_JSON);
  if (targets === null || clients === null) return env;

  const emailOf = new Map<string, string>();
  const emails = new Set<string>();
  for (const c of clients as Array<{ id?: unknown; email?: unknown }>) {
    if (typeof c?.id === "string" && typeof c.email === "string" && c.email.trim() !== "") {
      const e = c.email.trim().toLowerCase();
      emailOf.set(c.id, e);
      emails.add(e);
    }
  }

  const merged: ProviderTarget[] = [];
  const seen = new Set<string>();
  const add = (t: ProviderTarget) => {
    const key = `${t.kind}:${t.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(t);
  };
  for (const t of targets as ProviderTarget[]) {
    const email = emailOf.get(t?.id);
    add(email ? { ...t, id: email, client: email } : t);
  }
  for (const c of rows) add(targetOf(c));

  // An email that only exists as a connection still needs a place in the sidebar.
  const takenIds = new Set((clients as Array<{ id?: unknown }>).map((c) => c?.id));
  const placeholders = new Map<string, Record<string, unknown>>();
  for (const c of rows) {
    if (emails.has(c.email)) continue;
    const cur = placeholders.get(c.email);
    if (cur) {
      if (!(cur.platforms as string[]).includes(c.kind)) (cur.platforms as string[]).push(c.kind);
      continue;
    }
    let id = `account-${slugOf(c.email) || "email"}`;
    for (let n = 2; takenIds.has(id); n++) id = `account-${slugOf(c.email) || "email"}-${n}`;
    takenIds.add(id);
    placeholders.set(c.email, {
      id,
      name: c.email,
      email: c.email,
      status: "live",
      platforms: [c.kind],
      accounts: [],
      monitors: [],
      domains: [],
      synthetic: true,
    });
  }
  return {
    ...env,
    PROVIDERS_JSON: JSON.stringify(merged),
    CLIENTS_JSON: JSON.stringify([...clients, ...placeholders.values()]),
  };
}
