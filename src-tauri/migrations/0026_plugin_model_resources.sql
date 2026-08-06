-- ABOUTME: Host-managed plugin model resource install and download operation state.
-- ABOUTME: Stores content-addressed model metadata only; never absolute paths over IPC.

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

-- At most one in-flight download per model resource (atomic claim uniqueness).
CREATE UNIQUE INDEX idx_plugin_model_download_ops_active_unique
  ON plugin_model_download_operations (model_resource_key)
  WHERE state IN ('prepared', 'downloading', 'verifying', 'installing');
