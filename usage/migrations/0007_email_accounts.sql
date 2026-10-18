-- Email-first: a platform account belongs to an email (one connection per email and platform, one token), not to a project.
-- New table; the project-keyed `connections` from 0006 is superseded and left unused (it never held a production row).
-- Readings and check outcomes recorded under the old per-project keys are ignored from now on and refill under the email keys
-- on the next hourly run (or a Test click).
CREATE TABLE IF NOT EXISTS email_connections (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  -- Found from the token itself: GitHub login, Vercel team id. NULL for Resend and Supabase.
  account    TEXT,
  org        INTEGER NOT NULL DEFAULT 0,
  -- Supabase: JSON array of project refs found from the token.
  projects   TEXT,
  token_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (email, kind)
);
