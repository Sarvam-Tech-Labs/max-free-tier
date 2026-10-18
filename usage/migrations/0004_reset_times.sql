-- When a quota next resets, as the platform's own API reports it (Resend). Null = the calendar rule applies.
ALTER TABLE provider_readings ADD COLUMN resets_at TEXT;
