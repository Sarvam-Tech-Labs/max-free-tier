/**
 * Token management: tokens are pasted into the site (Tokens page), verified against the platform, stored encrypted
 * (crypto.ts), and used by the hourly platform checks. Nothing here ever returns a token: the page and API see only
 * metadata (name, last 4 characters, expiry) and the outcome of each check.
 *
 * API (all behind the site password; same-site JSON requests only, see `guard`):
 *   POST   /api/tokens             { name, value, expires? }   verify, then add or replace
 *   POST   /api/tokens/NAME/test                                verify the saved token now
 *   DELETE /api/tokens/NAME                                     remove it and the readings it produced
 * (connect.ts adds /api/connections: connect a whole platform from the site.)
 * A token name must be one a registry `usage:` block asks for, so tokens cannot pile up under arbitrary names.
 */

import { type Connection, safeConnections, withConnections } from "./connections";
import { type Sealed, seal, unseal } from "./crypto";
import type { Env } from "./env";
import type { LimitStatus } from "./limits";
import { notify } from "./notify";
import {
  checkTarget,
  KIND_LABEL,
  type ProviderKind,
  type ProviderTarget,
  parseProviders,
  parseTokens,
  type TokenInfo,
} from "./providers";
import { logAlert, saveReadings } from "./store";

export const TOKEN_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
/** Alert levels used only while verifying (the numbers are discarded; only success or failure matters). */
const VERIFY_LEVELS = [50, 80, 95];
export const EXPIRY_WARN_DAYS = 14;
/** A check must fail this many runs in a row before it alerts: one network blip is not a dead token. */
export const FAIL_ALERT_AFTER = 2;
const COOLDOWN_MS = 24 * 3_600_000;
const DAY_MS = 86_400_000;

// ───────────────────────────── what the registry needs ─────────────────────────────

export interface RequiredToken {
  name: string;
  kind: ProviderKind;
  targets: ProviderTarget[];
  /** The registry uses one token name for different platforms: a mistake, refused when pasting. */
  mixed: boolean;
}

function safeTargets(env: Pick<Env, "PROVIDERS_JSON">): ProviderTarget[] {
  try {
    return parseProviders(env.PROVIDERS_JSON);
  } catch {
    return [];
  }
}

export function safeSecretTokens(env: Pick<Env, "PROVIDER_TOKENS">): Record<string, string> {
  try {
    return parseTokens(env.PROVIDER_TOKENS);
  } catch {
    return {};
  }
}

/** Every token name the registry's usage blocks ask for, with the targets that use it. */
export function requiredTokens(env: Pick<Env, "PROVIDERS_JSON">): RequiredToken[] {
  const byName = new Map<string, RequiredToken>();
  for (const t of safeTargets(env)) {
    const cur = byName.get(t.token);
    if (!cur) byName.set(t.token, { name: t.token, kind: t.kind, targets: [t], mixed: false });
    else {
      cur.targets.push(t);
      if (cur.kind !== t.kind) cur.mixed = true;
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const targetKey = (t: Pick<ProviderTarget, "kind" | "id">): string => `${t.kind}:${t.id}`;

// ───────────────────────────── storage ─────────────────────────────

export interface TokenMeta {
  name: string;
  last4: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiryAlertedAt: string | null;
}

export interface TargetStatusRow {
  target: string;
  token: string;
  checkedAt: string;
  ok: boolean;
  okAt: string | null;
  error: string | null;
  failCount: number;
  alertedAt: string | null;
}

export async function listTokens(db: D1Database): Promise<TokenMeta[]> {
  const res = await db
    .prepare(
      "SELECT name, last4, expires_at AS expiresAt, created_at AS createdAt, updated_at AS updatedAt, expiry_alerted_at AS expiryAlertedAt FROM tokens ORDER BY name",
    )
    .all<TokenMeta>();
  return res.results;
}

export async function putToken(
  db: D1Database,
  name: string,
  sealed: Sealed,
  last4: string,
  expiresAt: string | null,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tokens (name, ciphertext, iv, last4, expires_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT (name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, last4 = excluded.last4,
         expires_at = excluded.expires_at, updated_at = excluded.updated_at, expiry_alerted_at = NULL`,
    )
    .bind(name, sealed.ciphertext, sealed.iv, last4, expiresAt, now)
    .run();
}

/** Record an expiry the platform reported, without touching anything else. No row → nothing to update. */
export async function setReportedExpiry(
  db: D1Database,
  name: string,
  expiresAt: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE tokens SET expires_at = ?2 WHERE name = ?1 AND (expires_at IS NULL OR expires_at != ?2)",
    )
    .bind(name, expiresAt)
    .run();
}

export async function loadTargetStatus(db: D1Database): Promise<TargetStatusRow[]> {
  const res = await db
    .prepare(
      "SELECT target, token, checked_at AS checkedAt, ok, ok_at AS okAt, error, fail_count AS failCount, alerted_at AS alertedAt FROM target_status ORDER BY target",
    )
    .all<Omit<TargetStatusRow, "ok"> & { ok: number }>();
  return res.results.map((r) => ({ ...r, ok: r.ok === 1 }));
}

/** Record a check's outcome: success resets the failure count; failure adds one and keeps the last success time. */
export async function saveTargetStatus(
  db: D1Database,
  target: string,
  token: string,
  ok: boolean,
  error: string | null,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO target_status (target, token, checked_at, ok, ok_at, error, fail_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (target) DO UPDATE SET token = excluded.token, checked_at = excluded.checked_at, ok = excluded.ok,
         ok_at = CASE WHEN excluded.ok = 1 THEN excluded.checked_at ELSE target_status.ok_at END,
         error = excluded.error,
         fail_count = CASE WHEN excluded.ok = 1 THEN 0 ELSE target_status.fail_count + 1 END,
         alerted_at = CASE WHEN excluded.ok = 1 THEN NULL ELSE target_status.alerted_at END`,
    )
    .bind(target, token, now, ok ? 1 : 0, ok ? now : null, ok ? null : error, ok ? 0 : 1)
    .run();
}

export async function deleteToken(db: D1Database, name: string): Promise<boolean> {
  const res = await db.prepare("DELETE FROM tokens WHERE name = ?1").bind(name).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Forget what a removed token produced, so the site shows those platforms as not connected again. */
export async function clearTargets(
  db: D1Database,
  targets: readonly string[],
  token: string,
): Promise<void> {
  await db.batch([
    ...targets.map((t) => db.prepare("DELETE FROM provider_readings WHERE target = ?1").bind(t)),
    db.prepare("DELETE FROM target_status WHERE token = ?1").bind(token),
  ]);
}

/** Decrypt every saved token. A token that cannot be decrypted is skipped and reported. */
export async function loadManagedTokens(
  env: Pick<Env, "USAGE" | "TOKEN_ENCRYPTION_KEY">,
): Promise<{ tokens: Record<string, string>; errors: string[] }> {
  const rows = await env.USAGE.prepare("SELECT name, ciphertext, iv FROM tokens").all<
    { name: string } & Sealed
  >();
  if (rows.results.length === 0) return { tokens: {}, errors: [] };
  const key = env.TOKEN_ENCRYPTION_KEY;
  if (!key) return { tokens: {}, errors: ["tokens are saved but TOKEN_ENCRYPTION_KEY is not set"] };
  const tokens: Record<string, string> = {};
  const errors: string[] = [];
  for (const r of rows.results) {
    try {
      tokens[r.name] = await unseal(key, r.name, r);
    } catch {
      errors.push(
        `token ${r.name} could not be decrypted (is TOKEN_ENCRYPTION_KEY the one it was saved with?)`,
      );
    }
  }
  return { tokens, errors };
}

// ───────────────────────────── verification ─────────────────────────────

export type Verified =
  | {
      ok: true;
      results: Array<{ target: ProviderTarget; statuses: LimitStatus[] }>;
      expiresAt?: string;
      meters: number;
    }
  | { ok: false; error: string };

export function explain(kind: ProviderKind, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const code = /HTTP (\d{3})/.exec(msg)?.[1];
  const who = KIND_LABEL[kind];
  if (code === "401" || code === "403") {
    return `${who} rejected this token (HTTP ${code}). Check it is the right one and has the permissions listed above.`;
  }
  if (code === "404")
    return `${who} could not find the account or project (HTTP 404). Check the token belongs to it.`;
  return `${who} check failed: ${msg}`;
}

/** Run the real check for every target that uses this token. Stops at the first failure. Never echoes the token. */
export async function verifyToken(
  req: RequiredToken,
  value: string,
  now: Date,
  f: typeof fetch,
): Promise<Verified> {
  const results: Array<{ target: ProviderTarget; statuses: LimitStatus[] }> = [];
  const info: TokenInfo = {};
  for (const target of req.targets) {
    try {
      results.push({
        target,
        statuses: await checkTarget(target, { [req.name]: value }, now, VERIFY_LEVELS, f, info),
      });
    } catch (e) {
      return { ok: false, error: explain(target.kind, e) };
    }
  }
  const meters = results.reduce(
    (n, r) => n + r.statuses.filter((s) => s.note === undefined).length,
    0,
  );
  return { ok: true, results, meters, ...(info.expiresAt ? { expiresAt: info.expiresAt } : {}) };
}

export function describeVerified(kind: ProviderKind, v: Extract<Verified, { ok: true }>): string {
  const blocked = v.results.some((r) => r.statuses.some((s) => s.note !== undefined));
  const what =
    v.meters > 0
      ? `read ${v.meters} meter${v.meters === 1 ? "" : "s"}`
      : blocked
        ? "the account is currently flagged"
        : "reachable, nothing to measure on this plan (only the blocked check)";
  return `${KIND_LABEL[kind]} accepted the token: ${what}.`;
}

// ───────────────────────────── API ─────────────────────────────

export const reply = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/**
 * Basic auth is attached by the browser to ANY request to this site, including ones started by another website, so a
 * hostile page could otherwise add or delete tokens. These requests must carry a custom header (which another site cannot
 * send without a CORS preflight we never allow), come from this site's own origin, and (for POST) be JSON.
 */
export function guard(request: Request): Response | null {
  if (request.headers.get("X-Requested-With") !== "max-free-tier") {
    return reply(403, { ok: false, error: "Refused: this request did not come from the site." });
  }
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    return reply(403, { ok: false, error: "Refused: cross-site request." });
  }
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") {
    return reply(403, { ok: false, error: "Refused: cross-site request." });
  }
  if (
    request.method === "POST" &&
    !request.headers.get("Content-Type")?.startsWith("application/json")
  ) {
    return reply(415, { ok: false, error: "Send JSON." });
  }
  return null;
}

export const MIN_TOKEN = 8;
export const MAX_TOKEN = 4096;

/** "2026-12-31" → end of that day, UTC. null for empty; undefined for an invalid date. */
export function parseExpiry(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const ms = Date.parse(`${raw}T23:59:59.000Z`);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

export async function persistVerified(
  env: Env,
  name: string,
  v: Extract<Verified, { ok: true }>,
  iso: string,
): Promise<void> {
  for (const r of v.results) {
    await saveReadings(env.USAGE, targetKey(r.target), r.statuses, iso);
    await saveTargetStatus(env.USAGE, targetKey(r.target), name, true, null, iso);
  }
}

export async function handleTokenApi(
  request: Request,
  rawEnv: Env,
  now: Date = new Date(),
  f: typeof fetch = fetch,
): Promise<Response> {
  const refused = guard(request);
  if (refused) return refused;
  const env = await withConnections(rawEnv); // names asked for by connections made on the site count too
  const key = env.TOKEN_ENCRYPTION_KEY;
  if (!key) {
    return reply(409, {
      ok: false,
      error: "Token storage is not enabled: set the TOKEN_ENCRYPTION_KEY secret and redeploy.",
    });
  }
  const iso = now.toISOString();
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean); // api, tokens, NAME?, test?
  let name: string | undefined;
  try {
    name = parts[2] === undefined ? undefined : decodeURIComponent(parts[2]);
  } catch {
    return reply(400, { ok: false, error: "Bad token name." });
  }

  // POST /api/tokens: verify, then add or replace.
  if (name === undefined) {
    if (request.method !== "POST") return reply(405, { ok: false, error: "Use POST." });
    let body: { name?: unknown; value?: unknown; expires?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return reply(400, { ok: false, error: "The body must be JSON." });
    }
    const tokenName = typeof body?.name === "string" ? body.name : "";
    if (!TOKEN_NAME.test(tokenName)) return reply(400, { ok: false, error: "Bad token name." });
    const req = requiredTokens(env).find((r) => r.name === tokenName);
    if (!req) {
      return reply(404, {
        ok: false,
        error: `No client in the registry uses a token called ${tokenName}.`,
      });
    }
    if (req.mixed) {
      return reply(409, {
        ok: false,
        error: `${tokenName} is used for different platforms in the registry; give each its own name.`,
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
    if (expires !== null && Date.parse(expires) <= now.getTime()) {
      return reply(400, { ok: false, error: "That expiry date has already passed." });
    }

    const verified = await verifyToken(req, value, now, f);
    if (!verified.ok) return reply(422, { ok: false, error: verified.error });

    const expiresAt = expires ?? verified.expiresAt ?? null;
    await putToken(
      env.USAGE,
      tokenName,
      await seal(key, tokenName, value),
      value.slice(-4),
      expiresAt,
      iso,
    );
    await persistVerified(env, tokenName, verified, iso);
    await logAlert(env.USAGE, "tokens", `Token ${tokenName} saved and verified`, iso);
    return reply(200, { ok: true, detail: describeVerified(req.kind, verified), expiresAt });
  }

  if (!TOKEN_NAME.test(name)) return reply(400, { ok: false, error: "Bad token name." });
  const req = requiredTokens(env).find((r) => r.name === name);

  // DELETE /api/tokens/NAME
  if (parts[3] === undefined && request.method === "DELETE") {
    if (!(await deleteToken(env.USAGE, name)))
      return reply(404, { ok: false, error: "No saved token with that name." });
    await clearTargets(env.USAGE, (req?.targets ?? []).map(targetKey), name);
    await logAlert(env.USAGE, "tokens", `Token ${name} deleted`, iso);
    return reply(200, { ok: true });
  }

  // POST /api/tokens/NAME/test
  if (parts[3] === "test" && parts.length === 4 && request.method === "POST") {
    if (!req)
      return reply(404, {
        ok: false,
        error: `No client in the registry uses a token called ${name}.`,
      });
    const { tokens } = await loadManagedTokens(env);
    const value = tokens[name] ?? safeSecretTokens(env)[name];
    if (!value) return reply(404, { ok: false, error: "No token saved under that name yet." });
    const verified = await verifyToken(req, value, now, f);
    if (!verified.ok) {
      for (const t of req.targets)
        await saveTargetStatus(env.USAGE, targetKey(t), name, false, verified.error, iso);
      return reply(422, { ok: false, error: verified.error });
    }
    await persistVerified(env, name, verified, iso);
    if (verified.expiresAt) await setReportedExpiry(env.USAGE, name, verified.expiresAt);
    return reply(200, {
      ok: true,
      detail: describeVerified(req.kind, verified),
      expiresAt: verified.expiresAt ?? null,
    });
  }

  return reply(404, { ok: false, error: "Not found." });
}

// ───────────────────────────── alerts ─────────────────────────────

const day = (iso: string): string => iso.slice(0, 10);

/**
 * Telegram alert when a saved token keeps failing (two runs in a row, then at most daily) or is about to expire (within 14
 * days, at most daily). Returns errors to report; never throws. Marks an alert as sent only if every channel got it.
 */
export async function tokenAlerts(
  env: Env,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const iso = now.toISOString();
  const due = (at: string | null): boolean =>
    at === null || now.getTime() - Date.parse(at) >= COOLDOWN_MS;
  const lines: string[] = [];
  const failing: string[] = [];
  const expiring: string[] = [];
  try {
    const targets = new Map(safeTargets(env).map((t) => [targetKey(t), t]));
    for (const s of await loadTargetStatus(env.USAGE)) {
      if (s.ok || s.failCount < FAIL_ALERT_AFTER || !due(s.alertedAt)) continue;
      const t = targets.get(s.target);
      if (!t) continue; // recorded under an old key (before accounts were keyed by email): not a live check
      const who = `${t.client} · ${KIND_LABEL[t.kind]}`;
      lines.push(
        `• ${s.token} (${who}) keeps failing${s.okAt ? `, last worked ${day(s.okAt)}` : ""}: ${s.error ?? "unknown error"}`,
      );
      failing.push(s.target);
    }
    for (const m of await listTokens(env.USAGE)) {
      if (!m.expiresAt || !due(m.expiryAlertedAt)) continue;
      const left = Date.parse(m.expiresAt) - now.getTime();
      const days = Math.ceil(left / DAY_MS);
      if (days > EXPIRY_WARN_DAYS) continue;
      lines.push(
        left < 0 // not `days < 0`: 12 hours past is Math.ceil(-0.5) = -0, which would read "expires in 0 days"
          ? `• ${m.name} expired on ${day(m.expiresAt)}`
          : `• ${m.name} expires in ${days} day${days === 1 ? "" : "s"} (${day(m.expiresAt)})`,
      );
      expiring.push(m.name);
    }
    if (lines.length === 0) return [];
    const text = `🔑 Token needs attention\n${lines.join("\n")}\nReplace it on the site's Tokens page.`;
    const results = await notify(env, text, fetchImpl);
    const delivered = results.length > 0 && results.every((r) => r.ok);
    await logAlert(
      env.USAGE,
      "tokens",
      delivered ? text : `${text}\n(not delivered; retried next run)`,
      iso,
    );
    if (delivered) {
      for (const target of failing) {
        await env.USAGE.prepare("UPDATE target_status SET alerted_at = ?2 WHERE target = ?1")
          .bind(target, iso)
          .run();
      }
      for (const name of expiring) {
        await env.USAGE.prepare("UPDATE tokens SET expiry_alerted_at = ?2 WHERE name = ?1")
          .bind(name, iso)
          .run();
      }
    }
    return [];
  } catch (e) {
    return [`token alerts: ${e instanceof Error ? e.message : String(e)}`];
  }
}

// ───────────────────────────── for the Tokens page ─────────────────────────────

export interface TokensOverview {
  /** False when TOKEN_ENCRYPTION_KEY is not set: tokens cannot be added on the site. */
  enabled: boolean;
  required: RequiredToken[];
  managed: TokenMeta[];
  /** Platforms connected on the site (as opposed to the registry's usage blocks). */
  connections: Connection[];
  status: TargetStatusRow[];
  /** Names that exist in the deployment secret (PROVIDER_TOKENS); names only. */
  secretNames: string[];
}

export async function tokensOverview(rawEnv: Env): Promise<TokensOverview> {
  const env = await withConnections(rawEnv);
  return {
    enabled: Boolean(env.TOKEN_ENCRYPTION_KEY),
    required: requiredTokens(env),
    managed: await listTokens(env.USAGE),
    connections: await safeConnections(env.USAGE),
    status: await loadTargetStatus(env.USAGE),
    secretNames: Object.keys(safeSecretTokens(env)),
  };
}
