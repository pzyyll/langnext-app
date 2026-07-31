-- ABOUTME: Persist complete canonical endpoint base URLs in runtime grants.
-- ABOUTME: Wasm joins the fixed capability path under this host-sealed base URL.

ALTER TABLE execution_grant_network_entries
  ADD COLUMN base_url TEXT NOT NULL DEFAULT '';

UPDATE execution_grant_network_entries
SET base_url = origin
WHERE base_url = '';
