-- One row per (day, product, metric, dimension). Re-collecting the same day overwrites the row.
CREATE TABLE IF NOT EXISTS usage_daily (
  date         TEXT    NOT NULL,             -- YYYY-MM-DD (UTC)
  product      TEXT    NOT NULL,             -- workers | d1 | do | kv | r2 | queues
  metric       TEXT    NOT NULL,             -- e.g. requests, rows_read, class_a
  dim          TEXT    NOT NULL,             -- scriptName / databaseId / namespaceId / bucketName / queueId
  value        REAL    NOT NULL,
  collected_at TEXT    NOT NULL,             -- ISO-8601
  PRIMARY KEY (date, product, metric, dim)
);
CREATE INDEX IF NOT EXISTS usage_daily_metric_date ON usage_daily (product, metric, date);

-- Which spikes were already posted to a webhook, so the 6-hourly Cron does not repeat itself.
CREATE TABLE IF NOT EXISTS spike_notified (
  date        TEXT NOT NULL,
  product     TEXT NOT NULL,
  metric      TEXT NOT NULL,
  notified_at TEXT NOT NULL,
  PRIMARY KEY (date, product, metric)
);
