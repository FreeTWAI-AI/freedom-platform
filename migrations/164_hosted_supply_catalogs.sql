-- Supply-only onboarding keeps existing stock, mappings, selections and consent.
-- A nullable slug is an unactivated retail surface, never an invented public URL.
ALTER TABLE commerce_storefront_profiles ALTER COLUMN slug DROP NOT NULL;
ALTER TABLE commerce_storefront_profiles ADD CONSTRAINT commerce_supply_only_unpublished
  CHECK (slug IS NOT NULL OR (current_publication_id IS NULL AND first_published_at IS NULL));

-- Historical retail products remain included. Supplier-created compatibility
-- selections explicitly opt out; their placeholder price must never be published.
ALTER TABLE commerce_selections ADD COLUMN own_retail_enabled boolean NOT NULL DEFAULT true;

-- No public publication may be inserted for a supply-only profile, including by
-- another caller of the SQL writer. Existing immutable publications are retained.
CREATE FUNCTION check_commerce_retail_publication_activation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM commerce_storefront_profiles p
    WHERE p.instance_id=NEW.instance_id AND p.tenant_id=NEW.tenant_id
      AND p.slug IS NOT NULL AND p.slug=NEW.slug) THEN
    RAISE EXCEPTION 'retail publication requires an activated storefront' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_commerce_retail_publication_activation BEFORE INSERT ON commerce_storefront_publications
  FOR EACH ROW EXECUTE FUNCTION check_commerce_retail_publication_activation();
