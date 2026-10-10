-- #400: owners disband squads and removed members are told. A disbanded squad
-- keeps its row, journal and channel history; every membership becomes 'left'.
ALTER TABLE member_squads ADD COLUMN disbanded_at timestamptz;
ALTER TABLE member_notifications DROP CONSTRAINT member_notifications_kind_check;
ALTER TABLE member_notifications ADD CONSTRAINT member_notifications_kind_check CHECK (kind IN (
  'friend_request','friend_accepted','friend_declined','squad_invitation',
  'guild_application_approved','guild_application_rejected',
  'guild_expert_appointed','guild_expert_revoked',
  'guild_master_appointed','guild_master_revoked',
  'guild_member_promoted','guild_member_demoted',
  'event_submitted','event_review_needed','event_approved','event_rejected',
  'squad_member_removed'));

-- Existing kinds keep their keys; social adds casual community gatherings.
ALTER TABLE member_squads DROP CONSTRAINT member_squads_kind_check;
ALTER TABLE member_squads ADD CONSTRAINT member_squads_kind_check
  CHECK (kind IN ('project','mutual_help','coaching','social'));

-- The rollback release already joins this view for directory/detail/owner
-- authorization. Excluding disbanded rows makes its reads fail closed too.
CREATE OR REPLACE VIEW member_squad_classification AS
SELECT s.squad_id, s.community_id, COALESCE(a.is_test_account, false) AS is_test_data
FROM member_squads s
JOIN member_account_classification a ON a.user_id = s.owner_ref AND a.community_id = s.community_id
WHERE s.disbanded_at IS NULL;

-- Older invitation writers do not inspect disbanded_at. Fence their writes in
-- SQL as well, including a writer already past its unlocked authorization.
-- Current commands lock the squad before membership/invitation rows.
CREATE FUNCTION guard_live_member_squad() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('pending','active','accepted') THEN
    PERFORM 1 FROM member_squads
      WHERE squad_id=NEW.squad_id AND disbanded_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'squad_disbanded' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER member_squad_membership_live
  BEFORE INSERT OR UPDATE ON member_squad_memberships
  FOR EACH ROW EXECUTE FUNCTION guard_live_member_squad();
CREATE TRIGGER member_squad_invitation_live
  BEFORE INSERT OR UPDATE ON member_squad_invitations
  FOR EACH ROW EXECUTE FUNCTION guard_live_member_squad();
