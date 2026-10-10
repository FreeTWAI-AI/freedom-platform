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
