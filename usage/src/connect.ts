/**
 * Connect a platform from the site: paste a token and say which email it belongs to; the account is found from the token.
 * An email has one connection per platform (usage is per platform account); its projects are the registry's clients.
 *
 *   POST   /api/connections        { kind, value, email, expires?, team?, org? }
 *   DELETE /api/connections/ID     disconnect: forget the connection, its token and what it produced
 *
 * Same protections as the token API (tokens.ts `guard`). Nothing here returns a token.
 */
import { loadConnections, targetOf, withConnections } from "./connections";
import { seal } from "./crypto";
import type { Env } from "./env";
import {
  KIND_LABEL,
  KINDS,
  type ProviderKind,
  type ProviderTarget,
  SUPABASE_API,
  VERCEL_API,
} from "./providers";
import { logAlert } from "./store";
import {
  clearTargets,
  deleteToken,
  describeVerified,
  explain,
  guard,
  listTokens,
  MAX_TOKEN,
  MIN_TOKEN,
  parseExpiry,
  persistVerified,
  putToken,
  reply,
  safeSecretTokens,
  TOKEN_NAME,
  targetKey,
  verifyToken,
} from "./tokens";

const GITHUB = "https://api.github.com";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Found {
  account?: string;
  org?: boolean;
  projects?: string[];
}
type Discovery =
  | { ok: true; found: Found }
  | { ok: false; status: number; body: Record<string, unknown> };

const bad = (status: number, error: string, more: Record<string, unknown> = {}): Discovery => ({
  ok: false,
  status,
  body: { ok: false, error, ...more },
});

async function getJson<T>(
  kind: ProviderKind,
  url: string,
  token: string,
  f: typeof fetch,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await f(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "max-free-tier", // GitHub rejects requests without one
      },
    });
    if (!res.ok) return { ok: false, error: explain(kind, new Error(`HTTP ${res.status}`)) };
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    return { ok: false, error: explain(kind, e) };
  }
}

/** What the token itself tells us, so nobody types an account id. */
async function discover(
  kind: ProviderKind,
  token: string,
  body: { team?: unknown; org?: unknown },
  f: typeof fetch,
): Promise<Discovery> {
  if (kind === "resend") return { ok: true, found: {} };

  if (kind === "github") {
    const org = typeof body.org === "string" ? body.org.trim() : "";
    if (org) {
      if (!/^[A-Za-z0-9-]{1,39}$/.test(org))
        return bad(400, "That is not a GitHub organization name.");
      return { ok: true, found: { account: org, org: true } };
    }
    const me = await getJson<{ login?: string }>("github", `${GITHUB}/user`, token, f);
    if (!me.ok) return bad(422, me.error);
    return me.data.login
      ? { ok: true, found: { account: me.data.login } }
      : bad(422, "GitHub did not say whose token this is.");
  }

  if (kind === "supabase") {
    const list = await getJson<Array<{ ref?: string; status?: string }>>(
      "supabase",
      `${SUPABASE_API}/v1/projects`,
      token,
      f,
    );
    if (!list.ok) return bad(422, list.error);
    const refs = (Array.isArray(list.data) ? list.data : [])
      .filter((p) => typeof p.ref === "string" && p.status !== "REMOVED")
      .map((p) => p.ref as string)
      .slice(0, 20);
    return refs.length > 0
      ? { ok: true, found: { projects: refs } }
      : bad(422, "Supabase shows no projects for this token. Check its scope includes projects.");
  }

  // vercel
  const teams = await getJson<{ teams?: Array<{ id?: string; slug?: string; name?: string }> }>(
    "vercel",
    `${VERCEL_API}/v2/teams?limit=50`,
    token,
    f,
  );
  if (!teams.ok) return bad(422, teams.error);
  const list = (teams.data.teams ?? []).filter((t) => typeof t.id === "string");
  const wanted = typeof body.team === "string" ? body.team : "";
  const pick = wanted ? list.find((t) => t.id === wanted) : list.length === 1 ? list[0] : undefined;
  if (pick?.id) return { ok: true, found: { account: pick.id } };
  if (list.length === 0) {
    return bad(
      422,
      "Vercel shows no team for this token. Create it with the team's scope (personal Hobby accounts are not supported yet).",
    );
  }
  if (wanted) return bad(400, "That Vercel team is not visible to this token.");
  return bad(409, "This token can see several Vercel teams. Pick the one to monitor.", {
    choose: list.map((t) => ({ id: t.id, name: t.name ?? t.slug ?? t.id })),
  });
}

/** A token name nobody else uses: KIND_EMAIL, then _2, _3… */
function freshTokenName(kind: ProviderKind, email: string, taken: ReadonlySet<string>): string {
  const base = `${kind}_${email}`
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .slice(0, 58);
  let name = base;
  for (let n = 2; taken.has(name) || !TOKEN_NAME.test(name); n++) name = `${base}_${n}`;
  return name;
}

export async function handleConnectionApi(
  request: Request,
  env: Env,
  now: Date = new Date(),
  f: typeof fetch = fetch,
): Promise<Response> {
  const refused = guard(request);
  if (refused) return refused;
  const key = env.TOKEN_ENCRYPTION_KEY;
  if (!key) {
    return reply(409, {
      ok: false,
      error: "Token storage is not enabled: set the TOKEN_ENCRYPTION_KEY secret and redeploy.",
    });
  }
  const iso = now.toISOString();
  const parts = new URL(request.url).pathname.split("/").filter(Boolean); // api, connections, ID?

  // DELETE /api/connections/ID
  if (parts.length === 3 && request.method === "DELETE") {
    let id: string;
    try {
      id = decodeURIComponent(parts[2] as string);
    } catch {
      return reply(400, { ok: false, error: "Bad connection id." });
    }
    const conn = (await loadConnections(env.USAGE)).find((c) => c.id === id);
    if (!conn) return reply(404, { ok: false, error: "No such connection." });
    await env.USAGE.prepare("DELETE FROM email_connections WHERE id = ?1").bind(id).run();
    await deleteToken(env.USAGE, conn.tokenName);
    await clearTargets(env.USAGE, [targetKey(targetOf(conn))], conn.tokenName);
    await logAlert(
      env.USAGE,
      "tokens",
      `Disconnected ${KIND_LABEL[conn.kind]} for ${conn.email}`,
      iso,
    );
    return reply(200, { ok: true });
  }

  if (parts.length !== 2) return reply(404, { ok: false, error: "Not found." });
  if (request.method !== "POST") return reply(405, { ok: false, error: "Use POST." });

  let body: {
    kind?: unknown;
    value?: unknown;
    email?: unknown;
    expires?: unknown;
    team?: unknown;
    org?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return reply(400, { ok: false, error: "The body must be JSON." });
  }

  const kind = KINDS.find((k) => k === body?.kind);
  if (!kind) return reply(400, { ok: false, error: "Pick a platform." });
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL.test(email)) {
    return reply(400, {
      ok: false,
      error: "Enter the email this platform account is registered with.",
    });
  }
  const value = typeof body.value === "string" ? body.value.trim() : "";
  if (value.length < MIN_TOKEN || value.length > MAX_TOKEN || /\s/.test(value)) {
    return reply(400, {
      ok: false,
      error: `That does not look like a token (${MIN_TOKEN}–${MAX_TOKEN} characters, no spaces).`,
    });
  }
  const expires = parseExpiry(body.expires);
  if (expires === undefined)
    return reply(400, { ok: false, error: "The expiry must be a date (YYYY-MM-DD)." });
  if (expires !== null && Date.parse(expires) <= now.getTime())
    return reply(400, { ok: false, error: "That expiry date has already passed." });

  // One account per email and platform, whether it came from the registry or from an earlier connection.
  const merged = await withConnections(env);
  let targets: ProviderTarget[] = [];
  try {
    const t: unknown = JSON.parse(merged.PROVIDERS_JSON || "[]");
    if (Array.isArray(t)) targets = t as ProviderTarget[];
  } catch {
    // Unreadable registry JSON: treat as empty; the run log reports it.
  }
  if (targets.some((t) => t.id === email && t.kind === kind)) {
    return reply(409, {
      ok: false,
      error: `${email} already has ${KIND_LABEL[kind]} connected. Use Replace on its row to change the token.`,
    });
  }

  // Find the account from the token, then run the real check with it.
  const found = await discover(kind, value, body, f);
  if (!found.ok) return reply(found.status, found.body);

  const taken = new Set<string>([
    ...targets.map((t) => t.token),
    ...Object.keys(safeSecretTokens(env)),
    ...(await listTokens(env.USAGE)).map((t) => t.name),
  ]);
  const tokenName = freshTokenName(kind, email, taken);
  const target: ProviderTarget = {
    id: email,
    client: email,
    kind,
    token: tokenName,
    ...(found.found.account ? { account: found.found.account } : {}),
    ...(found.found.org ? { org: true } : {}),
    ...(found.found.projects ? { projects: found.found.projects } : {}),
  };
  const verified = await verifyToken(
    { name: tokenName, kind, targets: [target], mixed: false },
    value,
    now,
    f,
  );
  if (!verified.ok) return reply(422, { ok: false, error: verified.error });

  const id = crypto.randomUUID();
  await putToken(
    env.USAGE,
    tokenName,
    await seal(key, tokenName, value),
    value.slice(-4),
    expires ?? verified.expiresAt ?? null,
    iso,
  );
  try {
    await env.USAGE.prepare(
      `INSERT INTO email_connections (id, email, kind, account, org, projects, token_name, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(
        id,
        email,
        kind,
        found.found.account ?? null,
        found.found.org ? 1 : 0,
        found.found.projects ? JSON.stringify(found.found.projects) : null,
        tokenName,
        iso,
      )
      .run();
  } catch {
    await deleteToken(env.USAGE, tokenName); // no token without its connection
    return reply(409, {
      ok: false,
      error: `${email} already has ${KIND_LABEL[kind]} connected.`,
    });
  }
  await persistVerified(env, tokenName, verified, iso);
  await logAlert(env.USAGE, "tokens", `Connected ${KIND_LABEL[kind]} for ${email}`, iso);
  const where = found.found.account ?? found.found.projects?.join(", ");
  return reply(200, {
    ok: true,
    detail: `${describeVerified(kind, verified)} Connected for ${email}${where ? ` (${where})` : ""}.`,
    tokenName,
    email,
  });
}
