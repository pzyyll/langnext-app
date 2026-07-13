-- ABOUTME: Adds optional language detector configuration to translation profiles.
-- ABOUTME: NULL inherits the profile primary model through the default LLM detector.
ALTER TABLE translation_profiles ADD COLUMN language_detection_json TEXT;
