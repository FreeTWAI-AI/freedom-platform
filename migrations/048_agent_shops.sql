-- AI-authored shops. The platform records merchant reports; it never holds funds.
-- Payment rows are record_only merchant reports, not SupplierPayable, SettlementMandate, or a reconciled receipt.
CREATE TABLE commerce_shops (
 shop_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities,
 owner_id uuid NOT NULL REFERENCES users, kind text NOT NULL CHECK(kind IN ('internal','public')),
 mode text NOT NULL DEFAULT 'test' CHECK(mode IN ('test','live')), accepting_orders boolean NOT NULL DEFAULT true,
 name text NOT NULL, description text NOT NULL, website_url text NOT NULL, contact text NOT NULL,
 currency text NOT NULL CHECK(currency IN ('TWD','USD')),
 aggregate_version bigint NOT NULL DEFAULT 1, manifest_sha256 text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,manifest_sha256), UNIQUE(shop_id,community_id)
);
CREATE TABLE commerce_items (
 item_id uuid PRIMARY KEY, shop_id uuid NOT NULL REFERENCES commerce_shops,
 sku text NOT NULL, title text NOT NULL, description text NOT NULL, photo_url text,
 price_minor bigint NOT NULL CHECK(price_minor>0 AND price_minor<=100000000000),
 shipping_minor bigint NOT NULL CHECK(shipping_minor>=0 AND shipping_minor<=100000000000),
 stock integer NOT NULL CHECK(stock>=0), reserved integer NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=stock),
 shipping_terms text NOT NULL, return_terms text NOT NULL,
 UNIQUE(shop_id,sku)
);
CREATE TABLE commerce_selections (
 selection_id uuid PRIMARY KEY, shop_id uuid NOT NULL REFERENCES commerce_shops,
 item_id uuid NOT NULL REFERENCES commerce_items,
 retail_price_minor bigint NOT NULL CHECK(retail_price_minor>0 AND retail_price_minor<=100000000000),
 sale_terms text NOT NULL, snapshot jsonb NOT NULL, UNIQUE(shop_id,item_id)
);
CREATE TABLE commerce_shop_keys (
 shop_id uuid PRIMARY KEY REFERENCES commerce_shops, token_hash text UNIQUE NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE TABLE commerce_orders (
 order_id uuid PRIMARY KEY, public_shop_id uuid NOT NULL REFERENCES commerce_shops,
 external_id text NOT NULL, request_sha256 text NOT NULL, currency text NOT NULL,
 total_minor bigint NOT NULL CHECK(total_minor>0),
 buyer_payment text NOT NULL DEFAULT 'pending' CHECK(buyer_payment IN ('pending','reported_paid','reported_refunded','cancelled')),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(public_shop_id,external_id)
);
CREATE TABLE commerce_transfers (
 transfer_id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES commerce_orders,
 internal_shop_id uuid NOT NULL REFERENCES commerce_shops, total_minor bigint NOT NULL CHECK(total_minor>0),
 delivery_ref text NOT NULL,
 payment_state text NOT NULL DEFAULT 'pending' CHECK(payment_state IN ('pending','reported_paid','reported_refunded')),
 payment_url text, shipment jsonb, aggregate_version bigint NOT NULL DEFAULT 1, UNIQUE(order_id,internal_shop_id)
);
CREATE TABLE commerce_order_lines (
 order_id uuid NOT NULL REFERENCES commerce_orders, selection_id uuid NOT NULL REFERENCES commerce_selections,
 transfer_id uuid NOT NULL REFERENCES commerce_transfers, item_id uuid NOT NULL REFERENCES commerce_items,
 quantity integer NOT NULL CHECK(quantity>0 AND quantity<=99), snapshot jsonb NOT NULL,
 PRIMARY KEY(order_id,selection_id)
);
CREATE TABLE commerce_payment_events (
 event_id uuid PRIMARY KEY, shop_id uuid NOT NULL REFERENCES commerce_shops,
 external_event_id text NOT NULL, request_sha256 text NOT NULL,
 order_id uuid NOT NULL REFERENCES commerce_orders, transfer_id uuid REFERENCES commerce_transfers,
 event_type text NOT NULL CHECK(event_type IN ('paid','refunded')),
 provider text NOT NULL, transaction_ref text NOT NULL, amount_minor bigint NOT NULL,
 evidence_source text NOT NULL DEFAULT 'merchant_backend_report' CHECK(evidence_source='merchant_backend_report'),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(shop_id,external_event_id),
 UNIQUE(shop_id,provider,transaction_ref,event_type)
);
CREATE INDEX commerce_shops_owner ON commerce_shops(community_id,owner_id);
CREATE INDEX commerce_transfers_internal ON commerce_transfers(internal_shop_id,order_id);
