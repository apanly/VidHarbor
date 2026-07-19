ALTER TABLE downloads ADD COLUMN duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0);
ALTER TABLE downloads ADD COLUMN thumbnail_path TEXT;
ALTER TABLE downloads ADD COLUMN archive_layout TEXT NOT NULL DEFAULT 'legacy_file' CHECK (archive_layout IN ('legacy_file','download_directory'));
