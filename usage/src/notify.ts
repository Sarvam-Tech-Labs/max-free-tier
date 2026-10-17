/** Optional webhook notifications. Failures are returned, never thrown: a dead webhook must not stop the collect. */
import type { Env } from "./env";
import { formatLimitLine, type LimitStatus } from "./limits";
import type { Spike } from "./spike";
import { formatRatio } from "./spike";

function spikeLine(s: Spike): string {
  return `• ${s.metric}: ${s.today.toLocaleString("en-US")} today vs. 7-day median ${s.baseline.toLocaleString("en-US")} (${formatRatio(s.ratio)})`;
}

export function formatMessage(date: string, spikes: readonly Spike[]): string {
  return `usage-guard-collector — ${spikes.length} spike${spikes.length === 1 ? "" : "s"} on ${date} (UTC)\n${spikes.map(spikeLine).join("\n")}`;
}

/** One account's fresh alerts. `label` is set only when several accounts are watched. */
export interface ReportSection {
  label?: string;
  spikes: readonly Spike[];
  limits: readonly LimitStatus[];
}

/**
 * The text of one run's notification. A single unlabelled spike-only section is exactly formatMessage(), so
 * single-account deploys without limit alerts get the same message as before.
 */
export function formatReport(date: string, sections: readonly ReportSection[]): string {
  const only = sections[0];
  if (sections.length === 1 && only && !only.label && only.limits.length === 0) {
    return formatMessage(date, only.spikes);
  }
  const n = sections.reduce((acc, s) => acc + s.spikes.length + s.limits.length, 0);
  const body = sections
    .map((s) =>
      [s.label, ...s.limits.map(formatLimitLine), ...s.spikes.map(spikeLine)]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  return `usage-guard-collector — ${n} alert${n === 1 ? "" : "s"} on ${date} (UTC)\n${body}`;
}

export interface NotifyResult {
  target: "discord" | "slack" | "telegram";
  ok: boolean;
  status?: number;
  error?: string;
}

/** Telegram Bot API base. The bot token goes in the path, so the full URL is never logged or returned. */
export const TELEGRAM_API = "https://api.telegram.org";

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

/** POST `text` to every configured channel. Nothing configured → []. Telegram needs both the bot token and the chat id. */
export async function notify(
  env: Pick<
    Env,
    "DISCORD_WEBHOOK_URL" | "SLACK_WEBHOOK_URL" | "TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHAT_ID"
  >,
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
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    jobs.push(
      post(
        "telegram",
        `${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        { chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true },
        fetchImpl,
      ),
    );
  }
  return Promise.all(jobs);
}
