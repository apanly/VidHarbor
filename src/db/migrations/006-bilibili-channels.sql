PRAGMA defer_foreign_keys = ON;

CREATE TABLE channels_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL CHECK (platform IN ('youtube','bilibili')),
  extractor TEXT NOT NULL DEFAULT 'YoutubeTab' CHECK (
    (platform = 'youtube' AND extractor = 'YoutubeTab')
    OR (platform = 'bilibili' AND extractor = 'BilibiliSpaceVideo')
  ),
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

INSERT INTO channels_new SELECT * FROM channels;
DROP TABLE channels;
ALTER TABLE channels_new RENAME TO channels;
CREATE INDEX idx_channels_due ON channels(last_check_started_at);

CREATE TABLE videos_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  platform TEXT NOT NULL CHECK (platform IN ('youtube','bilibili')),
  platform_video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  published_date TEXT NOT NULL,
  source_url TEXT NOT NULL,
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  thumbnail_url TEXT,
  discovery_kind TEXT NOT NULL CHECK (discovery_kind IN ('historical','new')),
  discovered_at TEXT NOT NULL,
  UNIQUE (platform, platform_video_id)
);

INSERT INTO videos_new SELECT * FROM videos;
DROP TABLE videos;
ALTER TABLE videos_new RENAME TO videos;
CREATE INDEX idx_videos_channel_date ON videos(channel_id, published_date DESC, id DESC);

CREATE TABLE downloads_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL CHECK (source_type IN ('channel','direct')),
  channel_id INTEGER REFERENCES channels(id) ON DELETE RESTRICT,
  video_id INTEGER REFERENCES videos(id) ON DELETE RESTRICT,
  source_url TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform <> ''),
  platform_video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  published_date TEXT,
  network_mode TEXT NOT NULL CHECK (network_mode IN ('direct','proxy')),
  proxy_name TEXT,
  proxy_url_snapshot TEXT,
  target_subdirectory TEXT,
  advanced_options_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','downloading','running','completed','failed','canceled','interrupted')),
  output_path TEXT,
  failure_reason TEXT,
  progress_percent REAL CHECK (progress_percent IS NULL OR (progress_percent >= 0 AND progress_percent <= 100)),
  speed_text TEXT,
  eta_seconds INTEGER CHECK (eta_seconds IS NULL OR eta_seconds >= 0),
  exit_code INTEGER,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  thumbnail_path TEXT,
  archive_layout TEXT NOT NULL DEFAULT 'legacy_file' CHECK (archive_layout IN ('legacy_file','download_directory')),
  output_size_bytes INTEGER CHECK (output_size_bytes IS NULL OR (output_size_bytes > 0 AND status = 'completed')),
  CHECK (
    (source_type = 'channel' AND channel_id IS NOT NULL AND video_id IS NOT NULL AND published_date IS NOT NULL AND platform IN ('youtube','bilibili'))
    OR (source_type = 'direct' AND channel_id IS NULL AND video_id IS NULL)
  ),
  CHECK ((network_mode='direct' AND proxy_name IS NULL AND proxy_url_snapshot IS NULL) OR (network_mode='proxy' AND proxy_name IS NOT NULL AND proxy_url_snapshot IS NOT NULL)),
  CHECK ((status='completed' AND output_path IS NOT NULL AND failure_reason IS NULL) OR (status IN ('failed','canceled','interrupted') AND failure_reason IS NOT NULL AND output_path IS NULL) OR (status IN ('pending','downloading','running') AND output_path IS NULL AND failure_reason IS NULL))
);

INSERT INTO downloads_new SELECT * FROM downloads;
DROP TABLE downloads;
ALTER TABLE downloads_new RENAME TO downloads;
CREATE INDEX idx_downloads_status_created ON downloads(status, created_at, id);
CREATE INDEX idx_downloads_created ON downloads(created_at DESC, id DESC);
