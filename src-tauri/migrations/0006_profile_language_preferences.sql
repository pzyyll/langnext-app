-- ABOUTME: Adds profile-level Primary/Target preferred language columns.
-- ABOUTME: Nullable for backward compatibility; validated as a concrete supported pair on save.
ALTER TABLE translation_profiles ADD COLUMN primary_lang TEXT;
ALTER TABLE translation_profiles ADD COLUMN preferred_target_lang TEXT;
