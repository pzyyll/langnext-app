-- ABOUTME: Exact additive subject authority approvals for default-package activation.
-- ABOUTME: Local trust only; never secrets; one live approval per subject/config/package/policy binding.

-- Additive instance authority beyond the default policy ceiling.
-- Bound to subject, package, normalized config, subject update token, and policy constraints.
CREATE TABLE default_runtime_authority_approvals (
    id                              TEXT PRIMARY KEY,
    subject_kind                    TEXT NOT NULL
                                    CHECK (subject_kind IN (
                                      'integration_instance',
                                      'provider_instance'
                                    )),
    subject_id                      TEXT NOT NULL,
    package_digest                  TEXT NOT NULL,
    config_digest                   TEXT NOT NULL,
    subject_update_token            TEXT NOT NULL,
    policy_constraints_digest       TEXT NOT NULL,
    approved_authority_json         TEXT NOT NULL,
    approved_authority_digest       TEXT NOT NULL,
    created_at                      TEXT NOT NULL,
    updated_at                      TEXT NOT NULL,
    FOREIGN KEY (package_digest)
        REFERENCES installed_plugin_versions(package_digest) ON DELETE RESTRICT
);

-- One live approval per exact subject/config/package/policy binding.
CREATE UNIQUE INDEX idx_default_runtime_authority_approvals_binding
    ON default_runtime_authority_approvals(
      subject_kind,
      subject_id,
      package_digest,
      config_digest,
      subject_update_token,
      policy_constraints_digest
    );

CREATE INDEX idx_default_runtime_authority_approvals_subject
    ON default_runtime_authority_approvals(subject_kind, subject_id);
