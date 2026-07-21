ALTER TABLE channels ADD COLUMN authorization_platform TEXT
  CHECK (authorization_platform IS NULL OR authorization_platform = platform);

CREATE INDEX idx_channels_authorization_platform
  ON channels(authorization_platform);
