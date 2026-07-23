-- ABOUTME: Service integration instances, credential slots, and slot-aware journal.
-- ABOUTME: Backfills existing credential_operations rows with slot_id = primary.

-- Rebuild credential journal: integration owner + non-null slot_id.
CREATE TABLE credential_operations_new (
    id                  TEXT PRIMARY KEY,
    owner_kind          TEXT NOT NULL
                        CHECK (owner_kind IN (
                          'provider',
                          'global_proxy',
                          'ocr_api_key',
                          'ocr_secret_key',
                          'integration'
                        )),
    owner_id            TEXT NOT NULL,
    slot_id             TEXT NOT NULL,
    expected_old_ref    TEXT,
    new_ref             TEXT,
    state               TEXT NOT NULL
                        CHECK (state IN ('prepared', 'db_committed')),
    created_at          TEXT NOT NULL
);

INSERT INTO credential_operations_new (
    id, owner_kind, owner_id, slot_id, expected_old_ref, new_ref, state, created_at
)
SELECT id, owner_kind, owner_id, 'primary', expected_old_ref, new_ref, state, created_at
FROM credential_operations;

DROP TABLE credential_operations;
ALTER TABLE credential_operations_new RENAME TO credential_operations;

CREATE UNIQUE INDEX idx_credential_operations_owner_slot
    ON credential_operations(owner_kind, owner_id, slot_id);

CREATE TABLE integration_instances (
    id                      TEXT PRIMARY KEY,
    plugin_id               TEXT NOT NULL,
    plugin_version          TEXT NOT NULL,
    display_name            TEXT NOT NULL,
    enabled                 INTEGER NOT NULL DEFAULT 1
                            CHECK (enabled IN (0, 1)),
    config_json             TEXT NOT NULL,
    config_schema_version   INTEGER NOT NULL,
    health_status           TEXT NOT NULL
                            CHECK (health_status IN (
                              'unconfigured',
                              'unvalidated',
                              'ready',
                              'degraded'
                            )),
    last_validated_at       TEXT,
    last_error_code         TEXT,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
);

CREATE INDEX idx_integration_instances_plugin
    ON integration_instances(plugin_id);

CREATE INDEX idx_integration_instances_health
    ON integration_instances(health_status);

CREATE TABLE integration_credential_bindings (
    id                          TEXT PRIMARY KEY,
    integration_instance_id     TEXT NOT NULL,
    slot_id                     TEXT NOT NULL,
    credential_ref              TEXT,
    credential_revision         INTEGER NOT NULL DEFAULT 0
                                CHECK (credential_revision >= 0),
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL,
    FOREIGN KEY (integration_instance_id)
        REFERENCES integration_instances(id) ON DELETE CASCADE,
    UNIQUE (integration_instance_id, slot_id)
);

CREATE INDEX idx_integration_credential_bindings_instance
    ON integration_credential_bindings(integration_instance_id);
