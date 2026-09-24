-- Owner-initiated squad invitations. An invitation never grants membership or
-- squad-only contact visibility by itself; only the recipient's own accept
-- upserts the (squad_id,user_id) membership row. Terminal rows are history:
-- a later re-invite is a new invitation_id, never a revived old row.
CREATE TABLE member_squad_invitations (
  invitation_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities,
  squad_id uuid NOT NULL REFERENCES member_squads, owner_ref uuid NOT NULL REFERENCES users,
  recipient_ref uuid NOT NULL REFERENCES users,
  state text NOT NULL CHECK(state IN ('pending','accepted','declined','withdrawn')),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
  CHECK(owner_ref<>recipient_ref), CHECK((state='pending')=(resolved_at IS NULL))
);
CREATE UNIQUE INDEX member_squad_invitations_one_pending ON member_squad_invitations(squad_id,recipient_ref) WHERE state='pending';
CREATE INDEX member_squad_invitations_by_recipient ON member_squad_invitations(community_id,recipient_ref,updated_at DESC);
CREATE INDEX member_squad_invitations_by_squad ON member_squad_invitations(squad_id,updated_at DESC);
