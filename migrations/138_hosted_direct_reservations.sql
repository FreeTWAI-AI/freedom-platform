-- Closed backend profile only. No application release, route, payment or fulfilment activation.
-- 001..137, including the hosted accepting_orders=false guard, remain unchanged.
ALTER TABLE commerce_storefront_profiles ADD COLUMN reservation_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE commerce_storefront_profiles ADD CONSTRAINT commerce_storefront_exact_shop
  UNIQUE(tenant_id,instance_id,storefront_shop_id);
ALTER TABLE commerce_storefront_publications ADD CONSTRAINT commerce_publication_exact_instance
  UNIQUE(publication_id,tenant_id,instance_id);

CREATE TABLE commerce_order_quotes (
  quote_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  public_shop_id uuid NOT NULL,
  buyer_principal_id uuid NOT NULL REFERENCES principals(principal_id),
  publication_id uuid NOT NULL,
  terms jsonb NOT NULL CHECK(jsonb_typeof(terms)='object'),
  bindings jsonb NOT NULL CHECK(jsonb_typeof(bindings)='array' AND jsonb_array_length(bindings) BETWEEN 1 AND 50),
  terms_sha256 text NOT NULL CHECK(terms_sha256 ~ '^[a-f0-9]{64}$'),
  quoted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at=quoted_at+interval '5 minutes'),
  FOREIGN KEY(tenant_id,instance_id,public_shop_id) REFERENCES commerce_storefront_profiles(tenant_id,instance_id,storefront_shop_id),
  FOREIGN KEY(publication_id,tenant_id,instance_id) REFERENCES commerce_storefront_publications(publication_id,tenant_id,instance_id),
  UNIQUE(quote_id,public_shop_id,buyer_principal_id)
);
CREATE INDEX commerce_order_quotes_buyer ON commerce_order_quotes(buyer_principal_id,public_shop_id,expires_at);
ALTER TABLE commerce_order_quotes ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_order_quotes_target ON commerce_order_quotes FOR ALL TO PUBLIC
  USING(tenant_id=freedom_ctx_tenant() OR buyer_principal_id=freedom_ctx_principal())
  WITH CHECK(tenant_id=freedom_ctx_tenant() AND buyer_principal_id=freedom_ctx_principal());
CREATE FUNCTION preserve_commerce_order_quote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'reservation quote is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER preserve_commerce_order_quote BEFORE UPDATE ON commerce_order_quotes
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_order_quote();

ALTER TABLE commerce_orders
  ADD COLUMN order_profile text NOT NULL DEFAULT 'imported_reseller' CHECK(order_profile IN ('imported_reseller','hosted_direct_reservation')),
  ADD COLUMN quote_id uuid,
  ADD COLUMN buyer_principal_id uuid REFERENCES principals(principal_id),
  ADD COLUMN client_order_id uuid,
  ADD COLUMN reservation_state text,
  ADD COLUMN reservation_version bigint,
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN close_reason text,
  ADD CONSTRAINT commerce_order_profile_identity UNIQUE(order_id,order_profile),
  ADD CONSTRAINT commerce_order_direct_quote FOREIGN KEY(quote_id,public_shop_id,buyer_principal_id)
    REFERENCES commerce_order_quotes(quote_id,public_shop_id,buyer_principal_id),
  ADD CONSTRAINT commerce_order_direct_intent UNIQUE(public_shop_id,buyer_principal_id,client_order_id),
  ADD CONSTRAINT commerce_order_quote_once UNIQUE(quote_id),
  ADD CONSTRAINT commerce_order_profile_fields CHECK(
    (order_profile='imported_reseller' AND quote_id IS NULL AND buyer_principal_id IS NULL AND client_order_id IS NULL
      AND reservation_state IS NULL AND reservation_version IS NULL AND closed_at IS NULL AND close_reason IS NULL)
    OR (order_profile='hosted_direct_reservation' AND quote_id IS NOT NULL AND buyer_principal_id IS NOT NULL AND client_order_id IS NOT NULL
      AND buyer_payment='pending' AND reservation_version IS NOT NULL AND reservation_version>0
      AND expires_at=created_at+interval '30 minutes' AND reservation_state IS NOT NULL
      AND ((reservation_state='reserved' AND closed_at IS NULL AND close_reason IS NULL)
        OR (reservation_state='cancelled' AND closed_at IS NOT NULL AND closed_at>=created_at AND closed_at<expires_at
          AND close_reason IS NOT NULL AND close_reason IN ('buyer_cancelled','seller_cancelled'))
        OR (reservation_state='expired' AND closed_at IS NOT NULL AND closed_at>=expires_at AND close_reason IS NOT NULL AND close_reason='reservation_expired'))));
CREATE INDEX commerce_orders_direct_expiry ON commerce_orders(public_shop_id,expires_at,order_id)
  WHERE order_profile='hosted_direct_reservation' AND reservation_state='reserved';

ALTER TABLE commerce_order_lines ALTER COLUMN transfer_id DROP NOT NULL;
ALTER TABLE commerce_order_lines
  ADD COLUMN order_profile text NOT NULL DEFAULT 'imported_reseller',
  ADD CONSTRAINT commerce_line_profile FOREIGN KEY(order_id,order_profile) REFERENCES commerce_orders(order_id,order_profile),
  ADD CONSTRAINT commerce_line_profile_fields CHECK(
    (order_profile='imported_reseller' AND transfer_id IS NOT NULL)
    OR (order_profile='hosted_direct_reservation' AND transfer_id IS NULL AND acceptance_id IS NULL AND listing_sha256 IS NULL));
-- Financial authorities can reference only real imported orders, including direct SQL callers.
ALTER TABLE commerce_transfers ADD COLUMN order_profile text NOT NULL DEFAULT 'imported_reseller' CHECK(order_profile='imported_reseller'),
  ADD CONSTRAINT commerce_transfer_imported_order FOREIGN KEY(order_id,order_profile) REFERENCES commerce_orders(order_id,order_profile);
ALTER TABLE commerce_payment_events ADD COLUMN order_profile text NOT NULL DEFAULT 'imported_reseller' CHECK(order_profile='imported_reseller'),
  ADD CONSTRAINT commerce_payment_imported_order FOREIGN KEY(order_id,order_profile) REFERENCES commerce_orders(order_id,order_profile);
ALTER TABLE commerce_supplier_payables ADD COLUMN order_profile text NOT NULL DEFAULT 'imported_reseller' CHECK(order_profile='imported_reseller'),
  ADD CONSTRAINT commerce_payable_imported_order FOREIGN KEY(order_id,order_profile) REFERENCES commerce_orders(order_id,order_profile);

CREATE FUNCTION preserve_commerce_order_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.order_profile IS DISTINCT FROM OLD.order_profile THEN
    RAISE EXCEPTION 'order profile is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.order_profile='hosted_direct_reservation' AND
    (ROW(NEW.order_id,NEW.public_shop_id,NEW.external_id,NEW.request_sha256,NEW.currency,NEW.total_minor,NEW.buyer_payment,
      NEW.expires_at,NEW.created_at,NEW.quote_id,NEW.buyer_principal_id,NEW.client_order_id)
    IS DISTINCT FROM ROW(OLD.order_id,OLD.public_shop_id,OLD.external_id,OLD.request_sha256,OLD.currency,OLD.total_minor,OLD.buyer_payment,
      OLD.expires_at,OLD.created_at,OLD.quote_id,OLD.buyer_principal_id,OLD.client_order_id)
    OR OLD.reservation_state<>'reserved' OR NEW.reservation_state NOT IN ('cancelled','expired')
    OR NEW.reservation_version<>OLD.reservation_version+1) THEN
    RAISE EXCEPTION 'direct order permits one terminal transition only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_order_profile BEFORE UPDATE ON commerce_orders
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_order_profile();
CREATE FUNCTION preserve_commerce_direct_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.order_profile='hosted_direct_reservation' OR (TG_OP='UPDATE' AND NEW.order_profile IS DISTINCT FROM OLD.order_profile) THEN
    RAISE EXCEPTION 'direct order line is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_direct_line BEFORE UPDATE OR DELETE ON commerce_order_lines
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_direct_line();

CREATE FUNCTION check_commerce_direct_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.order_profile='hosted_direct_reservation' AND NOT EXISTS (
    SELECT 1 FROM commerce_orders o
    JOIN commerce_order_quotes quote ON quote.quote_id=o.quote_id
    JOIN commerce_storefront_profiles p ON p.tenant_id=quote.tenant_id AND p.instance_id=quote.instance_id AND p.storefront_shop_id=o.public_shop_id
    JOIN commerce_selections selection ON selection.selection_id=NEW.selection_id AND selection.shop_id=o.public_shop_id AND selection.item_id=NEW.item_id
    JOIN commerce_items item ON item.item_id=NEW.item_id AND item.shop_id=p.supply_shop_id
    JOIN commerce_resource_tenants retail ON retail.resource_kind='shop' AND retail.resource_id=p.storefront_shop_id AND retail.tenant_id=p.tenant_id AND retail.instance_id=p.instance_id AND retail.mapping_state='confirmed'
    JOIN commerce_resource_tenants supply ON supply.resource_kind='shop' AND supply.resource_id=p.supply_shop_id AND supply.tenant_id=p.tenant_id AND supply.instance_id=p.instance_id AND supply.mapping_state='confirmed'
    WHERE o.order_id=NEW.order_id AND o.reservation_state='reserved'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(quote.bindings) b WHERE b->>'selection_id'=NEW.selection_id::text
        AND b->>'item_id'=NEW.item_id::text AND (b->>'quantity')::integer=NEW.quantity)
  ) THEN RAISE EXCEPTION 'direct line must match its exact quoted store and quantity' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_commerce_direct_line BEFORE INSERT OR UPDATE ON commerce_order_lines
  FOR EACH ROW EXECUTE FUNCTION check_commerce_direct_line();
