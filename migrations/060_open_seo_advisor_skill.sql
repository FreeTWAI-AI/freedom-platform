-- Publication time belongs to this catalog, not the original creation date.
INSERT INTO skill_publications(book_id) VALUES ('open-seo-advisor')
ON CONFLICT DO NOTHING;

-- Backfill Open SEO Advisor for active members of 成長與行銷公會.
INSERT INTO member_skill_book_grants(grant_id,community_id,user_id,guild_key,book_id)
SELECT gen_random_uuid(),m.community_id,m.user_id,m.guild_key,b.book_id
FROM positioning_profession_memberships m
JOIN users u ON u.user_id=m.user_id AND u.community_id=m.community_id AND u.active
JOIN (VALUES
 ('guild_marketing','open-seo-advisor')
) AS b(guild_key,book_id) ON b.guild_key=m.guild_key
WHERE m.state='active'
ON CONFLICT DO NOTHING;
