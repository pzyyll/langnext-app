-- ABOUTME: Declare allowed broker response body modes on network grant entries.
-- ABOUTME: Legacy grants default to json-only; speech/binary grants opt into bytes/stream.

ALTER TABLE execution_grant_network_entries
    ADD COLUMN response_body_modes TEXT NOT NULL DEFAULT 'json';

-- Materialize the strict default for every pre-0020 grant.
UPDATE execution_grant_network_entries
SET response_body_modes = 'json'
WHERE response_body_modes IS NULL OR TRIM(response_body_modes) = '';
