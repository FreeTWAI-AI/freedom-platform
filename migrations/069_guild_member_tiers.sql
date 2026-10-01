-- New joins start as intern: they can read the guild and use its chat, not post or edit.
-- Rows that already existed stay full, so current members keep their rights.
-- A guild master appoints experts with appointed_by_user_id; platform admins keep appointed_by.
-- Exactly one appointer is set. Revoked expert rows and versions stay as they are.
-- A full membership is required for development grants. Demotion revokes them.

ALTER TABLE positioning_profession_memberships
  ADD COLUMN member_tier text NOT NULL DEFAULT 'full'
  CONSTRAINT positioning_profession_memberships_member_tier_check CHECK (member_tier IN ('intern','full'));
ALTER TABLE positioning_profession_memberships ALTER COLUMN member_tier SET DEFAULT 'intern';

ALTER TABLE positioning_guild_experts ADD COLUMN appointed_by_user_id uuid REFERENCES users;
ALTER TABLE positioning_guild_experts ALTER COLUMN appointed_by DROP NOT NULL;
ALTER TABLE positioning_guild_experts ADD CONSTRAINT positioning_guild_experts_appointer_check
  CHECK ((appointed_by IS NOT NULL AND appointed_by_user_id IS NULL)
      OR (appointed_by IS NULL AND appointed_by_user_id IS NOT NULL));

ALTER TABLE member_notifications DROP CONSTRAINT member_notifications_kind_check;
ALTER TABLE member_notifications ADD CONSTRAINT member_notifications_kind_check CHECK (kind IN (
  'friend_request','friend_accepted','friend_declined','squad_invitation',
  'guild_application_approved','guild_application_rejected',
  'guild_expert_appointed','guild_expert_revoked',
  'guild_master_appointed','guild_master_revoked',
  'guild_member_promoted','guild_member_demoted',
  'event_submitted','event_review_needed','event_approved','event_rejected'));

CREATE OR REPLACE FUNCTION revoke_ineligible_development() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE person uuid; community uuid;
BEGIN
  person := COALESCE(NEW.user_id,OLD.user_id);
  community := COALESCE(NEW.community_id,OLD.community_id);
  UPDATE development_grants g SET revoked_at=now(),revoke_reason='guild_eligibility_lost'
    WHERE g.user_id=person AND g.community_id=community AND g.revoked_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM positioning_profession_memberships m
      WHERE m.user_id=person AND m.community_id=community AND m.state='active' AND m.member_tier='full'
      AND ((g.capability='skill' AND m.guild_key IN ('guild_ai_vibe','guild_ai_field'))
        OR (g.capability='platform' AND m.guild_key='guild_platform_engineering')));
  RETURN NULL;
END $$;
