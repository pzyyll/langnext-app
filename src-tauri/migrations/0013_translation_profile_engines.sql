-- ABOUTME: Adds engine discriminant for LLM vs plugin-capability translation profiles.
-- ABOUTME: Backfills existing rows as llm_model_chain; plugin profiles bind integration instances.

-- Rebuild translation_profiles with engine_kind and nullable LLM/plugin branch columns.
-- Child target/template tables stay; service requires ≥1 for LLM and 0 for plugin.
CREATE TABLE translation_profiles_new (
    id                              TEXT PRIMARY KEY,
    name                            TEXT NOT NULL,
    enabled                         INTEGER NOT NULL DEFAULT 1
                                    CHECK (enabled IN (0, 1)),
    engine_kind                     TEXT NOT NULL
                                    CHECK (engine_kind IN ('llm_model_chain', 'plugin_capability')),
    -- LLM-only (NULL for plugin_capability)
    template_version                INTEGER,
    default_prompt_template_id      TEXT,
    temperature                     REAL
                                    CHECK (temperature IS NULL OR temperature >= 0),
    max_output_tokens               INTEGER
                                    CHECK (max_output_tokens IS NULL OR max_output_tokens > 0),
    provider_options_json           TEXT,
    language_detection_json         TEXT,
    -- Plugin-only (NULL for llm_model_chain)
    integration_instance_id         TEXT,
    translate_capability_id         TEXT,
    detect_capability_id            TEXT,
    capability_preferences_version  INTEGER,
    capability_preferences_json     TEXT,
    -- Common language preferences
    source_lang                     TEXT,
    target_lang                     TEXT,
    primary_lang                    TEXT,
    preferred_target_lang           TEXT,
    created_at                      TEXT NOT NULL,
    updated_at                      TEXT NOT NULL,
    CHECK (
      (
        engine_kind = 'llm_model_chain'
        AND template_version IS NOT NULL
        AND default_prompt_template_id IS NOT NULL
        AND integration_instance_id IS NULL
        AND translate_capability_id IS NULL
        AND detect_capability_id IS NULL
        AND capability_preferences_version IS NULL
        AND capability_preferences_json IS NULL
      )
      OR
      (
        engine_kind = 'plugin_capability'
        AND template_version IS NULL
        AND default_prompt_template_id IS NULL
        AND temperature IS NULL
        AND max_output_tokens IS NULL
        AND provider_options_json IS NULL
        AND language_detection_json IS NULL
        AND integration_instance_id IS NOT NULL
        AND translate_capability_id IS NOT NULL
        AND capability_preferences_version IS NOT NULL
        AND capability_preferences_json IS NOT NULL
      )
    ),
    FOREIGN KEY (integration_instance_id)
        REFERENCES integration_instances(id) ON DELETE RESTRICT
);

INSERT INTO translation_profiles_new (
    id,
    name,
    enabled,
    engine_kind,
    template_version,
    default_prompt_template_id,
    temperature,
    max_output_tokens,
    provider_options_json,
    language_detection_json,
    integration_instance_id,
    translate_capability_id,
    detect_capability_id,
    capability_preferences_version,
    capability_preferences_json,
    source_lang,
    target_lang,
    primary_lang,
    preferred_target_lang,
    created_at,
    updated_at
)
SELECT
    id,
    name,
    enabled,
    'llm_model_chain',
    template_version,
    default_prompt_template_id,
    temperature,
    max_output_tokens,
    provider_options_json,
    language_detection_json,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    source_lang,
    target_lang,
    primary_lang,
    preferred_target_lang,
    created_at,
    updated_at
FROM translation_profiles;

DROP TABLE translation_profiles;
ALTER TABLE translation_profiles_new RENAME TO translation_profiles;

CREATE INDEX idx_translation_profiles_engine_kind
    ON translation_profiles(engine_kind);

CREATE INDEX idx_translation_profiles_integration_instance
    ON translation_profiles(integration_instance_id)
    WHERE integration_instance_id IS NOT NULL;
