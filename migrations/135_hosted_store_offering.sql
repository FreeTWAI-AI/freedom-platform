-- Offer the hosted store to every guild.
-- The commerce guild recommends it first through its purpose profile.
INSERT INTO guild_application_offerings (
  offering_id, community_id, guild_key, application_key, release_ref, status, display_order, launch_policy_ref, version)
SELECT gen_random_uuid(), NULL, NULL, application_key, release_ref, 'offered', 10, launch_policy_ref, 1
FROM application_definitions
WHERE application_key = 'hosted-store' AND release_ref = 'hosted-store@1.0.0';

-- Ted confirmed commerce as external on 2026-10-08. Keep the catalog fence,
-- member lock order and recategorization facts used by classifyInTransaction.
-- Clear an incompatible primary; never move it into another category for a member.
DO $$
DECLARE
  prior_category guild_category;
  holder record;
  old_category guild_category;
  next_version bigint;
  transition uuid;
  detail jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('guild-catalog-revision', 0));
  SELECT category INTO prior_category FROM guild_catalog_categories
    WHERE guild_key = 'guild_commerce_sales' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_classification_missing';
  END IF;

  IF prior_category IS DISTINCT FROM 'external'::guild_category THEN
    FOR holder IN SELECT community_id, user_id FROM guild_category_preferences
      WHERE guild_key = 'guild_commerce_sales' ORDER BY user_id, community_id
    LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(
        'guild-member/' || holder.community_id || '/' || holder.user_id, 0));
      DELETE FROM guild_category_preferences
        WHERE community_id = holder.community_id AND user_id = holder.user_id
          AND guild_key = 'guild_commerce_sales'
        RETURNING category INTO old_category;
      IF FOUND THEN
        UPDATE guild_preference_sets SET aggregate_version = aggregate_version + 1, updated_at = now()
          WHERE community_id = holder.community_id AND user_id = holder.user_id
          RETURNING aggregate_version INTO next_version;
        INSERT INTO guild_preference_invalidations
          (community_id, user_id, guild_key, old_category, reason, old_version, new_version)
          VALUES (holder.community_id, holder.user_id, 'guild_commerce_sales', old_category,
            'guild_recategorized', next_version - 1, next_version);
        transition := gen_random_uuid();
        detail := jsonb_build_object('community_id', holder.community_id, 'user_id', holder.user_id,
          'aggregate_version', next_version::text, 'changed_category', old_category,
          'guild_key', NULL, 'reason', 'guild_recategorized');
        INSERT INTO transition_journal
          (transition_id, community_id, aggregate_type, aggregate_id, aggregate_version, command, actor_ref, data)
          VALUES (transition, holder.community_id, 'guild_preference', holder.user_id,
            next_version, 'guild_recategorized', holder.user_id, detail);
        INSERT INTO outbox (event_id, transition_id, event_type, payload)
          VALUES (gen_random_uuid(), transition, 'freedom.guild.preference.changed.v1',
            jsonb_build_object('aggregate_id', holder.user_id, 'aggregate_version', next_version::text,
              'community_id', holder.community_id, 'data', detail));
      END IF;
    END LOOP;
  END IF;

  UPDATE guild_catalog_categories SET category = 'external', category_review = 'approved',
    catalog_revision = nextval('guild_catalog_revision'), reviewed_by_principal_id = NULL, reviewed_at = now()
    WHERE guild_key = 'guild_commerce_sales'
      AND (category IS DISTINCT FROM 'external'::guild_category OR category_review <> 'approved');
END;
$$;
