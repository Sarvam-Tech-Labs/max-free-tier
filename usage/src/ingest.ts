/**
 * POST /ingest — the daily GitHub Actions jobs (free-tier terms watch, limits drift check) report here, so their
 * results show on the site's Activity page instead of only in Telegram.
 *   Authorization: Bearer <INGEST_TOKEN>
 *   { "check": "terms" | "drift", "ok": boolean, "text": "what changed / what drifted (empty when ok)" }
 * Without the INGEST_TOKEN secret the route does not exist (404).
 */
import { bearer } from "./auth";
import type { Env } from "./env";
import { logAlert, recordRun } from "./store";

export const INGEST_CHECKS = ["terms", "drift"] as const;
const MAX_TEXT = 8_000;

// A 204 must have a null body (even "" is rejected by the Response constructor).
const reply = (status: number, text: string) =>
  new Response(status === 204 ? null : text, { status, headers: { "Cache-Control": "no-store" } });

export async function handleIngest(
  request: Request,
  env: Env,
  now: Date = new Date(),
): Promise<Response> {
  if (!env.INGEST_TOKEN) return reply(404, "Not found");
  if (!(await bearer(request, env.INGEST_TOKEN))) return reply(401, "Unauthorized");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reply(400, "Body must be JSON");
  }
  const { check, ok, text } = (body ?? {}) as { check?: unknown; ok?: unknown; text?: unknown };
  if (!INGEST_CHECKS.includes(check as (typeof INGEST_CHECKS)[number])) {
    return reply(400, `check must be one of ${INGEST_CHECKS.join(", ")}`);
  }
  if (typeof ok !== "boolean") return reply(400, "ok must be a boolean");
  if (text !== undefined && typeof text !== "string") return reply(400, "text must be a string");
  const detail = (text ?? "").trim().slice(0, MAX_TEXT);
  const at = now.toISOString();
  const firstLine = detail.split("\n").find((l) => l.trim() !== "") ?? "";
  await recordRun(
    env.USAGE,
    check as string,
    ok,
    ok ? "no changes" : firstLine.slice(0, 300) || "something changed",
    at,
  );
  if (!ok)
    await logAlert(env.USAGE, check as string, detail || "something changed (no details sent)", at);
  return reply(204, "");
}
