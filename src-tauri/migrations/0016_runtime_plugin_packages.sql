-- ABOUTME: Plugin publishers, installed packages, package approvals, install journal, and defaults.
-- ABOUTME: Package approval is non-executable; execution_grant_sets is reserved for Phase 4.

CREATE TABLE plugin_publishers (
    key_id              TEXT PRIMARY KEY,
    fingerprint         TEXT NOT NULL UNIQUE,
    public_key_hex      TEXT NOT NULL,
    source              TEXT NOT NULL
                        CHECK (source IN ('vendor', 'user_approved')),
    enabled             INTEGER NOT NULL DEFAULT 1
                        CHECK (enabled IN (0, 1)),
    revoked             INTEGER NOT NULL DEFAULT 0
                        CHECK (revoked IN (0, 1)),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE INDEX idx_plugin_publishers_fingerprint
    ON plugin_publishers(fingerprint);

CREATE TABLE installed_plugin_versions (
    package_digest              TEXT PRIMARY KEY,
    plugin_id                   TEXT NOT NULL,
    version                     TEXT NOT NULL,
    publisher_key_id            TEXT NOT NULL,
    publisher_fingerprint       TEXT NOT NULL,
    runtime_kind                TEXT NOT NULL,
    manifest_json               TEXT NOT NULL,
    permission_request_digest   TEXT NOT NULL,
    content_available           INTEGER NOT NULL DEFAULT 1
                                CHECK (content_available IN (0, 1)),
    installed_at                TEXT NOT NULL,
    UNIQUE (plugin_id, version),
    FOREIGN KEY (publisher_key_id)
        REFERENCES plugin_publishers(key_id) ON DELETE RESTRICT
);

CREATE INDEX idx_installed_plugin_versions_plugin
    ON installed_plugin_versions(plugin_id);

CREATE TABLE plugin_package_approvals (
    id                          TEXT PRIMARY KEY,
    package_digest              TEXT NOT NULL,
    revision                    INTEGER NOT NULL
                                CHECK (revision >= 1),
    publisher_key_id            TEXT NOT NULL,
    publisher_decision          TEXT NOT NULL
                                CHECK (publisher_decision IN (
                                  'trusted_vendor',
                                  'user_approved',
                                  'already_trusted'
                                )),
    permission_request_digest   TEXT NOT NULL,
    approved_at                 TEXT NOT NULL,
    UNIQUE (package_digest, revision),
    FOREIGN KEY (package_digest)
        REFERENCES installed_plugin_versions(package_digest) ON DELETE RESTRICT,
    FOREIGN KEY (publisher_key_id)
        REFERENCES plugin_publishers(key_id) ON DELETE RESTRICT
);

CREATE INDEX idx_plugin_package_approvals_digest
    ON plugin_package_approvals(package_digest);

CREATE TABLE plugin_default_versions (
    plugin_id           TEXT PRIMARY KEY,
    package_digest      TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    FOREIGN KEY (package_digest)
        REFERENCES installed_plugin_versions(package_digest) ON DELETE RESTRICT
);

CREATE TABLE plugin_install_operations (
    id                  TEXT PRIMARY KEY,
    package_digest      TEXT,
    staging_path        TEXT NOT NULL,
    state               TEXT NOT NULL
                        CHECK (state IN (
                          'prepared',
                          'verified',
                          'db_committed',
                          'finalized',
                          'failed'
                        )),
    error_code          TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE INDEX idx_plugin_install_operations_state
    ON plugin_install_operations(state);

-- Crash-safe uninstall journal: quarantine content before catalog delete; recover either side.
CREATE TABLE plugin_uninstall_operations (
    id                  TEXT PRIMARY KEY,
    package_digest      TEXT NOT NULL,
    quarantine_path     TEXT,
    state               TEXT NOT NULL
                        CHECK (state IN (
                          'prepared',
                          'content_quarantined',
                          'catalog_deleted',
                          'finalized',
                          'failed'
                        )),
    error_code          TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE INDEX idx_plugin_uninstall_operations_state
    ON plugin_uninstall_operations(state);

CREATE INDEX idx_plugin_uninstall_operations_digest
    ON plugin_uninstall_operations(package_digest);

-- Reserved for Phase 4 execution authority. Distinct from package approvals:
-- package approval IDs must never satisfy an execution-grant-set lookup.
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
    package_digest              TEXT NOT NULL,
    permission_request_digest   TEXT NOT NULL,
    approved_at                 TEXT NOT NULL,
    UNIQUE (subject_kind, subject_id, package_digest, revision),
    FOREIGN KEY (package_digest)
        REFERENCES installed_plugin_versions(package_digest) ON DELETE RESTRICT
);

CREATE INDEX idx_execution_grant_sets_subject
    ON execution_grant_sets(subject_kind, subject_id);
