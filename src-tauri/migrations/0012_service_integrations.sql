-- ABOUTME: Service integration instances, credential slots, and slot-aware journal.
-- ABOUTME: Backfills existing credential_operations rows with slot_id = primary.
-- ABOUTME: Instances pin one exact plugin content digest and runtime state.

-- Rebuild credential journal: integration owner + non-null slot_id.
CREATE TABLE credential_operations_new (
    id                  TEXT PRIMARY KEY,
    owner_kind          TEXT NOT NULL
                        CHECK (owner_kind IN (
                          'provider',
                          'global_proxy',
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
    id                              TEXT PRIMARY KEY,
    plugin_id                       TEXT NOT NULL,
    plugin_version                  TEXT NOT NULL,
    display_name                    TEXT NOT NULL,
    enabled                         INTEGER NOT NULL DEFAULT 1
                                    CHECK (enabled IN (0, 1)),
    config_json                     TEXT NOT NULL,
    config_schema_version           INTEGER NOT NULL,
    health_status                   TEXT NOT NULL
                                    CHECK (health_status IN (
                                      'unconfigured',
                                      'unvalidated',
                                      'ready',
                                      'degraded'
                                    )),
    last_validated_at               TEXT,
    last_error_code                 TEXT,
    runtime_kind                    TEXT NOT NULL
                                    CHECK (runtime_kind IN (
                                      'wasm-component',
                                      'trusted-native-worker'
                                    )),
    -- Nullable: an imported runtime requirement stays unresolved until the user installs
    -- the exact content digest. Every locally created instance writes a digest.
    package_digest                  TEXT,
    execution_grant_set_revision    INTEGER
                                    CHECK (
                                      execution_grant_set_revision IS NULL
                                      OR execution_grant_set_revision >= 1
                                    ),
    runtime_state                   TEXT NOT NULL
                                    CHECK (runtime_state IN (
                                      'active',
                                      'pending_activation',
                                      'unavailable'
                                    )),
    runtime_error_code              TEXT,
    runtime_error_message           TEXT,
    -- Full export-format runtime requirement (plugin API and capability majors).
    -- Used for unresolved import restore; never substitutes a different digest.
    runtime_requirement_json        TEXT,
    created_at                      TEXT NOT NULL,
    updated_at                      TEXT NOT NULL,
    CHECK (
      runtime_kind IN ('wasm-component', 'trusted-native-worker')
      AND (
        (
          runtime_state = 'active'
          AND package_digest IS NOT NULL
          AND execution_grant_set_revision IS NOT NULL
        )
        OR (
          runtime_state IN ('unavailable', 'pending_activation')
        )
      )
    )
);

CREATE INDEX idx_integration_instances_plugin
    ON integration_instances(plugin_id);

CREATE INDEX idx_integration_instances_health
    ON integration_instances(health_status);

CREATE INDEX idx_integration_instances_package
    ON integration_instances(package_digest);

CREATE INDEX idx_integration_instances_runtime
    ON integration_instances(runtime_kind, runtime_state);

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
