-- Same-database shared-stock reservation profile. No admission is enabled.
-- Original direct/imported profiles and financial-table profile FKs remain closed.
ALTER TABLE commerce_order_quotes ADD COLUMN quote_profile text NOT NULL DEFAULT 'hosted_direct_reservation'
  CHECK(quote_profile IN ('hosted_direct_reservation','hosted_shared_reservation')),
  ADD CONSTRAINT commerce_quote_profile_identity UNIQUE(quote_id,public_shop_id,buyer_principal_id,quote_profile),
  ADD CONSTRAINT commerce_quote_profile_terms CHECK(terms->>'profile' IS NOT NULL AND terms->>'profile'=CASE quote_profile
    WHEN 'hosted_direct_reservation' THEN 'freedom.hosted-direct-order-reservation/v1'
    ELSE 'freedom.hosted-shared-order-reservation/v1' END);
ALTER TABLE commerce_orders DROP CONSTRAINT commerce_orders_order_profile_check,
  ADD CONSTRAINT commerce_orders_order_profile_check CHECK(order_profile IN ('imported_reseller','hosted_direct_reservation','hosted_shared_reservation')),
  DROP CONSTRAINT commerce_order_profile_fields,
  ADD CONSTRAINT commerce_order_profile_fields CHECK(
    (order_profile='imported_reseller' AND quote_id IS NULL AND buyer_principal_id IS NULL AND client_order_id IS NULL
      AND reservation_state IS NULL AND reservation_version IS NULL AND closed_at IS NULL AND close_reason IS NULL)
    OR (order_profile IN ('hosted_direct_reservation','hosted_shared_reservation') AND quote_id IS NOT NULL AND buyer_principal_id IS NOT NULL AND client_order_id IS NOT NULL
      AND buyer_payment='pending' AND reservation_version IS NOT NULL AND reservation_version>0
      AND expires_at=created_at+interval '30 minutes' AND reservation_state IS NOT NULL
      AND ((reservation_state='reserved' AND closed_at IS NULL AND close_reason IS NULL)
        OR (reservation_state='cancelled' AND closed_at IS NOT NULL AND closed_at>=created_at AND closed_at<expires_at
          AND close_reason IS NOT NULL AND close_reason IN ('buyer_cancelled','seller_cancelled'))
        OR (reservation_state='expired' AND closed_at IS NOT NULL AND closed_at>=expires_at AND close_reason IS NOT NULL AND close_reason='reservation_expired'))));
ALTER TABLE commerce_orders ADD CONSTRAINT commerce_order_quote_profile
  FOREIGN KEY(quote_id,public_shop_id,buyer_principal_id,order_profile)
  REFERENCES commerce_order_quotes(quote_id,public_shop_id,buyer_principal_id,quote_profile);
ALTER TABLE commerce_items ADD CONSTRAINT commerce_item_exact_supply UNIQUE(item_id,shop_id);
ALTER TABLE commerce_order_lines ADD COLUMN supplier_shop_id uuid,
  ADD COLUMN hosted_offer_id uuid,
  ADD CONSTRAINT commerce_line_exact_supply FOREIGN KEY(item_id,supplier_shop_id) REFERENCES commerce_items(item_id,shop_id),
  ADD CONSTRAINT commerce_line_exact_offer FOREIGN KEY(hosted_offer_id,item_id) REFERENCES commerce_hosted_supply_offers(offer_id,item_id),
  DROP CONSTRAINT commerce_line_profile_fields,
  ADD CONSTRAINT commerce_line_profile_fields CHECK(
    (order_profile='imported_reseller' AND transfer_id IS NOT NULL AND supplier_shop_id IS NULL AND hosted_offer_id IS NULL)
    OR (order_profile='hosted_direct_reservation' AND transfer_id IS NULL AND acceptance_id IS NULL AND listing_sha256 IS NULL
      AND supplier_shop_id IS NULL AND hosted_offer_id IS NULL)
    OR (order_profile='hosted_shared_reservation' AND transfer_id IS NULL AND supplier_shop_id IS NOT NULL
      AND ((hosted_offer_id IS NULL AND acceptance_id IS NULL AND listing_sha256 IS NULL)
        OR (hosted_offer_id IS NOT NULL AND acceptance_id IS NOT NULL AND listing_sha256 IS NOT NULL))));
CREATE INDEX commerce_shared_reservation_supply ON commerce_order_lines(supplier_shop_id,order_id)
  WHERE order_profile='hosted_shared_reservation';
CREATE INDEX commerce_reservations_expiry ON commerce_orders(expires_at,order_id)
  WHERE order_profile IN ('hosted_direct_reservation','hosted_shared_reservation') AND reservation_state='reserved';

-- A closed buyer adapter binds the exact seller, not the buyer's community.
-- Read only offers already referenced by that seller's selections. This permits
-- cross-community ordinary buyers without granting tenant membership or a catalog.
CREATE POLICY commerce_hosted_offer_selected_read ON commerce_hosted_supply_offers FOR SELECT TO PUBLIC
  USING(EXISTS(SELECT 1 FROM commerce_selections l JOIN commerce_storefront_profiles p ON p.storefront_shop_id=l.shop_id
    WHERE p.tenant_id=freedom_ctx_tenant() AND l.hosted_offer_id=commerce_hosted_supply_offers.offer_id));

CREATE OR REPLACE FUNCTION preserve_commerce_order_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.order_profile IS DISTINCT FROM OLD.order_profile THEN
    RAISE EXCEPTION 'order profile is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.order_profile IN ('hosted_direct_reservation','hosted_shared_reservation') AND
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

CREATE OR REPLACE FUNCTION preserve_commerce_direct_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.order_profile IN ('hosted_direct_reservation','hosted_shared_reservation') OR (TG_OP='UPDATE' AND NEW.order_profile IS DISTINCT FROM OLD.order_profile) THEN
    RAISE EXCEPTION 'direct order line is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION check_commerce_shared_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.order_profile='hosted_shared_reservation' AND NOT EXISTS(
    SELECT 1 FROM commerce_orders o
    JOIN commerce_order_quotes quote ON quote.quote_id=o.quote_id AND quote.quote_profile=o.order_profile
    JOIN commerce_storefront_profiles seller ON seller.storefront_shop_id=o.public_shop_id
      AND seller.tenant_id=quote.tenant_id AND seller.instance_id=quote.instance_id
    JOIN commerce_selections l ON l.selection_id=NEW.selection_id AND l.shop_id=o.public_shop_id AND l.item_id=NEW.item_id
    JOIN commerce_items i ON i.item_id=NEW.item_id AND i.shop_id=NEW.supplier_shop_id
    JOIN commerce_storefront_profiles supplier ON supplier.supply_shop_id=i.shop_id
    JOIN commerce_shops ss ON ss.shop_id=supplier.supply_shop_id AND ss.origin='hosted'
    JOIN commerce_shops retail ON retail.shop_id=seller.storefront_shop_id AND retail.origin='hosted'
      AND retail.community_id=ss.community_id AND retail.currency=ss.currency
    LEFT JOIN commerce_hosted_supply_offers offer ON offer.offer_id=NEW.hosted_offer_id AND offer.item_id=i.item_id
      AND offer.tenant_id=supplier.tenant_id AND offer.instance_id=supplier.instance_id
    LEFT JOIN commerce_distribution_acceptances a ON a.acceptance_id=NEW.acceptance_id AND a.selection_id=l.selection_id
    WHERE o.order_id=NEW.order_id AND o.reservation_state='reserved' AND o.currency=retail.currency
      AND seller.reservation_enabled AND supplier.reservation_enabled
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(quote.bindings) b
        WHERE b->>'selection_id'=NEW.selection_id::text AND b->>'item_id'=NEW.item_id::text
          AND b->>'supplier_shop_id'=NEW.supplier_shop_id::text AND b->>'supplier_instance_id'=supplier.instance_id::text
          AND b->>'sku'=COALESCE(l.hosted_sku,i.sku) AND b->>'version'=l.aggregate_version::text AND (b->>'quantity')::integer=NEW.quantity
          AND b->>'offer_id' IS NOT DISTINCT FROM NEW.hosted_offer_id::text
          AND b->>'acceptance_id' IS NOT DISTINCT FROM NEW.acceptance_id::text
          AND b->>'listing_sha256' IS NOT DISTINCT FROM NEW.listing_sha256
          AND NEW.snapshot IN (SELECT value FROM jsonb_array_elements(quote.terms->'items')
            WHERE value->>'sku'=b->>'sku' AND (value->>'quantity')::integer=NEW.quantity
              AND (value->>'unit_price_minor')::bigint=l.retail_price_minor)
          AND ((NEW.hosted_offer_id IS NULL AND supplier.instance_id=seller.instance_id AND l.hosted_offer_id IS NULL
              AND NEW.snapshot->>'title'=i.title)
            OR (supplier.instance_id<>seller.instance_id AND l.hosted_offer_id=offer.offer_id AND offer.state='offered'
              AND NEW.snapshot->>'title'=offer.terms->>'title'
              AND b->>'offer_sha256'=offer.terms_sha256 AND l.snapshot->>'offer_sha256'=offer.terms_sha256
              AND l.acceptance_state='sellable' AND l.current_acceptance_id=a.acceptance_id AND a.decision='accepted'
              AND l.listing_sha256=NEW.listing_sha256 AND a.listing_sha256=NEW.listing_sha256)))
  ) THEN RAISE EXCEPTION 'shared line must match exact quoted supply and consent' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_commerce_shared_line BEFORE INSERT OR UPDATE ON commerce_order_lines
  FOR EACH ROW EXECUTE FUNCTION check_commerce_shared_line();
