-- Publication time belongs to this catalog, not the original creation date.
INSERT INTO skill_publications(book_id) VALUES
 ('bidding-radar-concept'),
 ('aiwff-runtime'),
 ('n8n-marketing-flows'),
 ('anti-gambling-trader-tw'),
 ('web-card-game-skill'),
 ('ai-avatar-bot'),
 ('ai-manga-translator'),
 ('line-persona')
ON CONFLICT DO NOTHING;

-- Backfill books for existing active members; preserve choices, consent and authority.
INSERT INTO member_skill_book_grants(grant_id,community_id,user_id,guild_key,book_id)
SELECT gen_random_uuid(),m.community_id,m.user_id,m.guild_key,b.book_id
FROM positioning_profession_memberships m
JOIN users u ON u.user_id=m.user_id AND u.community_id=m.community_id AND u.active
JOIN (VALUES
 ('guild_opportunity_partnership','bidding-radar-concept'),
 ('guild_ai_field','bidding-radar-concept'),
 ('guild_ai_vibe','aiwff-runtime'),
 ('guild_ai_field','aiwff-runtime'),
 ('guild_marketing','n8n-marketing-flows'),
 ('guild_ai_field','n8n-marketing-flows'),
 ('guild_ai_field','anti-gambling-trader-tw'),
 ('guild_ai_vibe','web-card-game-skill'),
 ('guild_ai_vibe','ai-avatar-bot'),
 ('guild_member_operations','ai-avatar-bot'),
 ('guild_ai_field','ai-manga-translator'),
 ('guild_media_automation','ai-manga-translator'),
 ('guild_member_operations','line-persona'),
 ('guild_ai_field','line-persona')
) AS b(guild_key,book_id) ON b.guild_key=m.guild_key
WHERE m.state='active'
ON CONFLICT DO NOTHING;
