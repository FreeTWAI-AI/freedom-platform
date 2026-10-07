-- Three guild categories and one primary slot per category.
-- Expand only: legacy guild_member_preferences columns stay in place.

CREATE TYPE guild_category AS ENUM ('internal', 'external', 'professional_industry');
CREATE TYPE guild_category_review AS ENUM ('pending', 'approved');
CREATE TYPE guild_preference_migration_state AS ENUM ('legacy', 'backfilled', 'switched');
CREATE TYPE guild_preference_switch_state AS ENUM ('legacy', 'switched');
CREATE TYPE guild_preference_invalidation_reason AS ENUM (
  'guild_recategorized', 'guild_inactive', 'membership_left', 'legacy_ambiguous'
);

CREATE SEQUENCE guild_catalog_revision START 1;

CREATE FUNCTION guild_capability_tags_ok(tags text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT tags IS NOT NULL
    AND cardinality(tags) BETWEEN 0 AND 20
    AND NOT EXISTS (
      SELECT 1 FROM unnest(tags) AS tag
      WHERE char_length(tag) < 1 OR char_length(tag) > 64
        OR tag ~ '[[:cntrl:]]'
        OR position('<' IN tag) > 0
        OR position('>' IN tag) > 0
    );
$$;

CREATE TABLE guild_catalog_categories (
  guild_key text PRIMARY KEY REFERENCES positioning_guild_catalog(guild_key) ON DELETE CASCADE,
  category guild_category,
  category_review guild_category_review NOT NULL,
  catalog_revision bigint NOT NULL CHECK (catalog_revision > 0),
  capability_tags text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  reviewed_by_principal_id uuid,
  reviewed_at timestamptz,
  classification_id uuid NOT NULL DEFAULT gen_random_uuid(),
  CONSTRAINT guild_catalog_categories_review_shape CHECK (
    (category_review = 'approved' AND category IS NOT NULL)
    OR (category_review = 'pending' AND category IS NULL)
  ),
  CONSTRAINT guild_catalog_categories_tags CHECK (guild_capability_tags_ok(capability_tags))
);

CREATE TABLE guild_preference_sets (
  community_id uuid NOT NULL REFERENCES communities(community_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  migration_state guild_preference_migration_state NOT NULL,
  migrated_from_version bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, user_id)
);

CREATE TABLE guild_category_preferences (
  community_id uuid NOT NULL,
  user_id uuid NOT NULL,
  category guild_category NOT NULL,
  guild_key text NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, user_id, category),
  UNIQUE (community_id, user_id, guild_key),
  FOREIGN KEY (community_id, user_id) REFERENCES guild_preference_sets(community_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (community_id, user_id, guild_key)
    REFERENCES positioning_profession_memberships(community_id, user_id, guild_key) ON DELETE CASCADE
);

CREATE FUNCTION guild_category_preference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  membership_state text;
  review text;
  catalog_category text;
  catalog_active boolean;
BEGIN
  SELECT m.state INTO membership_state
    FROM positioning_profession_memberships m
    WHERE m.community_id = NEW.community_id AND m.user_id = NEW.user_id AND m.guild_key = NEW.guild_key
    FOR SHARE;
  IF membership_state IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'guild_category_preference_rejected' USING ERRCODE = '23514';
  END IF;
  SELECT c.category_review::text, c.category::text, c.active
    INTO review, catalog_category, catalog_active
    FROM guild_catalog_categories c
    WHERE c.guild_key = NEW.guild_key
    FOR SHARE;
  IF review IS DISTINCT FROM 'approved'
     OR catalog_category IS DISTINCT FROM NEW.category::text
     OR catalog_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'guild_category_preference_rejected' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER guild_category_preference_guard
  AFTER INSERT OR UPDATE ON guild_category_preferences
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION guild_category_preference_guard();

CREATE FUNCTION guild_category_preference_membership_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM 'active' AND EXISTS (
    SELECT 1 FROM guild_category_preferences p
    WHERE p.community_id = NEW.community_id AND p.user_id = NEW.user_id AND p.guild_key = NEW.guild_key
  ) THEN
    RAISE EXCEPTION 'guild_category_preference_rejected' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER guild_category_preference_membership_guard
  AFTER UPDATE OF state ON positioning_profession_memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION guild_category_preference_membership_guard();

CREATE FUNCTION guild_category_preference_catalog_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM guild_category_preferences p
    WHERE p.guild_key = NEW.guild_key
      AND (p.category::text IS DISTINCT FROM NEW.category::text OR NEW.active IS DISTINCT FROM true)
  ) THEN
    RAISE EXCEPTION 'guild_category_preference_rejected' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER guild_category_preference_catalog_guard
  AFTER UPDATE OF category, active ON guild_catalog_categories
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION guild_category_preference_catalog_guard();

CREATE INDEX guild_category_preferences_by_guild ON guild_category_preferences(guild_key, user_id);

CREATE TABLE guild_preference_migration_audit (
  audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  community_id uuid NOT NULL REFERENCES communities(community_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  legacy_primary text,
  legacy_secondary jsonb,
  effective_secondary text[] NOT NULL,
  legacy_version bigint,
  new_snapshot jsonb NOT NULL,
  invalidation_reason text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX guild_preference_migration_audit_identity
  ON guild_preference_migration_audit (
    community_id, user_id, legacy_primary, legacy_secondary, legacy_version, new_snapshot, invalidation_reason
  ) NULLS NOT DISTINCT;

CREATE TABLE guild_preference_invalidations (
  invalidation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(community_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  guild_key text,
  old_category guild_category,
  reason guild_preference_invalidation_reason NOT NULL,
  old_version bigint NOT NULL,
  new_version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guild_preference_invalidations_category CHECK (
    reason = 'legacy_ambiguous' OR old_category IS NOT NULL
  )
);

CREATE INDEX guild_preference_invalidations_member
  ON guild_preference_invalidations(community_id, user_id, created_at DESC);

CREATE TABLE guild_preference_switch (
  community_id uuid PRIMARY KEY REFERENCES communities(community_id) ON DELETE CASCADE,
  state guild_preference_switch_state NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  switched_at timestamptz,
  switched_by uuid
);

INSERT INTO guild_catalog_categories(
  guild_key, category, category_review, catalog_revision, capability_tags, active
)
SELECT guild_key, category, category_review, nextval('guild_catalog_revision'), '{}', true
FROM (
  SELECT g.guild_key,
    CASE g.guild_key
      WHEN 'guild_talent_direction' THEN 'internal'::guild_category
      WHEN 'guild_member_operations' THEN 'internal'::guild_category
      WHEN 'guild_platform_engineering' THEN 'internal'::guild_category
      WHEN 'guild_opportunity_partnership' THEN 'external'::guild_category
      WHEN 'guild_product_quality_supply' THEN 'professional_industry'::guild_category
      WHEN 'guild_media_automation' THEN 'professional_industry'::guild_category
      WHEN 'guild_commerce_settlement' THEN 'professional_industry'::guild_category
      WHEN 'guild_security' THEN 'professional_industry'::guild_category
      WHEN 'guild_music_mv' THEN 'professional_industry'::guild_category
      WHEN 'guild_commercial_production' THEN 'professional_industry'::guild_category
      WHEN 'guild_projection_mapping' THEN 'professional_industry'::guild_category
      WHEN 'guild_human_design' THEN 'professional_industry'::guild_category
      ELSE NULL
    END AS category,
    CASE WHEN g.guild_key IN (
      'guild_talent_direction', 'guild_member_operations', 'guild_platform_engineering',
      'guild_opportunity_partnership', 'guild_product_quality_supply', 'guild_media_automation',
      'guild_commerce_settlement', 'guild_security', 'guild_music_mv', 'guild_commercial_production',
      'guild_projection_mapping', 'guild_human_design'
    ) THEN 'approved'::guild_category_review ELSE 'pending'::guild_category_review END AS category_review
  FROM positioning_guild_catalog g
) seeded
ORDER BY guild_key;
