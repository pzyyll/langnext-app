-- ABOUTME: Instance runtime pins, grant-set authority entries, and upgrade rollback snapshots.
-- ABOUTME: Package approvals remain non-executable; only grant-set revisions authorize runtime.

-- ---------------------------------------------------------------------------
-- Extend execution_grant_sets with authority digest + plugin version.
-- Empty in production until Phase 4 issues revisions; rebuild is safe.
-- ---------------------------------------------------------------------------
CREATE TABLE execution_grant_sets_new (
    id                          TEXT PRIMARY KEY,
    revision                    INTEGER NOT NULL
                                CHECK (revision >= 1),
    subject_kind                TEXT NOT NULL
                                CHECK (subject_kind IN (
                                  'integration_instance',
                                  'provider_instance'
                                )),
    subject_id                  TEXT NOT NULL,
    plugin_id                   TEXT NOT NULL,
    plugin_version              TEXT NOT NULL,
    package_digest              TEXT NOT NULL,
    permission_request_digest   TEXT NOT NULL,
    authority_digest            TEXT NOT NULL,
    approved_at                 TEXT NOT NULL,
    UNIQUE (subject_kind, subject_id, package_digest, revision),
    FOREIGN KEY (package_digest)
        REFERENCES installed_plugin_versions(package_digest) ON DELETE RESTRICT
);

INSERT INTO execution_grant_sets_new (
    id, revision, subject_kind, subject_id, plugin_id, plugin_version,
    package_digest, permission_request_digest, authority_digest, approved_at
)
SELECT
    id,
    revision,
    subject_kind,
    subject_id,
    plugin_id,
    '0.0.0',
    package_digest,
    permission_request_digest,
    permission_request_digest,
    approved_at
FROM execution_grant_sets;

DROP TABLE execution_grant_sets;
ALTER TABLE execution_grant_sets_new RENAME TO execution_grant_sets;

CREATE INDEX idx_execution_grant_sets_subject
    ON execution_grant_sets(subject_kind, subject_id);

CREATE INDEX idx_execution_grant_sets_package
    ON execution_grant_sets(package_digest);

-- One current grant-set revision per subject/package is enforced by application CAS
-- (instance pin) and the unique (subject, package, revision) constraint.

CREATE TABLE execution_grant_capability_entries (
    id                  TEXT PRIMARY KEY,
    grant_set_id        TEXT NOT NULL,
    capability_id       TEXT NOT NULL,
    UNIQUE (grant_set_id, capability_id),
    FOREIGN KEY (grant_set_id)
        REFERENCES execution_grant_sets(id) ON DELETE CASCADE
);

CREATE INDEX idx_execution_grant_capability_entries_grant
    ON execution_grant_capability_entries(grant_set_id);

CREATE TABLE execution_grant_network_entries (
    id                      TEXT PRIMARY KEY,
    grant_set_id            TEXT NOT NULL,
    capability_id           TEXT NOT NULL,
    endpoint_id             TEXT NOT NULL,
    origin                  TEXT NOT NULL,
    method                  TEXT NOT NULL,
    auth_policy             TEXT NOT NULL,
    resource_mode           TEXT NOT NULL DEFAULT 'bounded'
                            CHECK (resource_mode IN ('bounded')),
    max_request_bytes       INTEGER NOT NULL
                            CHECK (max_request_bytes > 0),
    max_response_bytes      INTEGER NOT NULL
                            CHECK (max_response_bytes > 0),
    max_stream_bytes        INTEGER NOT NULL
                            CHECK (max_stream_bytes > 0),
    timeout_ms              INTEGER NOT NULL
                            CHECK (timeout_ms > 0),
    UNIQUE (
      grant_set_id,
      capability_id,
      endpoint_id,
      origin,
      method,
      auth_policy,
      resource_mode
    ),
    FOREIGN KEY (grant_set_id)
        REFERENCES execution_grant_sets(id) ON DELETE CASCADE
);

CREATE INDEX idx_execution_grant_network_entries_grant
    ON execution_grant_network_entries(grant_set_id);

-- Page authority remains empty until Phase 9 explicit approval.
CREATE TABLE execution_grant_page_entries (
    id                                  TEXT PRIMARY KEY,
    grant_set_id                        TEXT NOT NULL,
    page_id                             TEXT NOT NULL,
    allowed_actions_json                TEXT NOT NULL,
    delegated_capability_majors_json    TEXT NOT NULL DEFAULT '[]',
    delegated_endpoint_aliases_json     TEXT NOT NULL DEFAULT '[]',
    UNIQUE (grant_set_id, page_id),
    FOREIGN KEY (grant_set_id)
        REFERENCES execution_grant_sets(id) ON DELETE CASCADE
);

CREATE INDEX idx_execution_grant_page_entries_grant
    ON execution_grant_page_entries(grant_set_id);

-- ---------------------------------------------------------------------------
-- Pin every integration instance to one exact runtime identity.
-- ---------------------------------------------------------------------------
CREATE TABLE integration_instances_new (
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
                                      'bundled-rust',
                                      'wasm-component',
                                      'legacy-frontend-provider',
                                      'trusted-native-worker'
                                    )),
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
    -- Full export-format runtime requirement (publisher fingerprint, API, capability majors).
    -- Used for unresolved import restore; never substitutes a different package identity.
    runtime_requirement_json        TEXT,
    created_at                      TEXT NOT NULL,
    updated_at                      TEXT NOT NULL,
    CHECK (
      (
        runtime_kind = 'bundled-rust'
        AND package_digest IS NULL
        AND execution_grant_set_revision IS NULL
      )
      OR (
        -- Active package pin: exact digest + grant revision. Digest is soft-referenced so a
        -- missing package can still preserve the unresolved requirement without FK failure.
        runtime_kind IN ('wasm-component', 'trusted-native-worker')
        AND package_digest IS NOT NULL
        AND (
          (
            runtime_state = 'active'
            AND execution_grant_set_revision IS NOT NULL
          )
          OR (
            runtime_state IN ('unavailable', 'pending_activation')
          )
        )
      )
      OR (
        runtime_kind = 'legacy-frontend-provider'
      )
    )
);

INSERT INTO integration_instances_new (
    id, plugin_id, plugin_version, display_name, enabled,
    config_json, config_schema_version, health_status,
    last_validated_at, last_error_code,
    runtime_kind, package_digest, execution_grant_set_revision,
    runtime_state, runtime_error_code, runtime_error_message,
    runtime_requirement_json,
    created_at, updated_at
)
SELECT
    id, plugin_id, plugin_version, display_name, enabled,
    config_json, config_schema_version, health_status,
    last_validated_at, last_error_code,
    'bundled-rust', NULL, NULL,
    'active', NULL, NULL,
    NULL,
    created_at, updated_at
FROM integration_instances;

DROP TABLE integration_instances;
ALTER TABLE integration_instances_new RENAME TO integration_instances;

CREATE INDEX idx_integration_instances_plugin
    ON integration_instances(plugin_id);

CREATE INDEX idx_integration_instances_health
    ON integration_instances(health_status);

CREATE INDEX idx_integration_instances_package
    ON integration_instances(package_digest);

CREATE INDEX idx_integration_instances_runtime
    ON integration_instances(runtime_kind, runtime_state);

-- ---------------------------------------------------------------------------
-- Host-owned rollback snapshots (no secrets / credential refs).
-- ---------------------------------------------------------------------------
CREATE TABLE plugin_upgrade_snapshots (
    id                              TEXT PRIMARY KEY,
    integration_instance_id         TEXT NOT NULL,
    created_at                      TEXT NOT NULL,
    discarded_at                    TEXT,
    runtime_kind                    TEXT NOT NULL,
    package_digest                  TEXT,
    execution_grant_set_id          TEXT,
    execution_grant_set_revision    INTEGER,
    plugin_version                  TEXT NOT NULL,
    config_json                     TEXT NOT NULL,
    config_schema_version           INTEGER NOT NULL,
    grant_snapshot_json             TEXT,
    translation_preferences_json    TEXT NOT NULL DEFAULT '[]',
    ocr_preferences_json            TEXT NOT NULL DEFAULT '[]',
    speech_preferences_json         TEXT NOT NULL DEFAULT '[]',
    FOREIGN KEY (integration_instance_id)
        REFERENCES integration_instances(id) ON DELETE CASCADE
);

CREATE INDEX idx_plugin_upgrade_snapshots_instance
    ON plugin_upgrade_snapshots(integration_instance_id);

CREATE INDEX idx_plugin_upgrade_snapshots_active
    ON plugin_upgrade_snapshots(integration_instance_id, discarded_at);
