-- ABOUTME: Adds capability-backed speech_services bound to integration instances.
-- ABOUTME: Supports Google Cloud TTS preferences with ON DELETE RESTRICT FK.

CREATE TABLE speech_services (
    id                              TEXT PRIMARY KEY,
    display_name                    TEXT NOT NULL,
    enabled                         INTEGER NOT NULL DEFAULT 1
                                    CHECK (enabled IN (0, 1)),
    sort_order                      INTEGER NOT NULL CHECK (sort_order >= 0),
    integration_instance_id         TEXT NOT NULL,
    capability_id                   TEXT NOT NULL,
    preferences_schema_version      INTEGER NOT NULL
                                    CHECK (preferences_schema_version >= 1),
    preferences_json                TEXT NOT NULL,
    created_at                      TEXT NOT NULL,
    updated_at                      TEXT NOT NULL,
    FOREIGN KEY (integration_instance_id)
        REFERENCES integration_instances(id) ON DELETE RESTRICT
);

CREATE INDEX idx_speech_services_sort
    ON speech_services(sort_order ASC, created_at ASC, id ASC);

CREATE INDEX idx_speech_services_integration_instance
    ON speech_services(integration_instance_id);
