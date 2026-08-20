-- ABOUTME: Exact default package authorization policies and subject activation intent journal.
-- ABOUTME: Existing plugin_default_versions rows stay unauthorized until explicit confirmation.

-- Future-instance authorization template. Never an executable grant.
CREATE TABLE plugin_default_activation_policies (
    plugin_id                       TEXT PRIMARY KEY,
    package_digest                  TEXT NOT NULL,
    publisher_key_id                TEXT NOT NULL,
    publisher_fingerprint           TEXT NOT NULL,
    permission_request_digest       TEXT NOT NULL,
    approved_authority_constraints_json TEXT NOT NULL,
    approved_authority_constraints_digest TEXT NOT NULL,
    policy_source                   TEXT NOT NULL
                                    CHECK (policy_source IN (
                                      'user_confirmed',
                                      'vendor_bootstrap'
                                    )),
    created_at                      TEXT NOT NULL,
    updated_at                      TEXT NOT NULL,
    FOREIGN KEY (plugin_id)
        REFERENCES plugin_default_versions(plugin_id) ON DELETE CASCADE,
    FOREIGN KEY (package_digest)
        REFERENCES installed_plugin_versions(package_digest) ON DELETE RESTRICT,
    FOREIGN KEY (publisher_key_id)
        REFERENCES plugin_publishers(key_id) ON DELETE RESTRICT
);

CREATE INDEX idx_default_activation_policies_digest
    ON plugin_default_activation_policies(package_digest);

-- Subject activation provenance. Never stores secrets.
CREATE TABLE default_runtime_activation_intents (
    id                              TEXT PRIMARY KEY,
    subject_kind                    TEXT NOT NULL
                                    CHECK (subject_kind IN (
                                      'integration_instance',
                                      'provider_instance'
                                    )),
    subject_id                      TEXT NOT NULL,
    package_digest                  TEXT NOT NULL,
    source                          TEXT NOT NULL
                                    CHECK (source IN (
                                      'local_creation',
                                      'import_requires_confirmation'
                                    )),
    state                           TEXT NOT NULL
                                    CHECK (state IN (
                                      'pending',
                                      'confirmation_required',
                                      'activating',
                                      'completed',
                                      'failed',
                                      'cancelled'
                                    )),
    expected_config_digest          TEXT,
    expected_update_token           TEXT,
    error_code                      TEXT,
    error_message                   TEXT,
    created_at                      TEXT NOT NULL,
    updated_at                      TEXT NOT NULL,
    UNIQUE (subject_kind, subject_id),
    FOREIGN KEY (package_digest)
        REFERENCES installed_plugin_versions(package_digest) ON DELETE RESTRICT
);

CREATE INDEX idx_default_runtime_activation_intents_recovery
    ON default_runtime_activation_intents(source, state, package_digest);

CREATE INDEX idx_default_runtime_activation_intents_digest
    ON default_runtime_activation_intents(package_digest);
