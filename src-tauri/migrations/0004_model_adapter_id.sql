-- Optional per-model API Type (adapter_id) override; NULL inherits the channel adapter.
ALTER TABLE provider_models ADD COLUMN adapter_id TEXT;
