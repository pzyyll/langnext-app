-- ABOUTME: Phase 12 retirement checkpoint: schema no-op; retirement is inventory-driven only.
-- ABOUTME: Registered in storage/migrations.rs; advances user_version without touching rows.
--
-- This migration intentionally performs NO data changes. Legacy runtime retirement is decided
-- by the runtime inventory (enabled rows, package-first readiness, activation state) and
-- remediated explicitly by the user through the retirement panel. Automatic disablement or
-- deletion of user rows is never part of a schema upgrade, and no executor allowlist lives in
-- SQL (PaddleOCR and provider adapters stay out of any automatic path).

SELECT 1;
