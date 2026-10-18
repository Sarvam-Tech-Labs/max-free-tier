-- Platforms connected on the site's Tokens page (no registry edit, no redeploy). Merged with the registry's targets and
-- clients at read time (connections.ts). The token itself is in `tokens` under token_name, encrypted; nothing secret here.
CREATE TABLE IF NOT EXISTS connections (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  client_name TEXT NOT NULL,
  email       TEXT,
  -- Found from the token itself: GitHub login, Vercel team id. NULL for Resend and Supabase.
  account     TEXT,
  org         INTEGER NOT NULL DEFAULT 0,
  -- Supabase: JSON array of project refs found from the token.
  projects    TEXT,
  token_name  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (client_id, kind)
);
