/**
 * "The checks themselves stopped": an alert that can never fire if the thing that sends it has died. The two hourly runs
 * (collect at :00, platforms at :30) each look at the other's last run; if it is long overdue, say so on Telegram, at most
 * once a day. (The uptime engine and Cloudflare as a whole are covered by the Healthchecks.io watchdog, outside Cloudflare.)
 */
import type { Env } from "./env";
import { notify } from "./notify";
import { loadRuns, logAlert } from "./store";

/** An hourly run this late has missed at least two cycles. */
export const STALE_RUN_MS = 3 * 3_600_000;
const COOLDOWN_MS = 24 * 3_600_000;

export async function alertIfStale(
  env: Env,
  now: Date,
  fetchImpl: typeof fetch,
  name: "collect" | "providers",
  label: string,
): Promise<string[]> {
  try {
    const run = (await loadRuns(env.USAGE)).find((r) => r.name === name);
    if (!run) return []; // never ran: a fresh install, nothing to be late
    const age = now.getTime() - Date.parse(run.at);
    if (!(age > STALE_RUN_MS)) return [];

    const source = `stale:${name}`;
    const last = await env.USAGE.prepare(
      "SELECT at FROM alert_log WHERE source = ?1 ORDER BY at DESC LIMIT 1",
    )
      .bind(source)
      .first<{ at: string }>();
    if (last && now.getTime() - Date.parse(last.at) < COOLDOWN_MS) return [];

    const hours = Math.floor(age / 3_600_000);
    const text = `⚠️ The hourly ${label} has not run for ${hours} hours (last run ${run.at.slice(0, 16).replace("T", " ")} UTC). Token and limit alerts from it are not being checked. Look at the Worker's cron triggers and logs.`;
    const results = await notify(env, text, fetchImpl);
    const delivered = results.length > 0 && results.every((r) => r.ok);
    // Logged only when delivered, so an undelivered warning is tried again on the next run.
    if (delivered) await logAlert(env.USAGE, source, text, now.toISOString());
    return [];
  } catch (e) {
    return [`stale-run check: ${e instanceof Error ? e.message : String(e)}`];
  }
}
