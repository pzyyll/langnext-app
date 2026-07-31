-- ABOUTME: Persist exact, user-approved integration endpoint base URLs without secrets or DNS answers.
-- ABOUTME: Approval rows bind an instance, endpoint, complete normalized base URL, config, and runtime identity.

-- Extend the closed origin provenance enum for package-backed user approvals.
DROP INDEX idx_execution_grant_network_entries_grant;
ALTER TABLE execution_grant_network_entries RENAME TO execution_grant_network_entries_old;

CREATE TABLE execution_grant_network_entries (
    id                      TEXT PRIMARY KEY,
    grant_set_id            TEXT NOT NULL,
    capability_id           TEXT NOT NULL,
    endpoint_id             TEXT NOT NULL,
    origin                  TEXT NOT NULL,
    origin_kind             TEXT NOT NULL DEFAULT 'instance_configured'
                            CHECK (origin_kind IN ('host_fixed', 'instance_configured', 'user_approved_instance')),
    method                  TEXT NOT NULL,
    auth_policy             TEXT NOT NULL,
    resource_mode           TEXT NOT NULL DEFAULT 'bounded'
                            CHECK (resource_mode IN ('bounded')),
    max_request_bytes       INTEGER NOT NULL CHECK (max_request_bytes > 0),
    max_response_bytes      INTEGER NOT NULL CHECK (max_response_bytes > 0),
    max_stream_bytes        INTEGER NOT NULL CHECK (max_stream_bytes > 0),
    timeout_ms              INTEGER NOT NULL CHECK (timeout_ms > 0),
    response_body_modes     TEXT NOT NULL DEFAULT 'json',
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

INSERT INTO execution_grant_network_entries (
    id, grant_set_id, capability_id, endpoint_id, origin, origin_kind, method, auth_policy,
    resource_mode, max_request_bytes, max_response_bytes, max_stream_bytes, timeout_ms,
    response_body_modes
)
SELECT
    id, grant_set_id, capability_id, endpoint_id, origin, origin_kind, method, auth_policy,
    resource_mode, max_request_bytes, max_response_bytes, max_stream_bytes, timeout_ms,
    response_body_modes
FROM execution_grant_network_entries_old;

DROP TABLE execution_grant_network_entries_old;

CREATE INDEX idx_execution_grant_network_entries_grant
    ON execution_grant_network_entries(grant_set_id);

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
