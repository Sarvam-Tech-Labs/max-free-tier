-- Tokens pasted into the site, and the outcome of each platform check.
--
-- tokens: the token itself is stored only as AES-256-GCM ciphertext (see src/crypto.ts); last4 is the only plaintext.
CREATE TABLE IF NOT EXISTS tokens (
  name              TEXT PRIMARY KEY, -- matches `token:` in the registry's usage blocks
  ciphertext        TEXT NOT NULL,
  iv                TEXT NOT NULL,
  last4             TEXT NOT NULL,
  expires_at        TEXT,             -- ISO; entered when pasting, or read from the platform (GitHub reports it)
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  expiry_alerted_at TEXT              -- last "expires soon" alert, so it repeats at most once a day
);

-- target_status: one row per checked platform target ("<kind>:<client id>"), updated by every hourly check.
-- Gives the site a "connected" state even when a platform has no numbers to show (Vercel Hobby), and shows when a
-- token starts failing. A failure alerts after two in a row, then at most once a day.
CREATE TABLE IF NOT EXISTS target_status (
  target     TEXT PRIMARY KEY,
  token      TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  ok_at      TEXT,                    -- last time the check worked
  error      TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  alerted_at TEXT
);
