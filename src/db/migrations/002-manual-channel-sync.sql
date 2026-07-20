PRAGMA defer_foreign_keys = ON;

CREATE TABLE channels_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL CHECK (platform = 'youtube'),
  extractor TEXT NOT NULL DEFAULT 'YoutubeTab' CHECK (extractor = 'YoutubeTab'),
  platform_channel_id TEXT,
  source_url TEXT NOT NULL,
  custom_name TEXT NOT NULL,
  custom_name_key TEXT NOT NULL UNIQUE,
  proxy_id INTEGER REFERENCES proxies(id) ON DELETE RESTRICT,
  check_interval_minutes INTEGER CHECK (check_interval_minutes IS NULL OR check_interval_minutes >= 1),
  paused_at TEXT,
  initial_sync_status TEXT NOT NULL DEFAULT 'succeeded' CHECK (initial_sync_status IN ('pending','syncing','succeeded','failed')),
  initial_sync_error TEXT,
  initial_synced_at TEXT,
  last_check_started_at TEXT,
  next_check_at TEXT,
  last_check_result TEXT CHECK (last_check_result IS NULL OR last_check_result IN ('success','no_updates','failed')),
  last_check_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (platform, platform_channel_id),
  CHECK (
    (initial_sync_status = 'succeeded' AND initial_synced_at IS NOT NULL AND initial_sync_error IS NULL)
    OR (initial_sync_status IN ('pending','syncing') AND platform_channel_id IS NULL AND initial_synced_at IS NULL AND initial_sync_error IS NULL)
    OR (initial_sync_status = 'failed' AND platform_channel_id IS NULL AND initial_synced_at IS NULL AND initial_sync_error IS NOT NULL)
  )
);

INSERT INTO channels_new (
  id, platform, extractor, platform_channel_id, source_url, custom_name,
  custom_name_key, proxy_id, check_interval_minutes, paused_at,
  initial_sync_status, initial_sync_error, initial_synced_at,
  last_check_started_at, next_check_at, last_check_result, last_check_error,
  created_at, updated_at
)
SELECT id, platform, extractor, platform_channel_id, source_url, custom_name,
       custom_name_key, proxy_id, check_interval_minutes, paused_at,
       'succeeded', NULL, initial_synced_at,
       last_check_started_at, next_check_at, last_check_result, last_check_error,
       created_at, updated_at
FROM channels;

DROP TABLE channels;
ALTER TABLE channels_new RENAME TO channels;
CREATE INDEX idx_channels_due ON channels(last_check_started_at);
