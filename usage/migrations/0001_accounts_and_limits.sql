-- Multi-account support + free-plan limit alerts.
-- Rows written before this migration keep account '' — a single-account deploy keeps using '', so its
-- history and spike baseline carry on unchanged. Multi-account deploys key rows by account id.

CREATE TABLE usage_daily_new (
  account      TEXT    NOT NULL DEFAULT '',  -- '' on a single-account deploy, else the account id
  date         TEXT    NOT NULL,
  product      TEXT    NOT NULL,
  metric       TEXT    NOT NULL,
  dim          TEXT    NOT NULL,
  value        REAL    NOT NULL,
  collected_at TEXT    NOT NULL,
  PRIMARY KEY (account, date, product, metric, dim)
);
INSERT INTO usage_daily_new (account, date, product, metric, dim, value, collected_at)
  SELECT '', date, product, metric, dim, value, collected_at FROM usage_daily;
DROP TABLE usage_daily;
ALTER TABLE usage_daily_new RENAME TO usage_daily;
CREATE INDEX IF NOT EXISTS usage_daily_metric_date ON usage_daily (account, product, metric, date);

CREATE TABLE spike_notified_new (
  account     TEXT NOT NULL DEFAULT '',
  date        TEXT NOT NULL,
  product     TEXT NOT NULL,
  metric      TEXT NOT NULL,
  notified_at TEXT NOT NULL,
  PRIMARY KEY (account, date, product, metric)
);
INSERT INTO spike_notified_new (account, date, product, metric, notified_at)
  SELECT '', date, product, metric, notified_at FROM spike_notified;
DROP TABLE spike_notified;
ALTER TABLE spike_notified_new RENAME TO spike_notified;

-- Which free-plan limit levels were already posted, per account and period (YYYY-MM-DD or YYYY-MM).
CREATE TABLE IF NOT EXISTS limit_notified (
  account     TEXT    NOT NULL,
  period      TEXT    NOT NULL,
  product     TEXT    NOT NULL,
  metric      TEXT    NOT NULL,
  level       INTEGER NOT NULL,
  notified_at TEXT    NOT NULL,
  PRIMARY KEY (account, period, product, metric, level)
);
