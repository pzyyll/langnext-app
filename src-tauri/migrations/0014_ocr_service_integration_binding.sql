-- ABOUTME: Adds plugin_capability OCR engine binding to integration instances.
-- ABOUTME: Backfills baidu/ai rows unchanged; plugin rows use ON DELETE RESTRICT FK.

-- Rebuild ocr_services with provider_type discriminant including plugin_capability.
CREATE TABLE ocr_services_new (
    id                              TEXT PRIMARY KEY,
    provider_type                   TEXT NOT NULL
                                    CHECK (provider_type IN ('baidu', 'ai', 'plugin_capability')),
    display_name                    TEXT NOT NULL,
    enabled                         INTEGER NOT NULL DEFAULT 1
                                    CHECK (enabled IN (0, 1)),
    sort_order                      INTEGER NOT NULL CHECK (sort_order >= 0),
    -- Baidu-only (NULL for ai / plugin_capability)
    baidu_action                    TEXT
                                    CHECK (
                                      baidu_action IS NULL OR baidu_action IN (
                                        'accurate',
                                        'accurate_basic',
                                        'general',
                                        'general_basic'
                                      )
                                    ),
    api_key_ref                     TEXT,
    secret_key_ref                  TEXT,
    -- AI-only (NULL for baidu / plugin_capability)
    provider_model_id               TEXT,
    temperature                     REAL
                                    CHECK (temperature IS NULL OR temperature >= 0),
    default_prompt_template_id      TEXT,
    -- Plugin-only (NULL for baidu / ai)
    integration_instance_id         TEXT,
    ocr_capability_id               TEXT,
    capability_preferences_version  INTEGER,
    capability_preferences_json     TEXT,
    created_at                      TEXT NOT NULL,
    updated_at                      TEXT NOT NULL,
    CHECK (
      (
        provider_type = 'baidu'
        AND baidu_action IS NOT NULL
        AND provider_model_id IS NULL
        AND temperature IS NULL
        AND default_prompt_template_id IS NULL
        AND integration_instance_id IS NULL
        AND ocr_capability_id IS NULL
        AND capability_preferences_version IS NULL
        AND capability_preferences_json IS NULL
      )
      OR
      (
        provider_type = 'ai'
        AND baidu_action IS NULL
        AND api_key_ref IS NULL
        AND secret_key_ref IS NULL
        AND provider_model_id IS NOT NULL
        AND default_prompt_template_id IS NOT NULL
        AND integration_instance_id IS NULL
        AND ocr_capability_id IS NULL
        AND capability_preferences_version IS NULL
        AND capability_preferences_json IS NULL
      )
      OR
      (
        provider_type = 'plugin_capability'
        AND baidu_action IS NULL
        AND api_key_ref IS NULL
        AND secret_key_ref IS NULL
        AND provider_model_id IS NULL
        AND temperature IS NULL
        AND default_prompt_template_id IS NULL
        AND integration_instance_id IS NOT NULL
        AND ocr_capability_id IS NOT NULL
        AND capability_preferences_version IS NOT NULL
        AND capability_preferences_json IS NOT NULL
      )
    ),
    FOREIGN KEY (integration_instance_id)
        REFERENCES integration_instances(id) ON DELETE RESTRICT
);

INSERT INTO ocr_services_new (
    id,
    provider_type,
    display_name,
    enabled,
    sort_order,
    baidu_action,
    api_key_ref,
    secret_key_ref,
    provider_model_id,
    temperature,
    default_prompt_template_id,
    integration_instance_id,
    ocr_capability_id,
    capability_preferences_version,
    capability_preferences_json,
    created_at,
    updated_at
)
SELECT
    id,
    provider_type,
    display_name,
    enabled,
    sort_order,
    baidu_action,
    api_key_ref,
    secret_key_ref,
    provider_model_id,
    temperature,
    default_prompt_template_id,
    NULL,
    NULL,
    NULL,
    NULL,
    created_at,
    updated_at
FROM ocr_services;

DROP TABLE ocr_services;
ALTER TABLE ocr_services_new RENAME TO ocr_services;

CREATE INDEX idx_ocr_services_sort
    ON ocr_services(sort_order ASC, created_at ASC, id ASC);

CREATE INDEX idx_ocr_services_provider_type
    ON ocr_services(provider_type);

CREATE INDEX idx_ocr_services_integration_instance
    ON ocr_services(integration_instance_id)
    WHERE integration_instance_id IS NOT NULL;
