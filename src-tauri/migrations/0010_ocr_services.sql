-- ABOUTME: OCR service instances (AI) and AI OCR prompt templates.
-- ABOUTME: Secrets live in the OS vault; only opaque refs are stored here.

CREATE TABLE ocr_services (
    id                          TEXT PRIMARY KEY,
    provider_type               TEXT NOT NULL
                                CHECK (provider_type IN ('ai')),
    display_name                TEXT NOT NULL,
    enabled                     INTEGER NOT NULL DEFAULT 1
                                CHECK (enabled IN (0, 1)),
    sort_order                  INTEGER NOT NULL CHECK (sort_order >= 0),
    provider_model_id           TEXT NOT NULL,
    temperature                 REAL
                                CHECK (temperature IS NULL OR temperature >= 0),
    default_prompt_template_id  TEXT NOT NULL,
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL
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
