-- Role changes are authoritative immediately. A separate private worker applies
-- the exact active-admin email list to Access, then acknowledges these revisions.
ALTER TABLE platform_admins
  ADD COLUMN aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  ADD COLUMN access_synced_version bigint,
  ADD COLUMN access_synced_at timestamptz,
  ADD CONSTRAINT platform_admin_access_revision_valid CHECK (
    access_synced_version IS NULL OR
    (access_synced_version > 0 AND access_synced_version <= aggregate_version)
  );
