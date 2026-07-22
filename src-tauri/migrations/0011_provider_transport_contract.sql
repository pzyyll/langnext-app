-- ABOUTME: Persist effective provider Base URL, source, and versioned auth scheme.
-- ABOUTME: Backfills from base_url_override, built-in defaults, adapter id, and credential kind.

-- SQLite cannot rename a column with constraints in place; rebuild the table.
CREATE TABLE provider_instances_new (
  id TEXT PRIMARY KEY NOT NULL,
  adapter_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  base_url_source TEXT NOT NULL CHECK (base_url_source IN ('plugin_default', 'custom')),
  auth_scheme_json TEXT NOT NULL,
  credential_kind TEXT NOT NULL CHECK (credential_kind IN ('none', 'api_key', 'bearer')),
  credential_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  proxy_mode TEXT NOT NULL DEFAULT 'inherit' CHECK (proxy_mode IN ('inherit', 'direct')),
  insecure_http_confirmed_at TEXT,
  models_synced_at TEXT,
  models_sync_status TEXT NOT NULL DEFAULT 'never' CHECK (models_sync_status IN ('never', 'ok', 'error')),
  models_sync_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  CHECK (
    (credential_kind = 'none' AND credential_ref IS NULL)
    OR (credential_kind IN ('api_key', 'bearer'))
  )
);

INSERT INTO provider_instances_new (
  id,
  adapter_id,
  display_name,
  base_url,
  base_url_source,
  auth_scheme_json,
  credential_kind,
  credential_ref,
  enabled,
  proxy_mode,
  insecure_http_confirmed_at,
  models_synced_at,
  models_sync_status,
  models_sync_error_code,
  created_at,
  updated_at,
  sort_order
)
SELECT
  id,
  adapter_id,
  display_name,
  CASE
    WHEN base_url_override IS NOT NULL AND TRIM(base_url_override) != '' THEN TRIM(base_url_override)
    WHEN adapter_id = 'openai-compatible' THEN 'https://api.openai.com/v1'
    WHEN adapter_id = 'openai-responses' THEN 'https://api.openai.com/v1'
    WHEN adapter_id = 'anthropic' THEN 'https://api.anthropic.com'
    WHEN adapter_id = 'gemini' THEN 'https://generativelanguage.googleapis.com'
    WHEN adapter_id = 'deepseek' THEN 'https://api.deepseek.com'
    ELSE 'https://invalid.local/missing-plugin-default'
  END AS base_url,
  CASE
    WHEN base_url_override IS NOT NULL AND TRIM(base_url_override) != '' THEN 'custom'
    ELSE 'plugin_default'
  END AS base_url_source,
  CASE
    WHEN adapter_id = 'anthropic' THEN '{"schemaVersion":1,"type":"header","name":"x-api-key"}'
    WHEN adapter_id = 'gemini' THEN '{"schemaVersion":1,"type":"query","name":"key"}'
    WHEN credential_kind = 'none' THEN '{"schemaVersion":1,"type":"none"}'
    ELSE '{"schemaVersion":1,"type":"bearer"}'
  END AS auth_scheme_json,
  credential_kind,
  credential_ref,
  enabled,
  proxy_mode,
  insecure_http_confirmed_at,
  models_synced_at,
  models_sync_status,
  models_sync_error_code,
  created_at,
  updated_at,
  sort_order
FROM provider_instances;

DROP TABLE provider_instances;
ALTER TABLE provider_instances_new RENAME TO provider_instances;
