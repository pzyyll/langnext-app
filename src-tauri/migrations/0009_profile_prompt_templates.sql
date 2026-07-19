-- ABOUTME: Multi prompt templates per profile with a required default selection.
-- ABOUTME: Replaces system_template/user_template; existing profile rows are discarded (no legacy compat).

-- Wipe profiles (and cascaded targets). History keeps denormalized profile_name only.
DELETE FROM translation_profile_models;
DELETE FROM translation_profiles;

-- Clear settings default so it cannot point at a removed profile.
UPDATE app_settings
SET value_json = json_set(value_json, '$.defaultProfileId', null)
WHERE id = 1;

-- Rebuild profiles without single-template columns; add default_prompt_template_id.
-- No FK to templates table (insert order is profile then templates; validated in service).
CREATE TABLE translation_profiles_new (
    id                          TEXT PRIMARY KEY,
    name                        TEXT NOT NULL,
    enabled                     INTEGER NOT NULL DEFAULT 1
                                CHECK (enabled IN (0, 1)),
    template_version            INTEGER NOT NULL,
    default_prompt_template_id  TEXT NOT NULL,
    temperature                 REAL,
    max_output_tokens           INTEGER,
    provider_options_json       TEXT,
    source_lang                 TEXT,
    target_lang                 TEXT,
    primary_lang                TEXT,
    preferred_target_lang       TEXT,
    language_detection_json     TEXT,
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL,
    CHECK (temperature IS NULL OR temperature >= 0),
    CHECK (max_output_tokens IS NULL OR max_output_tokens > 0)
);

DROP TABLE translation_profiles;
ALTER TABLE translation_profiles_new RENAME TO translation_profiles;

CREATE TABLE translation_profile_prompt_templates (
    id                          TEXT PRIMARY KEY,
    translation_profile_id      TEXT NOT NULL,
    name                        TEXT NOT NULL,
    system_template             TEXT NOT NULL,
    user_template               TEXT NOT NULL,
    sort_order                  INTEGER NOT NULL CHECK (sort_order >= 0),
    FOREIGN KEY (translation_profile_id)
        REFERENCES translation_profiles(id) ON DELETE CASCADE,
    UNIQUE (translation_profile_id, sort_order)
);
