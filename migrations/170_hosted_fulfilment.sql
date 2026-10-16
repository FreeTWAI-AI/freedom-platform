-- Additive M3 settings. No provider entry point or fulfilment capability opens here.
CREATE TABLE commerce_ship_from_locations (
  location_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 40 AND label !~ '[[:cntrl:]]' AND label !~ '^[[:space:]]|[[:space:]]$'),
  sender_name text NOT NULL CHECK(char_length(sender_name) BETWEEN 2 AND 10),
  mobile text NOT NULL CHECK(mobile ~ '^09[0-9]{8}$'),
  postal_code text NOT NULL CHECK(postal_code ~ '^([0-9]{3}|[0-9]{5}|[0-9]{6})$'),
  address text NOT NULL CHECK(char_length(address) BETWEEN 7 AND 60),
  ships boolean NOT NULL,
  receives_returns boolean NOT NULL,
  replaces_location_id uuid REFERENCES commerce_ship_from_locations(location_id),
  created_by_principal_id uuid NOT NULL REFERENCES principals(principal_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz,
  retired_by_principal_id uuid REFERENCES principals(principal_id),
  FOREIGN KEY(tenant_id,instance_id) REFERENCES module_instances(tenant_id,instance_id),
  CHECK(ships OR receives_returns),
  CHECK((retired_at IS NULL)=(retired_by_principal_id IS NULL)),
  CHECK(retired_at IS NULL OR retired_at>=created_at)
);
CREATE INDEX commerce_ship_from_locations_current ON commerce_ship_from_locations(tenant_id,instance_id,created_at,location_id) WHERE retired_at IS NULL;
CREATE INDEX commerce_ship_from_locations_creator ON commerce_ship_from_locations(created_by_principal_id);
CREATE INDEX commerce_ship_from_locations_retirer ON commerce_ship_from_locations(retired_by_principal_id);
CREATE INDEX commerce_ship_from_locations_replaces ON commerce_ship_from_locations(replaces_location_id);
CREATE FUNCTION preserve_commerce_ship_from_location() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ship-from locations are retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.retired_at IS NOT NULL OR (NEW.replaces_location_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM commerce_ship_from_locations l WHERE l.location_id=NEW.replaces_location_id
        AND l.tenant_id=NEW.tenant_id AND l.instance_id=NEW.instance_id)) THEN
      RAISE EXCEPTION 'invalid ship-from replacement' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['retired_at','retired_by_principal_id']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['retired_at','retired_by_principal_id'])
    OR OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL OR NEW.retired_by_principal_id IS NULL THEN
    RAISE EXCEPTION 'ship-from locations may only retire once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_ship_from_location BEFORE INSERT OR UPDATE OR DELETE ON commerce_ship_from_locations
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_ship_from_location();
CREATE TRIGGER require_commerce_ship_from_storefront BEFORE INSERT ON commerce_ship_from_locations
  FOR EACH ROW EXECUTE FUNCTION require_commerce_storefront_instance();
ALTER TABLE commerce_ship_from_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_ship_from_locations_tenant ON commerce_ship_from_locations FOR ALL TO PUBLIC
  USING(tenant_id=freedom_ctx_tenant()) WITH CHECK(tenant_id=freedom_ctx_tenant());

-- Non-PII immutable versions are read across tenants by participant-authorized quotes.
CREATE TABLE commerce_shipping_profile_versions (
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>=1),
  document jsonb NOT NULL CHECK(jsonb_typeof(document)='object' AND document->>'schema'='freedom.shipping-profile/v1'
    AND octet_length(document::text)<=32768),
  document_sha256 text NOT NULL CHECK(document_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_principal_id uuid NOT NULL REFERENCES principals(principal_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(instance_id,version),
  FOREIGN KEY(tenant_id,instance_id) REFERENCES module_instances(tenant_id,instance_id)
);
CREATE INDEX commerce_shipping_profile_versions_store ON commerce_shipping_profile_versions(tenant_id,instance_id);
CREATE INDEX commerce_shipping_profile_versions_creator ON commerce_shipping_profile_versions(created_by_principal_id);
CREATE FUNCTION preserve_commerce_shipping_profile_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'shipping profiles are append only' USING ERRCODE='23514'; END IF;
  -- Serializes the contiguous-version check even for direct SQL writers.
  PERFORM 1 FROM module_instances WHERE tenant_id=NEW.tenant_id AND instance_id=NEW.instance_id FOR NO KEY UPDATE;
  IF NEW.version<>1+coalesce((SELECT max(version) FROM commerce_shipping_profile_versions WHERE instance_id=NEW.instance_id),0) THEN
    RAISE EXCEPTION 'shipping profile version must be contiguous' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_shipping_profile_version BEFORE INSERT OR UPDATE OR DELETE ON commerce_shipping_profile_versions
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_shipping_profile_version();
CREATE TRIGGER require_commerce_shipping_profile_storefront BEFORE INSERT ON commerce_shipping_profile_versions
  FOR EACH ROW EXECUTE FUNCTION require_commerce_storefront_instance();

CREATE TABLE commerce_item_shipping_attributes (
  item_id uuid NOT NULL REFERENCES commerce_items(item_id),
  version integer NOT NULL CHECK(version>=1),
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  weight_g integer NOT NULL CHECK(weight_g BETWEEN 1 AND 1000000),
  length_mm integer NOT NULL CHECK(length_mm BETWEEN 1 AND 10000),
  width_mm integer NOT NULL CHECK(width_mm BETWEEN 1 AND 10000),
  height_mm integer NOT NULL CHECK(height_mm BETWEEN 1 AND 10000),
  temperature text NOT NULL CHECK(temperature IN ('ambient','chilled','frozen')),
  cvs_allowed boolean NOT NULL,
  ship_alone boolean NOT NULL,
  max_per_parcel integer CHECK(max_per_parcel IS NULL OR max_per_parcel BETWEEN 1 AND 999),
  created_by_principal_id uuid NOT NULL REFERENCES principals(principal_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(item_id,version),
  FOREIGN KEY(tenant_id,instance_id) REFERENCES module_instances(tenant_id,instance_id)
);
CREATE INDEX commerce_item_shipping_attributes_store ON commerce_item_shipping_attributes(tenant_id,instance_id);
CREATE INDEX commerce_item_shipping_attributes_creator ON commerce_item_shipping_attributes(created_by_principal_id);
CREATE FUNCTION preserve_commerce_item_shipping_attributes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'item shipping attributes are append only' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM commerce_items WHERE item_id=NEW.item_id FOR NO KEY UPDATE;
  IF NEW.version<>1+coalesce((SELECT max(version) FROM commerce_item_shipping_attributes WHERE item_id=NEW.item_id),0)
    OR NOT EXISTS(SELECT 1 FROM commerce_items i JOIN commerce_storefront_profiles p ON p.supply_shop_id=i.shop_id
      WHERE i.item_id=NEW.item_id AND p.tenant_id=NEW.tenant_id AND p.instance_id=NEW.instance_id) THEN
    RAISE EXCEPTION 'invalid item shipping attributes binding or version' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_item_shipping_attributes BEFORE INSERT OR UPDATE OR DELETE ON commerce_item_shipping_attributes
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_item_shipping_attributes();

CREATE TABLE commerce_logistics_services (
  logistics_service_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  purpose text NOT NULL DEFAULT 'logistics' CHECK(purpose='logistics'),
  service_key text NOT NULL CHECK(service_key IN ('ecpay.logistics.home.tcat','ecpay.logistics.home.post',
    'ecpay.logistics.cvs.unimartc2c','ecpay.logistics.cvs.famic2c','ecpay.logistics.cvs.hilifec2c')),
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  environment text NOT NULL CHECK(environment IN ('sandbox','live')),
  state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','active','suspended','retired')),
  activated_at timestamptz,
  activation_ref text CHECK(activation_ref IS NULL OR char_length(activation_ref) BETWEEN 1 AND 200),
  created_by_principal_id uuid NOT NULL REFERENCES principals(principal_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  FOREIGN KEY(account_id,purpose,tenant_id,instance_id,environment)
    REFERENCES commerce_provider_account_services(account_id,purpose,tenant_id,instance_id,environment),
  CHECK((activated_at IS NULL)=(activation_ref IS NULL)),
  CHECK(state NOT IN ('active','suspended') OR activated_at IS NOT NULL),
  CHECK(state<>'draft' OR activated_at IS NULL)
);
CREATE UNIQUE INDEX commerce_logistics_services_current ON commerce_logistics_services(account_id,service_key) WHERE state<>'retired';
CREATE UNIQUE INDEX commerce_logistics_services_one_active ON commerce_logistics_services(instance_id,environment,service_key) WHERE state='active';
CREATE INDEX commerce_logistics_services_store ON commerce_logistics_services(tenant_id,instance_id,environment);
CREATE INDEX commerce_logistics_services_creator ON commerce_logistics_services(created_by_principal_id);
CREATE FUNCTION preserve_commerce_logistics_service() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'logistics services are retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'draft' OR NEW.version<>1 OR NEW.activated_at IS NOT NULL OR NEW.activation_ref IS NOT NULL THEN
      RAISE EXCEPTION 'logistics services start draft' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state='retired' OR (to_jsonb(NEW)-ARRAY['state','activated_at','activation_ref','updated_at','version']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['state','activated_at','activation_ref','updated_at','version'])
    OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at
    OR (OLD.activated_at IS NOT NULL AND ROW(NEW.activated_at,NEW.activation_ref) IS DISTINCT FROM ROW(OLD.activated_at,OLD.activation_ref))
    OR (OLD.activated_at IS NULL AND NEW.activated_at IS NOT NULL AND NOT (OLD.state='draft' AND NEW.state='active'))
    OR NOT ((OLD.state='draft' AND NEW.state='active' AND NEW.activated_at IS NOT NULL AND NEW.activation_ref IS NOT NULL)
      OR (OLD.state='active' AND NEW.state='suspended')
      OR (OLD.state='suspended' AND NEW.state='active' AND OLD.activated_at IS NOT NULL)
      OR NEW.state='retired') THEN
    RAISE EXCEPTION 'invalid logistics service transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_logistics_service BEFORE INSERT OR UPDATE OR DELETE ON commerce_logistics_services
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_logistics_service();
ALTER TABLE commerce_logistics_services ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_logistics_services_tenant ON commerce_logistics_services FOR ALL TO PUBLIC
  USING(tenant_id=freedom_ctx_tenant()) WITH CHECK(tenant_id=freedom_ctx_tenant());

DROP INDEX commerce_provider_services_one_active;
CREATE UNIQUE INDEX commerce_provider_services_one_active ON commerce_provider_account_services(instance_id,environment,profile)
  WHERE state='active' AND purpose<>'logistics';

-- These exact two constraint names were checked in the PostgreSQL 169 catalog.
ALTER TABLE commerce_control_events DROP CONSTRAINT commerce_control_events_kind_check,
  ADD CONSTRAINT commerce_control_events_kind_check CHECK(kind IN ('storefront.upgraded','provider_account.created','provider_service.created',
    'provider_service.state_changed','provider_credential.rotated','provider_credential.retired','provider_credential.resealed',
    'store_admission.admitted','store_admission.revoked','logistics_service.created','logistics_service.state_changed'));
ALTER TABLE commerce_control_events DROP CONSTRAINT commerce_control_events_detail_check,
  ADD CONSTRAINT commerce_control_events_detail_check CHECK(jsonb_typeof(detail)='object' AND octet_length(detail::text)<=1024
    AND detail-ARRAY['purpose','profile','environment','from_state','to_state','credential_version','module_release_ref','service_key']='{}'::jsonb);
