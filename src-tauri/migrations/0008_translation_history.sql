-- Translation history: one row per completed translate attempt (main Translate or Quick Translate).
-- Local runtime data only; not part of configuration import/export.
CREATE TABLE translation_history (
    id                      TEXT PRIMARY KEY,
    created_at              TEXT NOT NULL,
    source_text             TEXT NOT NULL,
    translated_text         TEXT NOT NULL DEFAULT '',
    source_lang             TEXT NOT NULL,
    target_lang             TEXT NOT NULL,
    effective_source_lang   TEXT,
    effective_target_lang   TEXT,
    model_id                TEXT,
    model_display_name      TEXT NOT NULL,
    provider_display_name   TEXT,
    profile_id              TEXT,
    profile_name            TEXT,
    status                  TEXT NOT NULL
                            CHECK (status IN ('complete', 'failed')),
    error_code              TEXT,
    error_message           TEXT,
    latency_ms              INTEGER NOT NULL DEFAULT 0
                            CHECK (latency_ms >= 0)
);

CREATE INDEX idx_translation_history_created_at
    ON translation_history(created_at DESC, id DESC);
CREATE INDEX idx_translation_history_model_id
    ON translation_history(model_id);
CREATE INDEX idx_translation_history_status
    ON translation_history(status);
CREATE INDEX idx_translation_history_effective_source
    ON translation_history(effective_source_lang);
CREATE INDEX idx_translation_history_effective_target
    ON translation_history(effective_target_lang);
