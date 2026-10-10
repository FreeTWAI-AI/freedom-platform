-- #403: post authors hear about comments and likes; squad owners about join
-- requests and requesters about acceptance. 'social' opens the social feed at
-- the post. The kind list is migration 146's, extended.
ALTER TABLE member_notifications DROP CONSTRAINT member_notifications_kind_check;
ALTER TABLE member_notifications ADD CONSTRAINT member_notifications_kind_check CHECK (kind IN (
  'friend_request','friend_accepted','friend_declined','squad_invitation',
  'guild_application_approved','guild_application_rejected',
  'guild_expert_appointed','guild_expert_revoked',
  'guild_master_appointed','guild_master_revoked',
  'guild_member_promoted','guild_member_demoted',
  'event_submitted','event_review_needed','event_approved','event_rejected',
  'squad_member_removed',
  'social_post_commented','social_post_liked','squad_join_requested','squad_join_accepted'));
ALTER TABLE member_notifications DROP CONSTRAINT member_notifications_action_tab_check;
ALTER TABLE member_notifications ADD CONSTRAINT member_notifications_action_tab_check
  CHECK (action_tab IN ('members','squads','guilds','guild-workspace','messages','events','social'));
