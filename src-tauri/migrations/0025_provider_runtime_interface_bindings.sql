-- ABOUTME: Expands the singular v24 provider runtime binding into adapter-keyed interface bindings.
-- ABOUTME: Adds model source-API-type provenance, snapshot sets, and never guesses active routes.

-- Effective API types per provider: the provider default adapter plus every persisted
-- non-null model override. Used by every expansion below so a v24 pin becomes one row per
-- actually used interface.
CREATE TEMP TABLE provider_runtime_effective_types AS
SELECT p.id AS provider_id, p.adapter_id AS adapter_id
FROM provider_instances p
UNION
SELECT m.provider_instance_id AS provider_id, m.adapter_id AS adapter_id
FROM provider_models m
WHERE m.adapter_id IS NOT NULL AND m.adapter_id <> '';

-- 1) Rebuild provider_runtime_bindings keyed by (provider_id, adapter_id). One active
--    binding owns one API type per Provider; a package may serve several declared aliases,
--    each with an independent adapter-keyed row sharing the exact Provider/package grant.
CREATE TABLE provider_runtime_bindings_new (
    provider_id                  TEXT NOT NULL,
    adapter_id                   TEXT NOT NULL,
    runtime_kind                 TEXT NOT NULL
                                 CHECK (runtime_kind IN (
                                   'legacy-frontend-provider',
                                   'wasm-component'
                                 )),
    package_digest               TEXT,
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
    PRIMARY KEY (provider_id, adapter_id),
    CHECK (adapter_id <> ''),
    CHECK (
      (
        runtime_kind = 'legacy-frontend-provider'
        AND package_digest IS NULL
        AND grant_set_revision IS NULL
      )
      OR (
        -- Package pin: exact digest + grant revision while active; unavailable/pending
        -- activation may retain an unresolved requirement without a grant.
        runtime_kind = 'wasm-component'
        AND package_digest IS NOT NULL
        AND (
          (state = 'active' AND grant_set_revision IS NOT NULL)
          OR state IN ('unavailable', 'pending_activation')
        )
      )
    ),
    FOREIGN KEY (provider_id)
        REFERENCES provider_instances(id) ON DELETE CASCADE
);

-- Legacy v24 providers keep one active legacy binding for the Provider default API type.
-- Missing non-default bindings mean legacy execution, never a synthetic Wasm binding.
INSERT INTO provider_runtime_bindings_new (
    provider_id, adapter_id, runtime_kind, package_digest, grant_set_revision, state,
    error_code, error_message, runtime_requirement_json, created_at, updated_at
)
SELECT b.provider_id, p.adapter_id, 'legacy-frontend-provider', NULL, NULL, 'active',
       NULL, NULL, NULL, b.created_at, b.updated_at
FROM provider_runtime_bindings b
JOIN provider_instances p ON p.id = b.provider_id
WHERE b.runtime_kind = 'legacy-frontend-provider';

-- Active Wasm rows ONLY for effective v24 API types that are actually present and verified
-- as declared aliases in the installed signed manifest. Aliases of the same Provider/package
-- share the exact v24 grant revision.
INSERT INTO provider_runtime_bindings_new (
    provider_id, adapter_id, runtime_kind, package_digest, grant_set_revision, state,
    error_code, error_message, runtime_requirement_json, created_at, updated_at
)
SELECT b.provider_id, t.adapter_id, 'wasm-component', b.package_digest,
       b.grant_set_revision, 'active', NULL, NULL, b.runtime_requirement_json,
       b.created_at, b.updated_at
FROM provider_runtime_bindings b
JOIN provider_runtime_effective_types t ON t.provider_id = b.provider_id
JOIN installed_plugin_versions v ON v.package_digest = b.package_digest
JOIN json_each(v.manifest_json, '$.providerRuntime.legacyAliases') a
     ON a.value = t.adapter_id
WHERE b.runtime_kind = 'wasm-component'
  AND b.state = 'active'
  AND b.grant_set_revision IS NOT NULL;

-- Every other persisted default/override type on a Wasm-bound v24 provider (missing or
-- unverifiable manifest, historical invalid default, or a pending/unavailable pin) becomes
-- a sanitized per-type unavailable requirement requiring explicit review. The migration
-- never guesses an active route and never silently sends that model to legacy.
INSERT INTO provider_runtime_bindings_new (
    provider_id, adapter_id, runtime_kind, package_digest, grant_set_revision, state,
    error_code, error_message, runtime_requirement_json, created_at, updated_at
)
SELECT b.provider_id, t.adapter_id, 'wasm-component', b.package_digest, NULL,
       'unavailable', 'plugin_unavailable',
       'provider runtime interface is unavailable: the API type lacks positive alias evidence in the installed package manifest',
       b.runtime_requirement_json, b.created_at, b.updated_at
FROM provider_runtime_bindings b
JOIN provider_runtime_effective_types t ON t.provider_id = b.provider_id
WHERE b.runtime_kind = 'wasm-component'
  AND NOT EXISTS (
    SELECT 1
    FROM installed_plugin_versions v
    JOIN json_each(v.manifest_json, '$.providerRuntime.legacyAliases') a
         ON a.value = t.adapter_id
    WHERE v.package_digest = b.package_digest
      AND b.state = 'active'
      AND b.grant_set_revision IS NOT NULL
  );

DROP TABLE provider_runtime_bindings;
ALTER TABLE provider_runtime_bindings_new RENAME TO provider_runtime_bindings;

CREATE INDEX idx_provider_runtime_bindings_state
    ON provider_runtime_bindings(state);

-- 2) Identity-only rollback snapshots become snapshot sets: a parent keeps the historic
--    snapshot ID, Provider ID, scope, and package/grant references; adapter-keyed children
--    hold the exact binding identity that an atomic restore replays.
CREATE TABLE provider_runtime_snapshot_sets (
    id                      TEXT PRIMARY KEY,
    provider_id             TEXT NOT NULL,
    -- 'provider' preserves a v24 Provider-wide rollback scope; lifecycle snapshots are
    -- adapter-scoped and restore exactly one interface.
    scope                   TEXT NOT NULL
                            CHECK (scope IN ('provider', 'adapter')),
    created_at              TEXT NOT NULL,
    discarded_at            TEXT,
    runtime_kind            TEXT NOT NULL
                            CHECK (runtime_kind IN (
                              'legacy-frontend-provider',
                              'wasm-component'
                            )),
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
                            CHECK (runtime_kind IN (
                              'legacy-frontend-provider',
                              'wasm-component'
                            )),
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

-- Migrate every v24 snapshot as a Provider-scoped atomic set, preserving the historic ID.
INSERT INTO provider_runtime_snapshot_sets (
    id, provider_id, scope, created_at, discarded_at, runtime_kind, package_digest,
    grant_set_revision, grant_set_id, plugin_id, plugin_version, publisher_key_id,
    publisher_fingerprint, plugin_api_version, capability_ids_json, updated_at
)
SELECT id, provider_id, 'provider', created_at, discarded_at, runtime_kind, package_digest,
       grant_set_revision, grant_set_id, plugin_id, plugin_version, publisher_key_id,
       publisher_fingerprint, plugin_api_version, capability_ids_json, updated_at
FROM provider_runtime_snapshots;

-- Legacy v24 snapshots restore no active interface bindings (they carry no children).
-- Wasm v24 snapshots restore every positively evidenced alias row with the snapshot's exact
-- package/grant identity; rows without positive alias evidence become unavailable children.
INSERT INTO provider_runtime_snapshot_bindings (
    id, snapshot_set_id, provider_id, adapter_id, runtime_kind, package_digest,
    grant_set_revision, state, error_code, error_message, runtime_requirement_json,
    created_at, updated_at
)
SELECT lower(hex(randomblob(16))), s.id, s.provider_id, t.adapter_id, 'wasm-component',
       s.package_digest, s.grant_set_revision, 'active', NULL, NULL, NULL,
       s.created_at, s.updated_at
FROM provider_runtime_snapshots s
JOIN provider_runtime_effective_types t ON t.provider_id = s.provider_id
JOIN installed_plugin_versions v ON v.package_digest = s.package_digest
JOIN json_each(v.manifest_json, '$.providerRuntime.legacyAliases') a
     ON a.value = t.adapter_id
WHERE s.runtime_kind = 'wasm-component'
  AND s.grant_set_revision IS NOT NULL;

INSERT INTO provider_runtime_snapshot_bindings (
    id, snapshot_set_id, provider_id, adapter_id, runtime_kind, package_digest,
    grant_set_revision, state, error_code, error_message, runtime_requirement_json,
    created_at, updated_at
)
SELECT lower(hex(randomblob(16))), s.id, s.provider_id, t.adapter_id, 'wasm-component',
       s.package_digest, NULL, 'unavailable', 'plugin_unavailable',
       'provider runtime interface is unavailable: the API type lacks positive alias evidence in the installed package manifest',
       NULL, s.created_at, s.updated_at
FROM provider_runtime_snapshots s
JOIN provider_runtime_effective_types t ON t.provider_id = s.provider_id
WHERE s.runtime_kind = 'wasm-component'
  AND NOT EXISTS (
    SELECT 1
    FROM installed_plugin_versions v
    JOIN json_each(v.manifest_json, '$.providerRuntime.legacyAliases') a
         ON a.value = t.adapter_id
    WHERE v.package_digest = s.package_digest
      AND s.grant_set_revision IS NOT NULL
  );

DROP TABLE provider_runtime_snapshots;

-- 3) Remote model discovery provenance: a non-null source API type discriminator keeps
--    per-interface sync snapshots independent. The empty sentinel is reserved for
--    manual/builtin rows; remote rows are backfilled to the Provider default API type.
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

DROP TABLE provider_runtime_effective_types;
