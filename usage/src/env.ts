export interface Env {
  USAGE: D1Database;
  /** Account Analytics: Read token. Never logged. */
  CF_API_TOKEN?: string;
  /** One account id, or several separated by commas (the token must be able to read each one). */
  CF_ACCOUNT_ID?: string;
  /** Optional JSON object of account id → display label, e.g. {"0123…": "Acme"}. */
  ACCOUNT_LABELS_JSON?: string;
  /** Optional JSON object of metric → absolute threshold overrides. */
  THRESHOLDS_JSON?: string;
  /** Optional JSON object of metric → included limit overrides (0 turns a metric's limit alerts off). */
  LIMITS_JSON?: string;
  /** Optional comma-separated percentages at which limit alerts fire. Default "50,80,95". */
  LIMIT_LEVELS?: string;
  /** Optional JSON array of other-platform targets (GitHub, Resend, Supabase, Vercel); see providers.ts. No secrets. */
  PROVIDERS_JSON?: string;
  /** Secret: JSON object of token key → token, for the keys PROVIDERS_JSON names. Never logged. */
  PROVIDER_TOKENS?: string;
  /** Secret. Without it the overview page does not exist (404); with it, HTTP Basic with this password. */
  DASHBOARD_PASSWORD?: string;
  /** Static assets binding serving public/index.html (the overview page). */
  ASSETS?: Fetcher;
  /** JSON array of the registry's clients (id, name, email, status, platforms, Cloudflare accounts) for the by-client page. */
  CLIENTS_JSON?: string;
  /** Shown in the overview page's title. */
  ORG_NAME?: string;
  DISCORD_WEBHOOK_URL?: string;
  SLACK_WEBHOOK_URL?: string;
  /** Telegram bot token from @BotFather. Never logged. Needs TELEGRAM_CHAT_ID too. */
  TELEGRAM_BOT_TOKEN?: string;
  /** Chat id of the user, group or channel the bot posts to (groups are negative numbers). */
  TELEGRAM_CHAT_ID?: string;
}
