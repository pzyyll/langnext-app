-- ABOUTME: Adds per-profile streaming toggle for translate requests.
-- ABOUTME: NOT NULL DEFAULT 1 so legacy rows read back as stream-enabled (true).
ALTER TABLE translation_profiles ADD COLUMN stream_enabled INTEGER NOT NULL DEFAULT 1;
