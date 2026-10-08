-- Offer the hosted store to every guild.
-- The commerce guild recommends it first through its purpose profile.
INSERT INTO guild_application_offerings (
  offering_id, community_id, guild_key, application_key, release_ref, status, display_order, launch_policy_ref, version)
SELECT gen_random_uuid(), NULL, NULL, application_key, release_ref, 'offered', 10, launch_policy_ref, 1
FROM application_definitions
WHERE application_key = 'hosted-store' AND release_ref = 'hosted-store@1.0.0';
