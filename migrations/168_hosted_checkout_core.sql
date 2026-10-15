-- Expand-only transaction core. No route, store admission or payment capability
-- is enabled here. Hosted v1 reservations and imported finance stay separate.
ALTER TABLE commerce_orders DROP CONSTRAINT commerce_orders_order_profile_check,
  ADD CONSTRAINT commerce_orders_order_profile_check CHECK(order_profile IN
    ('imported_reseller','hosted_direct_reservation','hosted_shared_reservation','hosted_checkout')),
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
        OR (reservation_state='expired' AND closed_at IS NOT NULL AND closed_at>=expires_at AND close_reason IS NOT NULL AND close_reason='reservation_expired')))
    OR (order_profile='hosted_checkout' AND quote_id IS NULL AND reservation_state IS NULL
      AND reservation_version IS NULL AND closed_at IS NULL AND close_reason IS NULL
      AND client_order_id IS NOT NULL AND buyer_payment='pending' AND expires_at=created_at+interval '30 minutes'));

-- v1 keeps its original per-buyer intent namespace. Checkout intents belong to
-- a checkout, including guests; external_id and the sidecar bind that namespace.
ALTER TABLE commerce_orders DROP CONSTRAINT commerce_order_direct_intent;
CREATE UNIQUE INDEX commerce_order_direct_intent ON commerce_orders(public_shop_id,buyer_principal_id,client_order_id)
  WHERE order_profile IN ('hosted_direct_reservation','hosted_shared_reservation');
CREATE INDEX commerce_checkout_order_expiry ON commerce_orders(expires_at,order_id) WHERE order_profile='hosted_checkout';
ALTER TABLE commerce_order_lines DROP CONSTRAINT commerce_line_profile_fields,
  ADD CONSTRAINT commerce_line_profile_fields CHECK(
    (order_profile='imported_reseller' AND transfer_id IS NOT NULL AND supplier_shop_id IS NULL AND hosted_offer_id IS NULL)
    OR (order_profile='hosted_direct_reservation' AND transfer_id IS NULL AND acceptance_id IS NULL AND listing_sha256 IS NULL
      AND supplier_shop_id IS NULL AND hosted_offer_id IS NULL)
    OR (order_profile IN ('hosted_shared_reservation','hosted_checkout') AND transfer_id IS NULL AND supplier_shop_id IS NOT NULL
      AND ((hosted_offer_id IS NULL AND acceptance_id IS NULL AND listing_sha256 IS NULL)
        OR (hosted_offer_id IS NOT NULL AND acceptance_id IS NOT NULL AND listing_sha256 IS NOT NULL))));

CREATE OR REPLACE FUNCTION preserve_commerce_order_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.order_profile IS DISTINCT FROM OLD.order_profile OR OLD.order_profile='hosted_checkout' THEN
    RAISE EXCEPTION 'order profile and checkout order are immutable' USING ERRCODE='23514';
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
  IF OLD.order_profile IN ('hosted_direct_reservation','hosted_shared_reservation','hosted_checkout')
    OR (TG_OP='UPDATE' AND NEW.order_profile IS DISTINCT FROM OLD.order_profile) THEN
    RAISE EXCEPTION 'hosted order line is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE commerce_storefront_profiles ADD CONSTRAINT commerce_storefront_tenant_instance UNIQUE(tenant_id,instance_id);
CREATE TABLE commerce_customers (
  customer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  email_normalized text NOT NULL CHECK(email_normalized=lower(btrim(email_normalized)) AND char_length(email_normalized) BETWEEN 3 AND 254),
  email_verified_at timestamptz,
  member_principal_id uuid REFERENCES principals(principal_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  redacted_at timestamptz,
  CHECK((redacted_at IS NULL AND email_normalized NOT LIKE 'redacted:%') OR
    (redacted_at IS NOT NULL AND redacted_at>=created_at AND email_normalized='redacted:'||customer_id::text AND email_verified_at IS NULL)),
  FOREIGN KEY(tenant_id,instance_id) REFERENCES commerce_storefront_profiles(tenant_id,instance_id),
  UNIQUE(instance_id,email_normalized), UNIQUE(customer_id,tenant_id,instance_id)
);
CREATE INDEX commerce_customers_store ON commerce_customers(tenant_id,instance_id);
CREATE INDEX commerce_customers_member ON commerce_customers(member_principal_id) WHERE member_principal_id IS NOT NULL;
ALTER TABLE commerce_customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_customers_tenant ON commerce_customers FOR ALL TO PUBLIC
  USING(tenant_id=freedom_ctx_tenant()) WITH CHECK(tenant_id=freedom_ctx_tenant());

-- Freeze request_sha256 columns are HMAC-SHA256 keyed by the plaintext UTF-8
-- idempotency key. The plaintext key is never stored.
CREATE TABLE commerce_checkouts (
  checkout_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  publication_revision bigint NOT NULL CHECK(publication_revision>0),
  currency text NOT NULL CHECK(currency IN ('TWD','USD')),
  terms_profile text NOT NULL DEFAULT 'freedom.checkout-terms/v1' CHECK(terms_profile='freedom.checkout-terms/v1'),
  terms jsonb NOT NULL CHECK(jsonb_typeof(terms)='object'),
  terms_sha256 text NOT NULL CHECK(terms_sha256 ~ '^[a-f0-9]{64}$'),
  current_contact_id uuid NOT NULL,
  idempotency_key_sha256 text NOT NULL CHECK(idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK(expires_at=created_at+interval '24 hours'),
  FOREIGN KEY(customer_id,tenant_id,instance_id) REFERENCES commerce_customers(customer_id,tenant_id,instance_id),
  UNIQUE(instance_id,idempotency_key_sha256), UNIQUE(checkout_id,tenant_id,instance_id)
);
CREATE INDEX commerce_checkouts_store ON commerce_checkouts(tenant_id,instance_id,created_at,checkout_id);
CREATE INDEX commerce_checkouts_customer ON commerce_checkouts(customer_id,tenant_id,instance_id);
CREATE INDEX commerce_checkouts_contact ON commerce_checkouts(current_contact_id);

CREATE TABLE commerce_checkout_contacts (
  contact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  contact_name text,
  contact_email text,
  contact_phone text,
  delivery jsonb,
  invoice jsonb,
  contact_salt text,
  contact_sha256 text NOT NULL CHECK(contact_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  redacted_at timestamptz,
  FOREIGN KEY(checkout_id,tenant_id,instance_id) REFERENCES commerce_checkouts(checkout_id,tenant_id,instance_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(contact_id,checkout_id,tenant_id,instance_id),
  CHECK((redacted_at IS NULL AND contact_salt IS NOT NULL AND contact_salt ~ '^[a-f0-9]{32}$' AND char_length(contact_name) BETWEEN 1 AND 120 AND contact_name IS NOT NULL
    AND char_length(contact_email) BETWEEN 3 AND 254 AND contact_email IS NOT NULL
    AND char_length(contact_phone) BETWEEN 1 AND 40 AND contact_phone IS NOT NULL
    AND delivery IS NOT NULL AND jsonb_typeof(delivery)='object' AND octet_length(delivery::text)<=8192
    AND (invoice IS NULL OR (jsonb_typeof(invoice)='object' AND octet_length(invoice::text)<=4096)))
    OR (redacted_at IS NOT NULL AND redacted_at>=created_at AND contact_name IS NULL AND contact_email IS NULL
      AND contact_phone IS NULL AND delivery IS NULL AND invoice IS NULL AND contact_salt IS NULL))
);
CREATE INDEX commerce_checkout_contacts_checkout ON commerce_checkout_contacts(checkout_id,tenant_id,instance_id);
CREATE INDEX commerce_checkout_contacts_store ON commerce_checkout_contacts(tenant_id,instance_id);
ALTER TABLE commerce_checkouts ADD CONSTRAINT commerce_checkout_current_contact
  FOREIGN KEY(current_contact_id,checkout_id,tenant_id,instance_id)
  REFERENCES commerce_checkout_contacts(contact_id,checkout_id,tenant_id,instance_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE commerce_checkout_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_checkout_contacts_tenant ON commerce_checkout_contacts FOR ALL TO PUBLIC
  USING(tenant_id=freedom_ctx_tenant()) WITH CHECK(tenant_id=freedom_ctx_tenant());

-- Revision commands retain each hashed idempotency key and its non-PII reply.
-- A new revision cannot erase the identity of an earlier successful command.
CREATE TABLE commerce_checkout_idempotency_keys (
  checkout_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  idempotency_key_sha256 text NOT NULL CHECK(idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL CHECK(jsonb_typeof(response)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(instance_id,idempotency_key_sha256),
  FOREIGN KEY(checkout_id,tenant_id,instance_id) REFERENCES commerce_checkouts(checkout_id,tenant_id,instance_id)
);
CREATE INDEX commerce_checkout_idempotency_checkout ON commerce_checkout_idempotency_keys(checkout_id,tenant_id,instance_id);
CREATE INDEX commerce_checkout_idempotency_store ON commerce_checkout_idempotency_keys(tenant_id,instance_id);

CREATE TABLE commerce_checkout_orders (
  order_id uuid PRIMARY KEY,
  order_profile text NOT NULL DEFAULT 'hosted_checkout' CHECK(order_profile='hosted_checkout'),
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  checkout_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  display_number text NOT NULL CHECK(display_number ~ '^[0-9]{6}-[0-9A-HJKMNP-TV-Z]{6}$'),
  terms jsonb NOT NULL CHECK(jsonb_typeof(terms)='object'),
  terms_sha256 text NOT NULL CHECK(terms_sha256 ~ '^[a-f0-9]{64}$'),
  environment text NOT NULL CHECK(environment IN ('sandbox','live')),
  lifecycle_state text NOT NULL DEFAULT 'open' CHECK(lifecycle_state IN ('open','cancelled','closed')),
  cancel_reason text CHECK(cancel_reason IN ('buyer_cancelled','seller_cancelled','payment_not_completed','paid_cancelled')),
  cancelled_at timestamptz,
  closed_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  FOREIGN KEY(order_id,order_profile) REFERENCES commerce_orders(order_id,order_profile),
  FOREIGN KEY(checkout_id,tenant_id,instance_id) REFERENCES commerce_checkouts(checkout_id,tenant_id,instance_id),
  FOREIGN KEY(customer_id,tenant_id,instance_id) REFERENCES commerce_customers(customer_id,tenant_id,instance_id),
  FOREIGN KEY(contact_id,checkout_id,tenant_id,instance_id) REFERENCES commerce_checkout_contacts(contact_id,checkout_id,tenant_id,instance_id),
  UNIQUE(instance_id,display_number),
  CHECK((lifecycle_state='open' AND cancel_reason IS NULL AND cancelled_at IS NULL AND closed_at IS NULL)
    OR (lifecycle_state='cancelled' AND cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL AND closed_at IS NULL)
    OR (lifecycle_state='closed' AND cancel_reason IS NULL AND cancelled_at IS NULL AND closed_at IS NOT NULL))
);
CREATE INDEX commerce_checkout_orders_checkout ON commerce_checkout_orders(checkout_id,tenant_id,instance_id,lifecycle_state,order_id);
CREATE INDEX commerce_checkout_orders_store ON commerce_checkout_orders(tenant_id,instance_id,lifecycle_state,order_id);
CREATE INDEX commerce_checkout_orders_customer ON commerce_checkout_orders(customer_id,tenant_id,instance_id);
CREATE INDEX commerce_checkout_orders_contact ON commerce_checkout_orders(contact_id,checkout_id,tenant_id,instance_id);

CREATE TABLE commerce_checkout_payment_applications (
  application_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES commerce_checkout_orders(order_id),
  payment_ref uuid NOT NULL UNIQUE,
  amount_minor bigint NOT NULL CHECK(amount_minor>=0),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  outcome text NOT NULL CHECK(outcome IN ('converted','allocated','unallocatable','after_cancel','overpaid','amount_mismatch','simulated')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(application_id,order_id)
);
CREATE INDEX commerce_checkout_payment_order ON commerce_checkout_payment_applications(order_id,created_at,application_id);

CREATE TABLE commerce_inventory_allocations (
  allocation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES commerce_checkout_orders(order_id),
  item_id uuid NOT NULL,
  supplier_shop_id uuid NOT NULL,
  quantity integer NOT NULL CHECK(quantity>0),
  shipped_quantity integer NOT NULL DEFAULT 0 CHECK(shipped_quantity>=0),
  released_quantity integer NOT NULL DEFAULT 0 CHECK(released_quantity>=0),
  source_reservation_id uuid UNIQUE REFERENCES commerce_inventory_reservations(reservation_id),
  payment_application_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(item_id,supplier_shop_id) REFERENCES commerce_items(item_id,shop_id),
  FOREIGN KEY(payment_application_id,order_id) REFERENCES commerce_checkout_payment_applications(application_id,order_id),
  UNIQUE(order_id,item_id), UNIQUE(allocation_id,order_id,item_id),
  CHECK(shipped_quantity+released_quantity<=quantity)
);
CREATE INDEX commerce_inventory_allocation_item ON commerce_inventory_allocations(item_id,supplier_shop_id);
CREATE INDEX commerce_inventory_allocation_supplier ON commerce_inventory_allocations(supplier_shop_id,order_id);
CREATE INDEX commerce_inventory_allocation_payment ON commerce_inventory_allocations(payment_application_id,order_id);

CREATE TABLE commerce_inventory_movements (
  movement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK(kind IN ('convert','allocate','allocation_release','ship','restock')),
  item_id uuid NOT NULL REFERENCES commerce_items(item_id),
  order_id uuid NOT NULL REFERENCES commerce_checkout_orders(order_id),
  allocation_id uuid,
  source_ref uuid NOT NULL,
  quantity integer NOT NULL CHECK(quantity>0),
  delta_stock integer NOT NULL,
  delta_reserved integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(allocation_id,order_id,item_id) REFERENCES commerce_inventory_allocations(allocation_id,order_id,item_id),
  UNIQUE NULLS NOT DISTINCT(kind,source_ref,allocation_id),
  CHECK((kind='convert' AND delta_stock=0 AND delta_reserved=0)
    OR (kind='allocate' AND delta_stock=0 AND delta_reserved=quantity)
    OR (kind='allocation_release' AND delta_stock=0 AND delta_reserved=-quantity)
    OR (kind='ship' AND delta_stock=-quantity AND delta_reserved=-quantity)
    OR (kind='restock' AND delta_stock=quantity AND delta_reserved=0))
);
CREATE INDEX commerce_inventory_movement_item ON commerce_inventory_movements(item_id,created_at,movement_id);
CREATE INDEX commerce_inventory_movement_order ON commerce_inventory_movements(order_id);
CREATE INDEX commerce_inventory_movement_allocation ON commerce_inventory_movements(allocation_id,order_id,item_id);
CREATE INDEX commerce_inventory_movement_source ON commerce_inventory_movements(source_ref,kind);

-- Even an unallocatable paid cancellation has a durable command identity.
CREATE TABLE commerce_checkout_allocation_commands (
  command_ref text PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES commerce_checkout_orders(order_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX commerce_checkout_allocation_command_order ON commerce_checkout_allocation_commands(order_id);

CREATE FUNCTION preserve_commerce_checkout_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'checkout history is retained and append-only' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER preserve_commerce_customers_delete BEFORE DELETE ON commerce_customers FOR EACH ROW EXECUTE FUNCTION preserve_commerce_checkout_history();
CREATE TRIGGER preserve_commerce_checkouts_delete BEFORE DELETE ON commerce_checkouts FOR EACH ROW EXECUTE FUNCTION preserve_commerce_checkout_history();
CREATE TRIGGER preserve_commerce_contacts_delete BEFORE DELETE ON commerce_checkout_contacts FOR EACH ROW EXECUTE FUNCTION preserve_commerce_checkout_history();
CREATE TRIGGER preserve_commerce_checkout_orders_delete BEFORE DELETE ON commerce_checkout_orders FOR EACH ROW EXECUTE FUNCTION preserve_commerce_checkout_history();
CREATE TRIGGER preserve_commerce_allocations_delete BEFORE DELETE ON commerce_inventory_allocations FOR EACH ROW EXECUTE FUNCTION preserve_commerce_checkout_history();
CREATE TRIGGER preserve_commerce_payment_application BEFORE UPDATE OR DELETE ON commerce_checkout_payment_applications FOR EACH ROW EXECUTE FUNCTION preserve_commerce_checkout_history();
CREATE TRIGGER preserve_commerce_checkout_idempotency BEFORE UPDATE OR DELETE ON commerce_checkout_idempotency_keys FOR EACH ROW EXECUTE FUNCTION preserve_commerce_checkout_history();
CREATE TRIGGER preserve_commerce_allocation_command BEFORE UPDATE OR DELETE ON commerce_checkout_allocation_commands FOR EACH ROW EXECUTE FUNCTION preserve_commerce_checkout_history();
CREATE TRIGGER preserve_commerce_inventory_movement BEFORE UPDATE OR DELETE ON commerce_inventory_movements FOR EACH ROW EXECUTE FUNCTION preserve_commerce_checkout_history();
CREATE TRIGGER preserve_commerce_checkout_base_delete BEFORE DELETE ON commerce_orders
  FOR EACH ROW WHEN (OLD.order_profile='hosted_checkout') EXECUTE FUNCTION preserve_commerce_checkout_history();

-- Customer identity and optional labels cannot be retargeted. Redaction replaces
-- the email once, allowing a future real-email checkout to create a new customer.
CREATE FUNCTION preserve_commerce_customer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE redacting boolean := OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL;
BEGIN
  IF (to_jsonb(NEW)-ARRAY['email_normalized','email_verified_at','member_principal_id','redacted_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['email_normalized','email_verified_at','member_principal_id','redacted_at'])
    OR OLD.redacted_at IS NOT NULL
    OR (OLD.member_principal_id IS NOT NULL AND NEW.member_principal_id IS DISTINCT FROM OLD.member_principal_id)
    OR (OLD.email_verified_at IS NOT NULL AND NEW.email_verified_at IS DISTINCT FROM OLD.email_verified_at AND NOT redacting)
    OR (NEW.email_normalized IS DISTINCT FROM OLD.email_normalized AND NOT redacting) THEN
    RAISE EXCEPTION 'customer identity is immutable and permits one redaction only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_customer BEFORE UPDATE ON commerce_customers FOR EACH ROW EXECUTE FUNCTION preserve_commerce_customer();

-- A contact can be erased once without rewriting the digest retained in terms.
CREATE FUNCTION preserve_commerce_checkout_contact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['contact_name','contact_email','contact_phone','delivery','invoice','contact_salt','redacted_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['contact_name','contact_email','contact_phone','delivery','invoice','contact_salt','redacted_at'])
    OR OLD.redacted_at IS NOT NULL OR NEW.redacted_at IS NULL THEN
    RAISE EXCEPTION 'contact permits one redaction only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_checkout_contact BEFORE UPDATE ON commerce_checkout_contacts FOR EACH ROW EXECUTE FUNCTION preserve_commerce_checkout_contact();
CREATE FUNCTION preserve_commerce_checkout_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['lifecycle_state','cancel_reason','cancelled_at','closed_at','version'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['lifecycle_state','cancel_reason','cancelled_at','closed_at','version'])
    OR OLD.lifecycle_state<>'open' OR NEW.lifecycle_state NOT IN ('cancelled','closed') OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'checkout order permits one terminal transition only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_checkout_order BEFORE UPDATE ON commerce_checkout_orders FOR EACH ROW EXECUTE FUNCTION preserve_commerce_checkout_order();
CREATE FUNCTION preserve_commerce_inventory_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['shipped_quantity','released_quantity']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['shipped_quantity','released_quantity'])
    OR NEW.shipped_quantity<OLD.shipped_quantity OR NEW.released_quantity<OLD.released_quantity THEN
    RAISE EXCEPTION 'allocation identity is immutable and counters only increase' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_inventory_allocation BEFORE UPDATE ON commerce_inventory_allocations FOR EACH ROW EXECUTE FUNCTION preserve_commerce_inventory_allocation();

-- Canonical terms use recursive key order, preserved array order, integer JSON
-- numbers and no whitespace. Terms keys are ASCII; this is not RFC 8785.
CREATE FUNCTION commerce_checkout_canonical(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE jsonb_typeof(value)
    WHEN 'object' THEN '{'||coalesce((SELECT string_agg(to_jsonb(key)::text||':'||commerce_checkout_canonical(v),',' ORDER BY key COLLATE "C") FROM jsonb_each(value) e(key,v)),'')||'}'
    WHEN 'array' THEN '['||coalesce((SELECT string_agg(commerce_checkout_canonical(v),',' ORDER BY n) FROM jsonb_array_elements(value) WITH ORDINALITY e(v,n)),'')||']'
    ELSE value::text END
$$;
CREATE FUNCTION commerce_checkout_hash(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT encode(sha256(convert_to(commerce_checkout_canonical(value),'UTF8')),'hex')
$$;
CREATE FUNCTION preserve_commerce_checkout() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.checkout_id,NEW.tenant_id,NEW.instance_id,NEW.created_at,NEW.expires_at,NEW.idempotency_key_sha256,NEW.request_sha256)
    IS DISTINCT FROM ROW(OLD.checkout_id,OLD.tenant_id,OLD.instance_id,OLD.created_at,OLD.expires_at,OLD.idempotency_key_sha256,OLD.request_sha256)
    OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'checkout identity is immutable and version increases by one' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_checkout BEFORE UPDATE ON commerce_checkouts FOR EACH ROW EXECUTE FUNCTION preserve_commerce_checkout();
CREATE FUNCTION check_commerce_checkout_terms() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c commerce_checkouts; h text;
BEGIN
  SELECT * INTO c FROM commerce_checkouts WHERE checkout_id=NEW.checkout_id;
  SELECT contact_sha256 INTO h FROM commerce_checkout_contacts WHERE contact_id=c.current_contact_id
    AND checkout_id=c.checkout_id AND tenant_id=c.tenant_id AND instance_id=c.instance_id;
  IF h IS NULL OR c.terms->>'contact_sha256' IS DISTINCT FROM h OR c.terms->>'profile' IS DISTINCT FROM c.terms_profile
    OR c.terms->>'publication_revision' IS DISTINCT FROM c.publication_revision::text OR c.terms->>'currency' IS DISTINCT FROM c.currency
    OR c.terms_sha256<>commerce_checkout_hash(c.terms) THEN
    RAISE EXCEPTION 'checkout terms must cover the exact current contact digest' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_commerce_checkout_terms AFTER INSERT OR UPDATE ON commerce_checkouts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_commerce_checkout_terms();

CREATE FUNCTION check_commerce_checkout_order_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM commerce_orders o JOIN commerce_checkouts c ON c.checkout_id=NEW.checkout_id
    JOIN commerce_storefront_profiles p ON p.tenant_id=c.tenant_id AND p.instance_id=c.instance_id
    WHERE o.order_id=NEW.order_id AND o.order_profile='hosted_checkout' AND o.public_shop_id=p.storefront_shop_id
      AND NEW.tenant_id=c.tenant_id AND NEW.instance_id=c.instance_id AND NEW.customer_id=c.customer_id AND NEW.contact_id=c.current_contact_id
      AND NEW.terms=c.terms AND NEW.terms_sha256=c.terms_sha256 AND o.currency=c.currency
      AND o.total_minor=(NEW.terms->>'total_minor')::bigint
      AND o.external_id='chk:'||c.checkout_id::text||':'||o.client_order_id::text
      AND left(NEW.display_number,6)=to_char(o.created_at AT TIME ZONE 'Asia/Taipei','YYMMDD')
      AND NEW.lifecycle_state='open' AND NEW.version=1) THEN
    RAISE EXCEPTION 'checkout sidecar must freeze exact store, contact and terms' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_commerce_checkout_order_identity BEFORE INSERT ON commerce_checkout_orders FOR EACH ROW EXECUTE FUNCTION check_commerce_checkout_order_identity();
CREATE UNIQUE INDEX commerce_checkout_line_item ON commerce_order_lines(order_id,item_id) WHERE order_profile='hosted_checkout';
CREATE FUNCTION check_commerce_checkout_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t jsonb; target uuid;
BEGIN
  target:=NEW.order_id;
  IF NOT EXISTS(SELECT 1 FROM commerce_orders WHERE order_id=target AND order_profile='hosted_checkout') THEN RETURN NULL; END IF;
  SELECT terms INTO t FROM commerce_checkout_orders WHERE order_id=target;
  IF t IS NULL OR jsonb_typeof(t->'bindings') IS DISTINCT FROM 'array' OR jsonb_array_length(t->'bindings') NOT BETWEEN 1 AND 50
    OR (SELECT count(*) FROM commerce_order_lines WHERE order_id=target)<>jsonb_array_length(t->'bindings')
    OR (SELECT count(DISTINCT b->>'item_id') FROM jsonb_array_elements(t->'bindings') b)<>jsonb_array_length(t->'bindings')
    OR (SELECT count(DISTINCT b->>'selection_id') FROM jsonb_array_elements(t->'bindings') b)<>jsonb_array_length(t->'bindings')
    OR (SELECT count(DISTINCT b->>'sku') FROM jsonb_array_elements(t->'bindings') b)<>jsonb_array_length(t->'bindings')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(t->'bindings') b WHERE NOT EXISTS(
      SELECT 1 FROM commerce_order_lines l JOIN commerce_items i ON i.item_id=l.item_id AND i.shop_id=l.supplier_shop_id
      JOIN commerce_shops s ON s.shop_id=i.shop_id AND s.origin='hosted'
      WHERE l.order_id=target AND l.order_profile='hosted_checkout'
        AND l.item_id::text=b->>'item_id' AND l.selection_id::text=b->>'selection_id'
        AND l.supplier_shop_id::text=b->>'supplier_shop_id' AND l.quantity=(b->>'quantity')::integer
        AND l.hosted_offer_id::text IS NOT DISTINCT FROM b->>'offer_id'
        AND l.acceptance_id::text IS NOT DISTINCT FROM b->>'acceptance_id'
        AND l.listing_sha256 IS NOT DISTINCT FROM b->>'listing_sha256'
        AND l.snapshot->>'offer_sha256' IS NOT DISTINCT FROM b->>'offer_sha256'
        AND l.snapshot->>'sku'=b->>'sku'
        AND (l.snapshot->>'unit_price_minor')::bigint=(b->>'unit_price_minor')::bigint
        AND l.snapshot IN (SELECT value FROM jsonb_array_elements(t->'items')))) THEN
    RAISE EXCEPTION 'checkout lines must equal frozen terms bindings' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_commerce_checkout_lines AFTER INSERT ON commerce_order_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_commerce_checkout_lines();
CREATE CONSTRAINT TRIGGER check_commerce_checkout_order_lines AFTER INSERT ON commerce_checkout_orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_commerce_checkout_lines();

CREATE OR REPLACE FUNCTION check_commerce_inventory_balance(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE balance integer; held bigint; allocated bigint;
BEGIN
  SELECT i.reserved INTO balance FROM commerce_items i JOIN commerce_shops s USING(shop_id)
    WHERE i.item_id=target AND s.origin='hosted' FOR UPDATE OF i;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT coalesce(sum(quantity),0) INTO held FROM commerce_inventory_reservations WHERE item_id=target AND state='held';
  SELECT coalesce(sum(quantity-shipped_quantity-released_quantity),0) INTO allocated FROM commerce_inventory_allocations WHERE item_id=target;
  IF balance<>held+allocated THEN RAISE EXCEPTION 'hosted balance must equal holds plus allocations' USING ERRCODE='23514'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION check_commerce_inventory_order(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE profile text;
BEGIN
  SELECT order_profile INTO profile FROM commerce_orders WHERE order_id=target;
  IF profile IS NULL OR profile='imported_reseller' THEN
    IF EXISTS(SELECT 1 FROM commerce_inventory_reservations WHERE order_id=target) THEN
      RAISE EXCEPTION 'inventory hold requires a hosted order' USING ERRCODE='23514';
    END IF;
    RETURN;
  END IF;
  IF profile='hosted_checkout' THEN
    IF NOT EXISTS(SELECT 1 FROM commerce_checkout_orders WHERE order_id=target)
      OR NOT EXISTS(SELECT 1 FROM commerce_order_lines WHERE order_id=target)
      OR EXISTS(
        WITH expected AS (SELECT l.item_id,l.supplier_shop_id,l.quantity FROM commerce_order_lines l WHERE l.order_id=target),
        actual AS (SELECT * FROM commerce_inventory_reservations WHERE order_id=target)
        SELECT 1 FROM expected e FULL JOIN actual h USING(item_id)
        CROSS JOIN commerce_orders o LEFT JOIN commerce_inventory_allocations a ON a.order_id=o.order_id AND a.item_id=e.item_id
        WHERE o.order_id=target AND (e.item_id IS NULL OR h.item_id IS NULL
          OR h.supplier_shop_id IS DISTINCT FROM e.supplier_shop_id OR h.quantity IS DISTINCT FROM e.quantity
          OR h.created_at IS DISTINCT FROM o.created_at OR h.expires_at IS DISTINCT FROM o.expires_at
          OR (a.allocation_id IS NOT NULL AND (a.quantity<>e.quantity OR a.supplier_shop_id<>e.supplier_shop_id OR h.state='held'))))
      OR EXISTS(SELECT 1 FROM commerce_inventory_allocations a WHERE a.order_id=target
        AND NOT EXISTS(SELECT 1 FROM commerce_order_lines l WHERE l.order_id=target AND l.item_id=a.item_id)) THEN
      RAISE EXCEPTION 'checkout order must match durable holds and allocations' USING ERRCODE='23514';
    END IF;
    RETURN;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM commerce_order_lines WHERE order_id=target)
    OR EXISTS(
      WITH expected AS (
        SELECT l.item_id,i.shop_id,sum(l.quantity)::integer AS quantity
        FROM commerce_order_lines l JOIN commerce_items i USING(item_id)
        WHERE l.order_id=target GROUP BY l.item_id,i.shop_id
      ), actual AS (SELECT * FROM commerce_inventory_reservations WHERE order_id=target)
      SELECT 1 FROM expected e FULL JOIN actual a USING(item_id)
      CROSS JOIN commerce_orders o
      WHERE o.order_id=target AND (e.item_id IS NULL OR a.item_id IS NULL
        OR a.supplier_shop_id IS DISTINCT FROM e.shop_id OR a.quantity IS DISTINCT FROM e.quantity
        OR a.created_at IS DISTINCT FROM o.created_at OR a.expires_at IS DISTINCT FROM o.expires_at
        OR (a.state='held') IS DISTINCT FROM (o.reservation_state='reserved'))
    ) THEN RAISE EXCEPTION 'hosted order must match durable holds' USING ERRCODE='23514'; END IF;
END;
$$;

-- Counters and creation must have matching append-only events. These checks
-- close direct SQL paths as well as the TypeScript adapter's balance updates.
CREATE FUNCTION check_commerce_checkout_allocation_events(target uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM commerce_inventory_allocations a
    JOIN commerce_checkout_payment_applications p ON p.application_id=a.payment_application_id
    LEFT JOIN commerce_inventory_reservations h ON h.reservation_id=a.source_reservation_id
    WHERE a.order_id=target AND (p.outcome NOT IN ('converted','allocated','unallocatable')
      OR (a.source_reservation_id IS NOT NULL AND (h.order_id<>a.order_id OR h.item_id<>a.item_id
        OR h.quantity<>a.quantity OR h.state<>'released' OR h.supplier_shop_id<>a.supplier_shop_id))
      OR a.quantity<>(SELECT coalesce(sum(m.quantity),0) FROM commerce_inventory_movements m
        WHERE m.allocation_id=a.allocation_id AND m.kind IN ('convert','allocate'))
      OR a.shipped_quantity<>(SELECT coalesce(sum(m.quantity),0) FROM commerce_inventory_movements m WHERE m.allocation_id=a.allocation_id AND m.kind='ship')
      OR a.released_quantity<>(SELECT coalesce(sum(m.quantity),0) FROM commerce_inventory_movements m WHERE m.allocation_id=a.allocation_id AND m.kind='allocation_release')
      OR a.shipped_quantity<(SELECT coalesce(sum(m.quantity),0) FROM commerce_inventory_movements m WHERE m.allocation_id=a.allocation_id AND m.kind='restock')))
    OR EXISTS(SELECT 1 FROM commerce_inventory_movements m JOIN commerce_inventory_allocations a USING(allocation_id)
      WHERE m.order_id=target AND ((m.kind='convert' AND (a.source_reservation_id IS NULL OR m.source_ref<>a.source_reservation_id))
        OR (m.kind='allocate' AND (a.source_reservation_id IS NOT NULL OR m.source_ref<>a.payment_application_id)))) THEN
    RAISE EXCEPTION 'allocation counters must match immutable movement history' USING ERRCODE='23514';
  END IF;
END;
$$;
CREATE FUNCTION check_commerce_checkout_inventory_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM check_commerce_inventory_order(NEW.order_id);
  PERFORM check_commerce_inventory_balance(NEW.item_id);
  PERFORM check_commerce_checkout_allocation_events(NEW.order_id);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_commerce_inventory_allocation AFTER INSERT OR UPDATE ON commerce_inventory_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_commerce_checkout_inventory_change();
CREATE CONSTRAINT TRIGGER check_commerce_inventory_movement AFTER INSERT ON commerce_inventory_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_commerce_checkout_inventory_change();

-- Validate retained hosted data without fabricating allocations or holds. Old
-- writers still encounter the same deferred balance guard at commit.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT i.item_id FROM commerce_items i JOIN commerce_shops s USING(shop_id) WHERE s.origin='hosted' ORDER BY i.item_id LOOP
    PERFORM check_commerce_inventory_balance(r.item_id);
  END LOOP;
  FOR r IN SELECT order_id FROM commerce_orders WHERE order_profile IN ('hosted_direct_reservation','hosted_shared_reservation','hosted_checkout') LOOP
    PERFORM check_commerce_inventory_order(r.order_id);
  END LOOP;
END;
$$;

-- A browser credential is platform-wide, not a tenant resource. Only its digest
-- is retained; absolute expiry is never refreshed by checkout creation or reads.
CREATE TABLE commerce_access_devices (
  device_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_sha256 text NOT NULL UNIQUE CHECK(token_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK(expires_at=created_at+interval '4320 hours'),
  CHECK(revoked_at IS NULL OR revoked_at>=created_at)
);
CREATE INDEX commerce_access_devices_expiry ON commerce_access_devices(expires_at) WHERE revoked_at IS NULL;
ALTER TABLE commerce_checkout_orders ADD CONSTRAINT commerce_checkout_order_access_target UNIQUE(order_id,checkout_id,tenant_id,instance_id);
CREATE TABLE commerce_order_access_grants (
  grant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  checkout_id uuid NOT NULL,
  order_id uuid,
  kind text NOT NULL CHECK(kind IN ('device','link')),
  device_id uuid REFERENCES commerce_access_devices(device_id),
  link_token_sha256 text UNIQUE CHECK(link_token_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  redeemed_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY(checkout_id,tenant_id,instance_id) REFERENCES commerce_checkouts(checkout_id,tenant_id,instance_id),
  FOREIGN KEY(order_id,checkout_id,tenant_id,instance_id) REFERENCES commerce_checkout_orders(order_id,checkout_id,tenant_id,instance_id),
  CHECK((kind='device' AND device_id IS NOT NULL AND link_token_sha256 IS NULL AND expires_at IS NULL AND redeemed_at IS NULL)
     OR (kind='link' AND device_id IS NULL AND order_id IS NOT NULL AND link_token_sha256 IS NOT NULL AND expires_at=created_at+interval '168 hours' AND expires_at IS NOT NULL)),
  CHECK(redeemed_at IS NULL OR redeemed_at>=created_at),
  CHECK(revoked_at IS NULL OR revoked_at>=created_at)
);
CREATE UNIQUE INDEX commerce_access_device_checkout ON commerce_order_access_grants(device_id,checkout_id) WHERE kind='device' AND order_id IS NULL;
CREATE UNIQUE INDEX commerce_access_device_order ON commerce_order_access_grants(device_id,order_id) WHERE kind='device' AND order_id IS NOT NULL;
CREATE INDEX commerce_access_grants_checkout ON commerce_order_access_grants(checkout_id,tenant_id,instance_id);
CREATE INDEX commerce_access_grants_order ON commerce_order_access_grants(order_id,checkout_id,tenant_id,instance_id);
CREATE INDEX commerce_access_grants_store ON commerce_order_access_grants(tenant_id,instance_id);
CREATE INDEX commerce_access_grants_device ON commerce_order_access_grants(device_id) WHERE device_id IS NOT NULL;
CREATE INDEX commerce_access_links_expiry ON commerce_order_access_grants(expires_at) WHERE kind='link' AND redeemed_at IS NULL AND revoked_at IS NULL;
ALTER TABLE commerce_order_access_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_order_access_grants_tenant ON commerce_order_access_grants FOR ALL TO PUBLIC
  USING(tenant_id=freedom_ctx_tenant()) WITH CHECK(tenant_id=freedom_ctx_tenant());

-- Revocation and link redemption are one-way. Grants cannot be retargeted or
-- renewed, and retaining revoked rows prevents accidental credential revival.
CREATE FUNCTION preserve_commerce_access_credential() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'revoked_at'-'redeemed_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at'-'redeemed_at')
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
    OR (TG_TABLE_NAME='commerce_order_access_grants' AND to_jsonb(OLD)->>'redeemed_at' IS NOT NULL
      AND to_jsonb(NEW)->>'redeemed_at' IS DISTINCT FROM to_jsonb(OLD)->>'redeemed_at') THEN
    RAISE EXCEPTION 'access credentials cannot be retargeted or renewed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_access_device BEFORE UPDATE ON commerce_access_devices FOR EACH ROW EXECUTE FUNCTION preserve_commerce_access_credential();
CREATE TRIGGER preserve_commerce_access_grant BEFORE UPDATE ON commerce_order_access_grants FOR EACH ROW EXECUTE FUNCTION preserve_commerce_access_credential();
CREATE TRIGGER preserve_commerce_access_device_delete BEFORE DELETE ON commerce_access_devices FOR EACH ROW EXECUTE FUNCTION preserve_commerce_checkout_history();
CREATE TRIGGER preserve_commerce_access_grant_delete BEFORE DELETE ON commerce_order_access_grants FOR EACH ROW EXECUTE FUNCTION preserve_commerce_checkout_history();
