-- ABOUTME: OCR service instances (Baidu + AI) and AI OCR prompt templates.
-- ABOUTME: Secrets live in the OS vault; only opaque refs are stored here.

-- Expand credential journal owner kinds for Baidu dual vault bindings.
CREATE TABLE credential_operations_new (
    id                  TEXT PRIMARY KEY,
    owner_kind          TEXT NOT NULL
                        CHECK (owner_kind IN (
                          'provider',
                          'global_proxy',
                          'ocr_api_key',
                          'ocr_secret_key'
                        )),
    owner_id            TEXT NOT NULL,
    expected_old_ref    TEXT,
    new_ref             TEXT,
    state               TEXT NOT NULL
                        CHECK (state IN ('prepared', 'db_committed')),
    created_at          TEXT NOT NULL
);

INSERT INTO credential_operations_new (
    id, owner_kind, owner_id, expected_old_ref, new_ref, state, created_at
)
SELECT id, owner_kind, owner_id, expected_old_ref, new_ref, state, created_at
FROM credential_operations;

DROP TABLE credential_operations;
ALTER TABLE credential_operations_new RENAME TO credential_operations;

CREATE UNIQUE INDEX idx_credential_operations_owner
    ON credential_operations(owner_kind, owner_id);

CREATE TABLE ocr_services (
    id                          TEXT PRIMARY KEY,
    provider_type               TEXT NOT NULL
                                CHECK (provider_type IN ('baidu', 'ai')),
    display_name                TEXT NOT NULL,
    enabled                     INTEGER NOT NULL DEFAULT 1
                                CHECK (enabled IN (0, 1)),
    sort_order                  INTEGER NOT NULL CHECK (sort_order >= 0),
    -- Baidu-only (NULL for ai)
    baidu_action                TEXT
                                CHECK (
                                  baidu_action IS NULL OR baidu_action IN (
                                    'accurate',
                                    'accurate_basic',
                                    'general',
                                    'general_basic'
                                  )
                                ),
    api_key_ref                 TEXT,
    secret_key_ref              TEXT,
    -- AI-only (NULL for baidu)
    provider_model_id           TEXT,
    temperature                 REAL
                                CHECK (temperature IS NULL OR temperature >= 0),
    default_prompt_template_id  TEXT,
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL,
    CHECK (
      (provider_type = 'baidu'
        AND baidu_action IS NOT NULL
        AND provider_model_id IS NULL
        AND temperature IS NULL
        AND default_prompt_template_id IS NULL)
      OR
      (provider_type = 'ai'
        AND baidu_action IS NULL
        AND api_key_ref IS NULL
        AND secret_key_ref IS NULL
        AND provider_model_id IS NOT NULL
        AND default_prompt_template_id IS NOT NULL)
    )
);

CREATE INDEX idx_ocr_services_sort
    ON ocr_services(sort_order ASC, created_at ASC, id ASC);

CREATE TABLE ocr_prompt_templates (
    id                          TEXT PRIMARY KEY,
    ocr_service_id              TEXT NOT NULL,
    name                        TEXT NOT NULL,
    system_template             TEXT NOT NULL,
    user_template               TEXT NOT NULL,
    sort_order                  INTEGER NOT NULL CHECK (sort_order >= 0),
    FOREIGN KEY (ocr_service_id)
        REFERENCES ocr_services(id) ON DELETE CASCADE,
    UNIQUE (ocr_service_id, sort_order)
);

CREATE INDEX idx_ocr_prompt_templates_service
    ON ocr_prompt_templates(ocr_service_id, sort_order ASC);
