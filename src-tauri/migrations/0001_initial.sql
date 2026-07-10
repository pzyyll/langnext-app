-- ABOUTME: Initial portable configuration and credential-operation schema.
-- ABOUTME: Applied once via PRAGMA user_version; never edit after a released build.

CREATE TABLE provider_instances (
    id                          TEXT PRIMARY KEY,
    adapter_id                  TEXT NOT NULL,
    display_name                TEXT NOT NULL,
    base_url_override           TEXT,
    credential_kind             TEXT NOT NULL
                                CHECK (credential_kind IN ('none', 'api_key', 'bearer')),
    credential_ref              TEXT,
    enabled                     INTEGER NOT NULL DEFAULT 1
                                CHECK (enabled IN (0, 1)),
    proxy_mode                  TEXT NOT NULL DEFAULT 'inherit'
                                CHECK (proxy_mode IN ('inherit', 'direct')),
    insecure_http_confirmed_at  TEXT,
    models_synced_at            TEXT,
    models_sync_status          TEXT NOT NULL DEFAULT 'never'
                                CHECK (models_sync_status IN ('never', 'ok', 'error')),
    models_sync_error_code      TEXT,
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL,
    -- non-none Providers may have a null reference (needs authentication).
    CHECK (credential_kind <> 'none' OR credential_ref IS NULL)
);

CREATE TABLE provider_models (
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
    last_seen_at                TEXT,
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL,
    FOREIGN KEY (provider_instance_id)
        REFERENCES provider_instances(id) ON DELETE RESTRICT,
    UNIQUE (provider_instance_id, model_key)
);

CREATE TABLE translation_profiles (
    id                          TEXT PRIMARY KEY,
    name                        TEXT NOT NULL,
    enabled                     INTEGER NOT NULL DEFAULT 1
                                CHECK (enabled IN (0, 1)),
    template_version            INTEGER NOT NULL,
    system_template             TEXT NOT NULL,
    user_template               TEXT NOT NULL,
    temperature                 REAL,
    max_output_tokens           INTEGER,
    provider_options_json       TEXT,
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL,
    CHECK (temperature IS NULL OR temperature >= 0),
    CHECK (max_output_tokens IS NULL OR max_output_tokens > 0)
);

CREATE TABLE translation_profile_models (
    translation_profile_id      TEXT NOT NULL,
    provider_model_id           TEXT NOT NULL,
    priority                    INTEGER NOT NULL CHECK (priority >= 0),
    PRIMARY KEY (translation_profile_id, provider_model_id),
    UNIQUE (translation_profile_id, priority),
    FOREIGN KEY (translation_profile_id)
        REFERENCES translation_profiles(id) ON DELETE CASCADE,
    FOREIGN KEY (provider_model_id)
        REFERENCES provider_models(id) ON DELETE RESTRICT
);

CREATE TABLE app_settings (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version  INTEGER NOT NULL,
    value_json      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- Internal: global proxy credential binding (never exported).
CREATE TABLE app_credentials (
    slot            TEXT PRIMARY KEY,
    credential_ref  TEXT,
    updated_at      TEXT NOT NULL
);

-- Internal: crash-recovery journal for credential mutations (never exported).
CREATE TABLE credential_operations (
    id                  TEXT PRIMARY KEY,
    owner_kind          TEXT NOT NULL
                        CHECK (owner_kind IN ('provider', 'global_proxy')),
    owner_id            TEXT NOT NULL,
    expected_old_ref    TEXT,
    new_ref             TEXT,
    state               TEXT NOT NULL
                        CHECK (state IN ('prepared', 'db_committed')),
    created_at          TEXT NOT NULL
);

-- Only one unfinished mutation per owner.
CREATE UNIQUE INDEX idx_credential_operations_owner
    ON credential_operations(owner_kind, owner_id);

INSERT INTO app_settings (id, schema_version, value_json, updated_at)
VALUES (
    1,
    1,
    '{"schemaVersion":1,"uiLanguage":"en","theme":null,"defaultProfileId":null,"translation":{"autoDetectSource":true,"preserveFormatting":true},"shortcuts":[],"network":{"proxyMode":"system","proxyUrl":null}}',
    '1970-01-01T00:00:00Z'
);

INSERT INTO app_credentials (slot, credential_ref, updated_at)
VALUES ('global_proxy', NULL, '1970-01-01T00:00:00Z');
