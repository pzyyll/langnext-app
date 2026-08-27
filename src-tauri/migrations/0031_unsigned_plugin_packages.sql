-- ABOUTME: Persist package signature status, nullable publisher identity, and exact-digest risk acks.
-- ABOUTME: Existing signed rows backfill as signed; vendor bootstrap policies stay signed-only.

CREATE TABLE installed_plugin_versions_v31 (
    package_digest              TEXT PRIMARY KEY,
    plugin_id                   TEXT NOT NULL,
    version                     TEXT NOT NULL,
    publisher_key_id            TEXT,
    publisher_fingerprint       TEXT,
    signature_status            TEXT NOT NULL
                                CHECK (signature_status IN ('signed', 'unsigned')),
    runtime_kind                TEXT NOT NULL,
    manifest_json               TEXT NOT NULL,
    permission_request_digest   TEXT NOT NULL,
    content_available           INTEGER NOT NULL DEFAULT 1
                                CHECK (content_available IN (0, 1)),
    installed_at                TEXT NOT NULL,
    UNIQUE (plugin_id, version),
    CHECK (
      (
        signature_status = 'signed'
        AND publisher_key_id IS NOT NULL
        AND publisher_fingerprint IS NOT NULL
      )
      OR (
        signature_status = 'unsigned'
        AND publisher_key_id IS NULL
        AND publisher_fingerprint IS NULL
      )
    ),
    FOREIGN KEY (publisher_key_id)
        REFERENCES plugin_publishers(key_id) ON DELETE RESTRICT
);

INSERT INTO installed_plugin_versions_v31 (
    package_digest, plugin_id, version, publisher_key_id, publisher_fingerprint,
    signature_status, runtime_kind, manifest_json, permission_request_digest,
    content_available, installed_at
)
SELECT
    package_digest, plugin_id, version, publisher_key_id, publisher_fingerprint,
    'signed', runtime_kind, manifest_json, permission_request_digest,
    content_available, installed_at
FROM installed_plugin_versions;

DROP TABLE installed_plugin_versions;
ALTER TABLE installed_plugin_versions_v31 RENAME TO installed_plugin_versions;

CREATE INDEX idx_installed_plugin_versions_plugin
    ON installed_plugin_versions(plugin_id);

CREATE TABLE plugin_package_approvals_v31 (
    id                          TEXT PRIMARY KEY,
    package_digest              TEXT NOT NULL,
    revision                    INTEGER NOT NULL
                                CHECK (revision >= 1),
    publisher_key_id            TEXT,
    publisher_decision          TEXT NOT NULL
                                CHECK (publisher_decision IN (
                                  'trusted_vendor',
                                  'user_approved',
                                  'already_trusted',
                                  'unsigned_exact_digest'
                                )),
    signature_status            TEXT NOT NULL
                                CHECK (signature_status IN ('signed', 'unsigned')),
    unsigned_risk_acknowledged  INTEGER NOT NULL DEFAULT 0
                                CHECK (unsigned_risk_acknowledged IN (0, 1)),
    native_execution_risk_acknowledged INTEGER NOT NULL DEFAULT 0
                                CHECK (native_execution_risk_acknowledged IN (0, 1)),
    risk_acknowledgement_version TEXT,
    permission_request_digest   TEXT NOT NULL,
    approved_at                 TEXT NOT NULL,
    UNIQUE (package_digest, revision),
    FOREIGN KEY (package_digest)
        REFERENCES installed_plugin_versions(package_digest) ON DELETE RESTRICT,
    FOREIGN KEY (publisher_key_id)
        REFERENCES plugin_publishers(key_id) ON DELETE RESTRICT
);

INSERT INTO plugin_package_approvals_v31 (
    id, package_digest, revision, publisher_key_id, publisher_decision,
    signature_status, unsigned_risk_acknowledged, native_execution_risk_acknowledged,
    risk_acknowledgement_version, permission_request_digest, approved_at
)
SELECT
    id, package_digest, revision, publisher_key_id, publisher_decision,
    'signed', 0, 0, NULL, permission_request_digest, approved_at
FROM plugin_package_approvals;

DROP TABLE plugin_package_approvals;
ALTER TABLE plugin_package_approvals_v31 RENAME TO plugin_package_approvals;

CREATE INDEX idx_plugin_package_approvals_digest
    ON plugin_package_approvals(package_digest);

CREATE TABLE plugin_default_activation_policies_v31 (
    plugin_id                       TEXT PRIMARY KEY,
    package_digest                  TEXT NOT NULL,
    publisher_key_id                TEXT,
    publisher_fingerprint           TEXT,
    signature_status                TEXT NOT NULL
                                    CHECK (signature_status IN ('signed', 'unsigned')),
    unsigned_default_risk_acknowledgement_version TEXT,
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
    CHECK (
      (
        signature_status = 'signed'
        AND publisher_key_id IS NOT NULL
        AND publisher_fingerprint IS NOT NULL
      )
      OR (
        signature_status = 'unsigned'
        AND policy_source = 'user_confirmed'
        AND publisher_key_id IS NULL
        AND publisher_fingerprint IS NULL
      )
    ),
    CHECK (
      policy_source != 'vendor_bootstrap' OR signature_status = 'signed'
    ),
    FOREIGN KEY (plugin_id)
        REFERENCES plugin_default_versions(plugin_id) ON DELETE CASCADE,
    FOREIGN KEY (package_digest)
        REFERENCES installed_plugin_versions(package_digest) ON DELETE RESTRICT,
    FOREIGN KEY (publisher_key_id)
        REFERENCES plugin_publishers(key_id) ON DELETE RESTRICT
);

INSERT INTO plugin_default_activation_policies_v31 (
    plugin_id, package_digest, publisher_key_id, publisher_fingerprint, signature_status,
    unsigned_default_risk_acknowledgement_version, permission_request_digest,
    approved_authority_constraints_json, approved_authority_constraints_digest,
    policy_source, created_at, updated_at
)
SELECT
    plugin_id, package_digest, publisher_key_id, publisher_fingerprint, 'signed',
    NULL, permission_request_digest,
    approved_authority_constraints_json, approved_authority_constraints_digest,
    policy_source, created_at, updated_at
FROM plugin_default_activation_policies;

DROP TABLE plugin_default_activation_policies;
ALTER TABLE plugin_default_activation_policies_v31 RENAME TO plugin_default_activation_policies;

CREATE INDEX idx_default_activation_policies_digest
    ON plugin_default_activation_policies(package_digest);
