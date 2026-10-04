-- Explicit server-controlled upload policy on the existing routing authority.
-- No deployment, policy acceptance, retention duration or quota is inferred.
ALTER TABLE avatar_storage_policy
  ADD COLUMN policy_revision text CHECK(policy_revision IS NULL OR
    (length(policy_revision) BETWEEN 1 AND 64 AND policy_revision ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$')),
  ADD COLUMN persistence_allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN retained_byte_limit bigint CHECK(retained_byte_limit IS NULL OR retained_byte_limit>=131072);
ALTER TABLE avatar_storage_policy ADD CONSTRAINT configured_avatar_persistence
  CHECK(NOT persistence_allowed OR (policy_revision IS NOT NULL AND retained_byte_limit IS NOT NULL));
CREATE INDEX assets_retained_by_owner ON assets(owner_user_id,asset_id);
