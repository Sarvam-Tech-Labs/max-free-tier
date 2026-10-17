export interface Env {
  USAGE: D1Database;
  /** Account Analytics: Read token. Never logged. */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  /** Optional JSON object of metric → absolute threshold overrides. */
  THRESHOLDS_JSON?: string;
  DISCORD_WEBHOOK_URL?: string;
  SLACK_WEBHOOK_URL?: string;
}
