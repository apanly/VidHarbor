ALTER TABLE downloads ADD COLUMN output_size_bytes INTEGER CHECK (output_size_bytes IS NULL OR (output_size_bytes > 0 AND status = 'completed'));
