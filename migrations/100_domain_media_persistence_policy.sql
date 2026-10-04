-- Explicit operator policy; a storage mode never grants persistence.
ALTER TABLE domain_media_storage_policy
 ADD COLUMN policy_lock integer GENERATED ALWAYS AS (0) STORED,
 ADD COLUMN policy_revision text CHECK(policy_revision IS NULL OR (length(policy_revision) BETWEEN 1 AND 64 AND policy_revision ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$')),
 ADD COLUMN persistence_allowed boolean NOT NULL DEFAULT false,
 ADD COLUMN retained_byte_limit bigint CHECK(retained_byte_limit IS NULL OR retained_byte_limit>0),
 ADD CONSTRAINT domain_media_permission_shape CHECK(NOT persistence_allowed OR (policy_revision IS NOT NULL AND retained_byte_limit IS NOT NULL));
