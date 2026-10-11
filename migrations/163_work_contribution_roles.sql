-- Community-only attribution of an existing Work. No score, money or new Work.
ALTER TABLE work_items ADD CONSTRAINT contribution_role_work_community_identity UNIQUE(work_item_id,community_id);

CREATE TABLE work_contribution_roles (
  role_id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities,
  work_item_id uuid NOT NULL,
  work_mode text GENERATED ALWAYS AS ('community_collaboration'::text) STORED,
  member_ref uuid NOT NULL,
  role text NOT NULL CHECK(role IN ('proposal','design','implementation','testing','review','documentation','coordination','service')),
  summary text NOT NULL CHECK(length(btrim(summary)) BETWEEN 1 AND 1000),
  evidence_ref text NOT NULL CHECK(evidence_ref ~ '^[a-z][a-z0-9_-]{1,30}:[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$'),
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','confirmed','withdrawn')),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0),
  shared_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(work_item_id,community_id) REFERENCES work_items(work_item_id,community_id),
  FOREIGN KEY(work_item_id,work_mode) REFERENCES work_items(work_item_id,work_mode),
  FOREIGN KEY(member_ref,community_id) REFERENCES users(user_id,community_id),
  UNIQUE(work_item_id,member_ref,role)
);
CREATE TABLE work_contribution_confirmations (
  confirmation_id uuid PRIMARY KEY,
  role_id uuid NOT NULL REFERENCES work_contribution_roles,
  claim_version bigint NOT NULL CHECK(claim_version>0),
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  confirmer_ref uuid NOT NULL REFERENCES users,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(role_id,claim_version)
);
CREATE INDEX contribution_role_member ON work_contribution_roles(community_id,member_ref,work_item_id);
CREATE INDEX contribution_role_work ON work_contribution_roles(community_id,work_item_id,shared_at,role_id);
-- Confirmation rows are historical metadata. Edits/withdrawals never rewrite them.
CREATE FUNCTION preserve_contribution_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Contribution confirmations are immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER preserve_contribution_confirmation BEFORE UPDATE OR DELETE ON work_contribution_confirmations
  FOR EACH ROW EXECUTE FUNCTION preserve_contribution_confirmation();
