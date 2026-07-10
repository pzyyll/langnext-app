-- User-defined channel ordering for the Models sidebar.
ALTER TABLE provider_instances ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
