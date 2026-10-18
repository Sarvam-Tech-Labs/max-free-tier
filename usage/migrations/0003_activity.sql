-- The site's activity view: every alert this collector sent (or tried to send), plus results reported by the daily
-- GitHub Actions jobs (free-tier terms watch, limits drift check) through POST /ingest.
CREATE TABLE IF NOT EXISTS alert_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,   -- ISO timestamp
  source TEXT NOT NULL,   -- usage | providers | terms | drift
  text   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS alert_log_at ON alert_log (at);

-- Last run of each check, so the site can say "checked 10 minutes ago, all fine" instead of staying silent.
CREATE TABLE IF NOT EXISTS check_runs (
  name    TEXT PRIMARY KEY, -- collect | providers | terms | drift
  at      TEXT NOT NULL,
  ok      INTEGER NOT NULL, -- 1 = nothing wrong, 0 = something to look at
  summary TEXT NOT NULL
);

-- Domain registration expiry from public RDAP, refreshed once a day by the collect run (FlareWatch only reports it
-- inside its 30-day warning window).
CREATE TABLE IF NOT EXISTS domain_expiry (
  domain     TEXT PRIMARY KEY,
  expires    TEXT,          -- ISO date, null when the lookup gave none
  error      TEXT,          -- last lookup error, null when fine
  checked_at TEXT NOT NULL
);
