-- Explicit member-visible supply snapshots. Private drafts never enter this table.
CREATE TABLE commerce_hosted_supply_offers (
  offer_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  item_id uuid NOT NULL REFERENCES commerce_items,
  community_id uuid NOT NULL,
  supplier_name text NOT NULL,
  source_version bigint NOT NULL CHECK(source_version>0),
  terms jsonb NOT NULL CHECK(jsonb_typeof(terms)='object'),
  terms_sha256 text NOT NULL CHECK(terms_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'offered' CHECK(state IN ('offered','withdrawn')),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,instance_id) REFERENCES module_instances(tenant_id,instance_id),
  UNIQUE(offer_id,item_id)
);
CREATE UNIQUE INDEX commerce_hosted_one_offer ON commerce_hosted_supply_offers(item_id) WHERE state='offered';
CREATE INDEX commerce_hosted_offers_catalog ON commerce_hosted_supply_offers(community_id,offer_id) WHERE state='offered';
ALTER TABLE commerce_hosted_supply_offers ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_hosted_offer_read ON commerce_hosted_supply_offers FOR SELECT TO PUBLIC
  USING(tenant_id=freedom_ctx_tenant() OR EXISTS (
    SELECT 1 FROM principals p JOIN users u ON u.user_id=p.user_ref
    WHERE p.principal_id=freedom_ctx_principal() AND p.kind='person' AND p.status='active'
      AND u.active AND u.community_id=commerce_hosted_supply_offers.community_id));
CREATE POLICY commerce_hosted_offer_write ON commerce_hosted_supply_offers FOR ALL TO PUBLIC
  USING(tenant_id=freedom_ctx_tenant()) WITH CHECK(tenant_id=freedom_ctx_tenant());
CREATE FUNCTION check_commerce_hosted_offer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM commerce_storefront_profiles p
    JOIN commerce_items i ON i.shop_id=p.supply_shop_id AND i.item_id=NEW.item_id
    JOIN commerce_shops s ON s.shop_id=p.supply_shop_id AND s.origin='hosted' AND s.community_id=NEW.community_id
    JOIN commerce_resource_tenants m ON m.resource_kind='shop' AND m.resource_id=p.supply_shop_id
      AND m.tenant_id=p.tenant_id AND m.instance_id=p.instance_id AND m.mapping_state='confirmed'
    WHERE p.tenant_id=NEW.tenant_id AND p.instance_id=NEW.instance_id AND NEW.terms->>'currency'=s.currency
  ) THEN RAISE EXCEPTION 'offer must belong to its exact supplier' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_commerce_hosted_offer BEFORE INSERT ON commerce_hosted_supply_offers
  FOR EACH ROW EXECUTE FUNCTION check_commerce_hosted_offer();
CREATE FUNCTION preserve_commerce_hosted_offer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'supply offers are retained' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.offer_id,NEW.tenant_id,NEW.instance_id,NEW.item_id,NEW.community_id,NEW.supplier_name,NEW.source_version,NEW.terms,NEW.terms_sha256,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.offer_id,OLD.tenant_id,OLD.instance_id,OLD.item_id,OLD.community_id,OLD.supplier_name,OLD.source_version,OLD.terms,OLD.terms_sha256,OLD.created_at)
    OR OLD.state<>'offered' OR NEW.state<>'withdrawn' OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'supply offer permits withdrawal only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_hosted_offer BEFORE UPDATE OR DELETE ON commerce_hosted_supply_offers
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_hosted_offer();

-- Existing selections remain seller-owned. This adds provenance, not copied stock.
ALTER TABLE commerce_selections ADD COLUMN hosted_offer_id uuid,
  ADD COLUMN hosted_sku text CHECK(hosted_sku IS NULL OR hosted_sku ~ '^P[0-9]{4,10}$'),
  ADD CONSTRAINT commerce_selection_hosted_offer FOREIGN KEY(hosted_offer_id,item_id)
    REFERENCES commerce_hosted_supply_offers(offer_id,item_id),
  ADD CONSTRAINT commerce_selection_hosted_fields CHECK((hosted_offer_id IS NULL)=(hosted_sku IS NULL));
CREATE UNIQUE INDEX commerce_selection_hosted_sku ON commerce_selections(shop_id,hosted_sku) WHERE hosted_sku IS NOT NULL;
CREATE FUNCTION check_commerce_hosted_selection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hosted_offer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM commerce_hosted_supply_offers o
    JOIN commerce_storefront_profiles seller ON seller.storefront_shop_id=NEW.shop_id AND seller.instance_id<>o.instance_id
    JOIN commerce_shops s ON s.shop_id=NEW.shop_id AND s.origin='hosted' AND s.community_id=o.community_id
    WHERE o.offer_id=NEW.hosted_offer_id AND o.item_id=NEW.item_id AND o.terms->>'currency'=s.currency
      AND NEW.snapshot->>'offer_id'=o.offer_id::text AND NEW.snapshot->>'offer_sha256'=o.terms_sha256
      AND NEW.snapshot->>'sku'=NEW.hosted_sku
  ) THEN RAISE EXCEPTION 'hosted selection must match its exact offer and seller' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_commerce_hosted_selection BEFORE INSERT OR UPDATE ON commerce_selections
  FOR EACH ROW EXECUTE FUNCTION check_commerce_hosted_selection();
