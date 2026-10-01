-- Manually registered works converted to 社群技能書. Publication time belongs to this catalog.
INSERT INTO skill_publications(book_id) VALUES
 ('video-to-podcast-toolkit'),
 ('autovtuber'),
 ('coding-audit-harness')
ON CONFLICT DO NOTHING;
