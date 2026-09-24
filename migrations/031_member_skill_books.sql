-- First catalog publication timestamps, not upstream creation dates.
INSERT INTO skill_publications(book_id) VALUES
 ('local-workspace-mcp'),('editkin'),('positioning-companion'),('freedom-party-guild-lounge')
ON CONFLICT DO NOTHING;

-- Existing active guild members receive the newly registered books too.
-- This does not change memberships, primary choices, consent, or development authority.
INSERT INTO member_skill_book_grants(grant_id,community_id,user_id,guild_key,book_id)
SELECT gen_random_uuid(),m.community_id,m.user_id,m.guild_key,b.book_id
FROM positioning_profession_memberships m
JOIN users u ON u.user_id=m.user_id AND u.community_id=m.community_id AND u.active
JOIN (VALUES
 ('guild_ai_vibe','local-workspace-mcp'),('guild_ai_field','local-workspace-mcp'),
 ('guild_media_automation','editkin'),('guild_talent_direction','positioning-companion'),
 ('guild_member_operations','freedom-party-guild-lounge'),('guild_event_space','freedom-party-guild-lounge')
) AS b(guild_key,book_id) ON b.guild_key=m.guild_key
WHERE m.state='active'
ON CONFLICT DO NOTHING;
