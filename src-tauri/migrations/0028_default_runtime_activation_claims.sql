-- ABOUTME: Durable recovery leases for local-creation default runtime activation intents.
-- ABOUTME: Imports remain confirmation-required and never receive automatic recovery claims.

ALTER TABLE default_runtime_activation_intents
  ADD COLUMN claim_token TEXT;

ALTER TABLE default_runtime_activation_intents
  ADD COLUMN claim_expires_at TEXT;

CREATE INDEX idx_default_runtime_activation_intents_claim_recovery
  ON default_runtime_activation_intents(source, state, claim_expires_at);
