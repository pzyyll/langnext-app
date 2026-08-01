-- ABOUTME: Store the latest sanitized health result for each integration capability major.
-- ABOUTME: Health rows are independent and cascade with their host-owned integration instance.

CREATE TABLE integration_capability_health (
  integration_instance_id TEXT NOT NULL
    REFERENCES integration_instances(id) ON DELETE CASCADE,
  capability_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'degraded')),
  error_code TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (integration_instance_id, capability_id)
);

CREATE INDEX integration_capability_health_instance_idx
  ON integration_capability_health (integration_instance_id, capability_id);
