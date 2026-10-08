-- Hosted display stores reuse the formal commerce owner. Ordering is not enabled.
ALTER TABLE commerce_shops ADD COLUMN origin text NOT NULL DEFAULT 'imported'
  CHECK (origin IN ('imported','hosted'));
ALTER TABLE commerce_shops ADD CONSTRAINT commerce_shops_hosted_display_only
  CHECK (origin <> 'hosted' OR (accepting_orders = false AND mode = 'test' AND website_url = '' AND contact = ''));
CREATE UNIQUE INDEX module_instances_one_storefront ON module_instances(tenant_id)
  WHERE module_key='storefront' AND status <> 'archived';

CREATE TABLE commerce_resource_tenants (
  resource_kind text NOT NULL CHECK (resource_kind IN ('shop')),
  resource_id uuid NOT NULL REFERENCES commerce_shops(shop_id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  source_owner_id uuid NOT NULL REFERENCES principals(principal_id),
  mapping_state text NOT NULL CHECK (mapping_state IN ('confirmed','ambiguous')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (resource_kind,resource_id),
  FOREIGN KEY (tenant_id,instance_id) REFERENCES module_instances(tenant_id,instance_id)
);
CREATE INDEX commerce_resource_tenants_instance ON commerce_resource_tenants(tenant_id,instance_id);
ALTER TABLE commerce_resource_tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_resource_tenants_tenant ON commerce_resource_tenants FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());

CREATE TABLE commerce_storefront_profiles (
  instance_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  supply_shop_id uuid NOT NULL UNIQUE REFERENCES commerce_shops(shop_id) ON DELETE CASCADE,
  storefront_shop_id uuid NOT NULL UNIQUE REFERENCES commerce_shops(shop_id) ON DELETE CASCADE,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{1,38}[a-z0-9]$'),
  brand text CHECK (brand IS NULL OR char_length(brand) BETWEEN 1 AND 80),
  current_publication_id uuid,
  first_published_at timestamptz,
  product_seq integer NOT NULL DEFAULT 0 CHECK (product_seq >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_principal_id uuid NOT NULL REFERENCES principals(principal_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,instance_id) REFERENCES module_instances(tenant_id,instance_id),
  CHECK (supply_shop_id <> storefront_shop_id)
);
CREATE FUNCTION preserve_commerce_storefront_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.instance_id,NEW.tenant_id,NEW.supply_shop_id,NEW.storefront_shop_id,NEW.created_by_principal_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.instance_id,OLD.tenant_id,OLD.supply_shop_id,OLD.storefront_shop_id,OLD.created_by_principal_id,OLD.created_at)
    OR (OLD.first_published_at IS NOT NULL AND (NEW.slug IS DISTINCT FROM OLD.slug
      OR NEW.first_published_at IS DISTINCT FROM OLD.first_published_at)) THEN
    RAISE EXCEPTION 'storefront identity and first publication are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_storefront_profile BEFORE UPDATE ON commerce_storefront_profiles
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_storefront_profile();

CREATE TABLE commerce_storefront_publications (
  publication_id uuid PRIMARY KEY,
  instance_id uuid NOT NULL REFERENCES commerce_storefront_profiles(instance_id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  slug text NOT NULL,
  projection jsonb NOT NULL CHECK (jsonb_typeof(projection)='object'),
  projection_sha256 text NOT NULL CHECK (projection_sha256 ~ '^[0-9a-f]{64}$'),
  published_by_principal_id uuid NOT NULL REFERENCES principals(principal_id),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(instance_id,revision)
);
ALTER TABLE commerce_storefront_profiles ADD CONSTRAINT commerce_storefront_current_publication
  FOREIGN KEY (current_publication_id) REFERENCES commerce_storefront_publications(publication_id) ON DELETE SET NULL;
CREATE FUNCTION preserve_commerce_storefront_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'storefront publication is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER preserve_commerce_storefront_publication BEFORE UPDATE ON commerce_storefront_publications
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_storefront_publication();

DO $$
DECLARE
  store_contract jsonb := jsonb_build_object(
    'family','guild-launchpad.storefront','version','1',
    'source_commit','9c0f5d4a319272caeb3b4e212828ab1d0ed28ba3',
    'artifact_sha256','eb9a262e2914af0a8fac3631533f8e4350b4d602b7a682d4497774b60c4d8ac7',
    'behavior_profile','freedom.storefront/v1');
  launch_policy jsonb := jsonb_build_object('policy_key','hosted-store.launch','version','1');
  store_capabilities jsonb := jsonb_build_array('store:manage','store:read','store:write','store:publish');
BEGIN
  INSERT INTO module_definitions(module_key,release_ref,capabilities,data_catalog_ref,contract_ref,data_schema_version,
    portable_profile_ref,runtime_profiles,config_schema_ref,supported_upgrade_paths,license_review_ref,license_state,release_status,version)
  VALUES('storefront','storefront@1.0.0',store_capabilities,'storefront.tenant/v1',store_contract,'1',
    NULL,jsonb_build_array('hosted-shared'),'storefront.config/v1','[]'::jsonb,NULL,'reviewed','available',1);
  INSERT INTO application_definitions(application_key,release_ref,display_name,source_commit,artifact_digest,skill_book_refs,
    module_requirements,entry_capability,runtime_profiles,launch_policy_ref,license_state,release_status,customization_schema_ref,license_review_ref,version)
  VALUES('hosted-store','hosted-store@1.0.0','線上商店','9c0f5d4a319272caeb3b4e212828ab1d0ed28ba3',
    jsonb_build_object('algorithm','sha256','value','eb9a262e2914af0a8fac3631533f8e4350b4d602b7a682d4497774b60c4d8ac7'),'[]'::jsonb,
    jsonb_build_array(jsonb_build_object('requirement_key','storefront','module_key','storefront','module_release_ref','storefront@1.0.0',
      'capabilities',store_capabilities,'required',true,'cardinality','one','allow_reuse',true,'compatible_contracts',jsonb_build_array(store_contract))),
    'store:manage',jsonb_build_array('hosted-reviewed'),launch_policy,'reviewed','available','hosted-store.config/v1',NULL,1);
END $$;
