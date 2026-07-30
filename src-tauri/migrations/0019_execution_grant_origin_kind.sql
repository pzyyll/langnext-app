-- ABOUTME: Seal manifest-derived network origin provenance into persisted execution grants.
-- ABOUTME: Legacy grants default to strict dynamic handling until a new reviewed grant is issued.

ALTER TABLE execution_grant_network_entries
    ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'instance_configured'
    CHECK (origin_kind IN ('host_fixed', 'instance_configured'));

-- Materialize the strict default for every pre-0019 grant. None may inherit host-fixed handling.
UPDATE execution_grant_network_entries
SET origin_kind = 'instance_configured';
