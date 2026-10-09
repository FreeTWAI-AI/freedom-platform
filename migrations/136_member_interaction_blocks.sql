-- Provisional next legacy slot on canonical main646f85c6; recheck numbering at integration.
-- Removed settings retain their identity/version; no role grants or tenant RLS changes.
CREATE TABLE member_interaction_blocks (
  block_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(community_id),
  owner_ref uuid NOT NULL,
  target_ref uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('active','removed')),
  blocked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version BETWEEN 1 AND 9007199254740991),
  UNIQUE (community_id,owner_ref,target_ref),
  FOREIGN KEY (owner_ref,community_id) REFERENCES users(user_id,community_id),
  FOREIGN KEY (target_ref,community_id) REFERENCES users(user_id,community_id),
  CHECK (owner_ref<>target_ref)
);
CREATE INDEX member_interaction_blocks_own_active
  ON member_interaction_blocks (community_id,owner_ref,blocked_at DESC,target_ref) WHERE state='active';
