-- Latest reading per other-platform meter (GitHub, Resend, Supabase, Vercel), for the dashboard page.
-- Replaced as a whole per target on every successful check; a failed check keeps the previous rows, so the page can
-- show how old they are. Cloudflare readings need no table: the page derives them from usage_daily.
CREATE TABLE IF NOT EXISTS provider_readings (
  target      TEXT NOT NULL,  -- "<kind>:<client id>", same key as limit_notified
  metric      TEXT NOT NULL,
  used        REAL NOT NULL,
  limit_value REAL NOT NULL,
  period      TEXT NOT NULL,  -- day | month
  note        TEXT,           -- set for state problems (paused, blocked), not percentages
  checked_at  TEXT NOT NULL,
  PRIMARY KEY (target, metric)
);
