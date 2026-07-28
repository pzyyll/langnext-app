-- Uninstall journal terminal success states: restored / rolled_back (no permanent failed replay).
-- Rebuild table so CHECK constraint accepts the new closed set.

CREATE TABLE plugin_uninstall_operations_new (
    id                  TEXT PRIMARY KEY,
    package_digest      TEXT NOT NULL,
    quarantine_path     TEXT,
    state               TEXT NOT NULL
                        CHECK (state IN (
                          'prepared',
                          'content_quarantined',
                          'catalog_deleted',
                          'finalized',
                          'failed',
                          'restored',
                          'rolled_back'
                        )),
    error_code          TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

INSERT INTO plugin_uninstall_operations_new (
    id, package_digest, quarantine_path, state, error_code, created_at, updated_at
)
SELECT id, package_digest, quarantine_path, state, error_code, created_at, updated_at
FROM plugin_uninstall_operations;

DROP TABLE plugin_uninstall_operations;
ALTER TABLE plugin_uninstall_operations_new RENAME TO plugin_uninstall_operations;

CREATE INDEX idx_plugin_uninstall_operations_state
    ON plugin_uninstall_operations(state);

CREATE INDEX idx_plugin_uninstall_operations_digest
    ON plugin_uninstall_operations(package_digest);
