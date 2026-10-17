/** Optional webhook notifications. Failures are returned, never thrown: a dead webhook must not stop the collect. */
import type { Env } from "./env";
import type { Spike } from "./spike";
import { formatRatio } from "./spike";

export function formatMessage(date: string, spikes: readonly Spike[]): string {
  const lines = spikes.map(
    (s) =>
      `• ${s.metric}: ${s.today.toLocaleString("en-US")} today vs. 7-day median ${s.baseline.toLocaleString("en-US")} (${formatRatio(s.ratio)})`,
  );
  return `usage-guard-collector — ${spikes.length} spike${spikes.length === 1 ? "" : "s"} on ${date} (UTC)\n${lines.join("\n")}`;
}

export interface NotifyResult {
  target: "discord" | "slack";
  ok: boolean;
  status?: number;
  error?: string;
}

async function post(
  target: NotifyResult["target"],
  url: string,
  payload: unknown,
  fetchImpl: typeof fetch,
): Promise<NotifyResult> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { target, ok: res.ok, status: res.status };
  } catch (e) {
    return { target, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** POST `text` to every configured webhook. No webhook configured → []. */
export async function notify(
  env: Pick<Env, "DISCORD_WEBHOOK_URL" | "SLACK_WEBHOOK_URL">,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NotifyResult[]> {
  const jobs: Promise<NotifyResult>[] = [];
  if (env.DISCORD_WEBHOOK_URL) {
    jobs.push(post("discord", env.DISCORD_WEBHOOK_URL, { content: text }, fetchImpl));
  }
  if (env.SLACK_WEBHOOK_URL) {
    jobs.push(post("slack", env.SLACK_WEBHOOK_URL, { text }, fetchImpl));
  }
  return Promise.all(jobs);
}
