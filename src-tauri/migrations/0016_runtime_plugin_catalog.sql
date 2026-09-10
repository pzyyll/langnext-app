-- ABOUTME: Fresh-only plugin catalog schema: user archives, explicit defaults, instance pins,
-- ABOUTME: execution grants, endpoint trust, provider bindings, and model resources.
-- ABOUTME: No publisher, signature, approval, or default-activation objects exist.

-- ---------------------------------------------------------------------------
-- User-installed Wasm archive content. Built-in and development content is
-- discovered from application resources or an explicit debug directory at
-- startup; it is never stored in the database. Publisher identity is unknown
-- for user content and is not recorded.
-- ---------------------------------------------------------------------------
CREATE TABLE plugin_user_archives (
    content_digest              TEXT PRIMARY KEY,
    plugin_id                   TEXT NOT NULL,
    version                     TEXT NOT NULL,
    runtime_kind                TEXT NOT NULL
                                CHECK (runtime_kind = 'wasm-component'),
    manifest_json               TEXT NOT NULL,
    permission_request_digest   TEXT NOT NULL,
    file_name                   TEXT NOT NULL UNIQUE,
    installed_at                TEXT NOT NULL,
    UNIQUE (plugin_id, version)
);

CREATE INDEX idx_plugin_user_archives_plugin
    ON plugin_user_archives(plugin_id);

-- ---------------------------------------------------------------------------
-- Explicit user default override: plugin id plus one exact content digest.
-- Built-in content needs no row; a missing row falls back to the built-in
-- default. Existing instance and provider digest pins never follow this value.
-- ---------------------------------------------------------------------------
CREATE TABLE plugin_default_overrides (
    plugin_id                   TEXT PRIMARY KEY,
    content_digest              TEXT NOT NULL,
    updated_at                  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Execution grant sets: instance/provider authority entries. Grant lookups
-- never consult a package approval (the concept no longer exists) and a
-- grant-set id can never be satisfied by any other identity.
-- ---------------------------------------------------------------------------
CREATE TABLE execution_grant_sets (
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
    UNIQUE (subject_kind, subject_id, package_digest, revision)
);

CREATE INDEX idx_execution_grant_sets_subject
    ON execution_grant_sets(subject_kind, subject_id);

CREATE INDEX idx_execution_grant_sets_package
    ON execution_grant_sets(package_digest);

-- One current grant-set revision per subject/package is enforced by application
-- CAS (the instance or provider pin) plus the unique subject/package/revision key.

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
    origin_kind             TEXT NOT NULL DEFAULT 'instance_configured'
                            CHECK (origin_kind IN (
                              'host_fixed',
                              'instance_configured',
                              'user_approved_instance'
                            )),
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
    response_body_modes     TEXT NOT NULL DEFAULT 'json',
    base_url                TEXT NOT NULL DEFAULT '',
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
-- Provider model discovery provenance: a non-null source API type keeps
-- per-interface sync snapshots independent. The empty sentinel is reserved for
-- manual/builtin rows; remote rows carry the Provider default API type.
-- ---------------------------------------------------------------------------
CREATE TABLE provider_models_new (
    id                          TEXT PRIMARY KEY,
    provider_instance_id        TEXT NOT NULL,
    model_key                   TEXT NOT NULL,
    source                      TEXT NOT NULL
                                CHECK (source IN ('remote', 'manual', 'builtin')),
    remote_display_name         TEXT,
    display_name_override       TEXT,
    enabled                     INTEGER NOT NULL DEFAULT 1
                                CHECK (enabled IN (0, 1)),
    availability                TEXT NOT NULL DEFAULT 'unknown'
                                CHECK (availability IN ('available', 'missing', 'unknown')),
    remote_metadata_json        TEXT,
    capability_overrides_json   TEXT,
    adapter_id                  TEXT,
    source_adapter_id           TEXT NOT NULL DEFAULT '',
    last_seen_at                TEXT,
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL,
    FOREIGN KEY (provider_instance_id)
        REFERENCES provider_instances(id) ON DELETE RESTRICT,
    UNIQUE (provider_instance_id, model_key, source_adapter_id)
);

INSERT INTO provider_models_new (
    id, provider_instance_id, model_key, source, remote_display_name, display_name_override,
    enabled, availability, remote_metadata_json, capability_overrides_json, adapter_id,
    source_adapter_id, last_seen_at, created_at, updated_at
)
SELECT m.id, m.provider_instance_id, m.model_key, m.source, m.remote_display_name,
       m.display_name_override, m.enabled, m.availability, m.remote_metadata_json,
       m.capability_overrides_json, m.adapter_id,
       CASE WHEN m.source = 'remote' THEN p.adapter_id ELSE '' END,
       m.last_seen_at, m.created_at, m.updated_at
FROM provider_models m
JOIN provider_instances p ON p.id = m.provider_instance_id;

DROP TABLE provider_models;
ALTER TABLE provider_models_new RENAME TO provider_models;

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

-- ---------------------------------------------------------------------------
-- Instance endpoint trust: exact normalized origin approvals bound to the
-- plugin identity and configuration fingerprint.
-- ---------------------------------------------------------------------------
CREATE TABLE integration_endpoint_trusts (
    id                              TEXT PRIMARY KEY,
    integration_instance_id         TEXT NOT NULL,
    plugin_id                       TEXT NOT NULL,
    plugin_version                  TEXT NOT NULL,
    endpoint_alias                  TEXT NOT NULL,
    normalized_origin               TEXT NOT NULL,
    configuration_fingerprint       TEXT NOT NULL,
    runtime_identity_fingerprint    TEXT NOT NULL,
    approved_at                     TEXT NOT NULL,
    FOREIGN KEY (integration_instance_id)
        REFERENCES integration_instances(id) ON DELETE CASCADE,
    UNIQUE (
      integration_instance_id,
      plugin_id,
      plugin_version,
      endpoint_alias,
      normalized_origin,
      configuration_fingerprint,
      runtime_identity_fingerprint
    )
);

CREATE INDEX idx_integration_endpoint_trusts_instance
    ON integration_endpoint_trusts(integration_instance_id);

CREATE INDEX idx_integration_endpoint_trusts_origin
    ON integration_endpoint_trusts(plugin_id, endpoint_alias, normalized_origin);

-- ---------------------------------------------------------------------------
-- Per-capability instance health.
-- ---------------------------------------------------------------------------
CREATE TABLE integration_capability_health (
  integration_instance_id TEXT NOT NULL
    REFERENCES integration_instances(id) ON DELETE CASCADE,
  capability_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'degraded')),
  error_code TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (integration_instance_id, capability_id)
);

CREATE INDEX integration_capability_health_instance_idx
  ON integration_capability_health (integration_instance_id, capability_id);

-- ---------------------------------------------------------------------------
-- Provider runtime bindings: one Wasm interface binding per adapter id with an
-- exact digest pin and grant revision.
-- ---------------------------------------------------------------------------
CREATE TABLE provider_runtime_bindings (
    provider_id                  TEXT NOT NULL,
    adapter_id                   TEXT NOT NULL,
    runtime_kind                 TEXT NOT NULL
                                 CHECK (runtime_kind = 'wasm-component'),
    package_digest               TEXT NOT NULL,
    grant_set_revision           INTEGER
                                 CHECK (
                                   grant_set_revision IS NULL OR grant_set_revision >= 1
                                 ),
    state                        TEXT NOT NULL
                                 CHECK (state IN (
                                   'active',
                                   'pending_activation',
                                   'unavailable'
                                 )),
    error_code                   TEXT,
    error_message                TEXT,
    -- Full export-format provider runtime requirement (plugin API, capability
    -- majors, adapter alias). Used for unresolved import restore; never
    -- substitutes a different digest.
    runtime_requirement_json     TEXT,
    created_at                   TEXT NOT NULL,
    updated_at                   TEXT NOT NULL,
    PRIMARY KEY (provider_id, adapter_id),
    CHECK (adapter_id <> ''),
    CHECK (
      runtime_kind = 'wasm-component'
      AND (
        (state = 'active' AND grant_set_revision IS NOT NULL)
        OR state IN ('unavailable', 'pending_activation')
      )
    ),
    FOREIGN KEY (provider_id)
        REFERENCES provider_instances(id) ON DELETE CASCADE
);

CREATE INDEX idx_provider_runtime_bindings_state
    ON provider_runtime_bindings(state);

CREATE TABLE provider_runtime_snapshot_sets (
    id                      TEXT PRIMARY KEY,
    provider_id             TEXT NOT NULL,
    -- 'provider' preserves a Provider-wide rollback scope; lifecycle snapshots
    -- are adapter-scoped and restore exactly one interface.
    scope                   TEXT NOT NULL
                            CHECK (scope IN ('provider', 'adapter')),
    created_at              TEXT NOT NULL,
    discarded_at            TEXT,
    runtime_kind            TEXT NOT NULL
                            CHECK (runtime_kind = 'wasm-component'),
    package_digest          TEXT,
    grant_set_revision      INTEGER
                            CHECK (
                              grant_set_revision IS NULL OR grant_set_revision >= 1
                            ),
    grant_set_id            TEXT,
    plugin_id               TEXT NOT NULL,
    plugin_version          TEXT NOT NULL,
    plugin_api_version      TEXT,
    capability_ids_json     TEXT NOT NULL DEFAULT '[]',
    updated_at              TEXT NOT NULL,
    FOREIGN KEY (provider_id)
        REFERENCES provider_instances(id) ON DELETE CASCADE
);

CREATE INDEX idx_provider_runtime_snapshot_sets_provider
    ON provider_runtime_snapshot_sets(provider_id);

CREATE INDEX idx_provider_runtime_snapshot_sets_active
    ON provider_runtime_snapshot_sets(provider_id, discarded_at);

CREATE TABLE provider_runtime_snapshot_bindings (
    id                      TEXT PRIMARY KEY,
    snapshot_set_id         TEXT NOT NULL,
    provider_id             TEXT NOT NULL,
    adapter_id              TEXT NOT NULL,
    runtime_kind            TEXT NOT NULL
                            CHECK (runtime_kind = 'wasm-component'),
    package_digest          TEXT,
    grant_set_revision      INTEGER
                            CHECK (
                              grant_set_revision IS NULL OR grant_set_revision >= 1
                            ),
    state                   TEXT NOT NULL
                            CHECK (state IN (
                              'active',
                              'pending_activation',
                              'unavailable'
                            )),
    error_code              TEXT,
    error_message           TEXT,
    runtime_requirement_json TEXT,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL,
    CHECK (adapter_id <> ''),
    FOREIGN KEY (snapshot_set_id)
        REFERENCES provider_runtime_snapshot_sets(id) ON DELETE CASCADE,
    FOREIGN KEY (provider_id)
        REFERENCES provider_instances(id) ON DELETE CASCADE
);

CREATE INDEX idx_provider_runtime_snapshot_bindings_set
    ON provider_runtime_snapshot_bindings(snapshot_set_id);

-- ---------------------------------------------------------------------------
-- Host-managed plugin model resources and their download journal.
-- ---------------------------------------------------------------------------
CREATE TABLE plugin_model_resources (
    model_resource_key TEXT PRIMARY KEY NOT NULL,
    package_digest TEXT NOT NULL,
    model_id TEXT NOT NULL,
    model_version TEXT NOT NULL,
    model_api_version INTEGER NOT NULL CHECK (model_api_version >= 1),
    model_set_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('missing', 'downloading', 'ready', 'failed')),
    installed_bytes INTEGER,
    content_address TEXT,
    error_code TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (package_digest, model_id)
);

CREATE INDEX idx_plugin_model_resources_package
  ON plugin_model_resources (package_digest);

CREATE TABLE plugin_model_download_operations (
    operation_id TEXT PRIMARY KEY NOT NULL,
    model_resource_key TEXT NOT NULL,
    package_digest TEXT NOT NULL,
    model_id TEXT NOT NULL,
    initiating_instance_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
      'prepared',
      'downloading',
      'verifying',
      'installing',
      'ready',
      'failed',
      'cancelled'
    )),
    bytes_downloaded INTEGER NOT NULL DEFAULT 0,
    total_bytes INTEGER NOT NULL,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (model_resource_key) REFERENCES plugin_model_resources(model_resource_key)
);

CREATE INDEX idx_plugin_model_download_ops_resource
  ON plugin_model_download_operations (model_resource_key, state);

CREATE UNIQUE INDEX idx_plugin_model_download_ops_active_unique
  ON plugin_model_download_operations (model_resource_key)
  WHERE state IN ('prepared', 'downloading', 'verifying', 'installing');
