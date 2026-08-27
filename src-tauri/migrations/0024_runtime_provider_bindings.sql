-- ABOUTME: One-to-one package-only provider runtime bindings and identity-only rollback snapshots.
-- ABOUTME: Empty on a fresh database; never backfills unsupported runtime kinds.

-- One authoritative runtime binding per provider instance. Provider UUIDs, transport fields,
-- models, profiles, credential references, and history rows are never rewritten.
CREATE TABLE provider_runtime_bindings (
    provider_id                  TEXT PRIMARY KEY,
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
    -- Full export-format provider runtime requirement (publisher fingerprint, API,
    -- capability majors, legacy alias). Used for unresolved import restore; never
    -- substitutes a different package identity.
    runtime_requirement_json     TEXT,
    created_at                   TEXT NOT NULL,
    updated_at                   TEXT NOT NULL,
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

-- Identity-only rollback snapshots: no config, credentials, grants, or secret material.
CREATE TABLE provider_runtime_snapshots (
    id                      TEXT PRIMARY KEY,
    provider_id             TEXT NOT NULL,
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
    publisher_key_id        TEXT,
    publisher_fingerprint   TEXT,
    plugin_api_version      TEXT,
    capability_ids_json     TEXT NOT NULL DEFAULT '[]',
    updated_at              TEXT NOT NULL,
    FOREIGN KEY (provider_id)
        REFERENCES provider_runtime_bindings(provider_id) ON DELETE CASCADE
);

CREATE INDEX idx_provider_runtime_snapshots_provider
    ON provider_runtime_snapshots(provider_id);

CREATE INDEX idx_provider_runtime_snapshots_active
    ON provider_runtime_snapshots(provider_id, discarded_at);
