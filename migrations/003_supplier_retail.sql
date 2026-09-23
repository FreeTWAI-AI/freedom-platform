-- Internal commerce preview. No checkout, legal signature, money movement or QC is implied.
CREATE TABLE catalog_products (
  product_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities,
  supplier_ref uuid NOT NULL REFERENCES users, title text NOT NULL,
  photo_url text, specifications text NOT NULL, product_type text NOT NULL DEFAULT 'physical' CHECK (product_type='physical'),
  qc_status text NOT NULL DEFAULT 'unreviewed' CHECK (qc_status='unreviewed'),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version>0),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(product_id,community_id)
);
CREATE TABLE supplier_offer_versions (
  offer_version_id uuid PRIMARY KEY, product_id uuid NOT NULL, community_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision>0), supplier_ref uuid NOT NULL REFERENCES users,
  net_price_minor bigint NOT NULL CHECK(net_price_minor>0 AND net_price_minor<=100000000000),
  currency text NOT NULL CHECK(currency IN ('TWD','USD')),
  availability text NOT NULL CHECK(availability IN ('finite','manual_confirmation')),
  stock integer CHECK(stock>=0), shipping_terms text NOT NULL, return_terms text NOT NULL,
  snapshot jsonb NOT NULL, snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((availability='finite' AND stock IS NOT NULL) OR (availability='manual_confirmation' AND stock IS NULL)),
  UNIQUE(product_id,revision), UNIQUE(offer_version_id,community_id),
  FOREIGN KEY(product_id,community_id) REFERENCES catalog_products(product_id,community_id)
);
CREATE TABLE retail_stores (
  store_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities,
  seller_ref uuid NOT NULL REFERENCES users, name text NOT NULL, description text NOT NULL,
  support_contact text NOT NULL, aggregate_version bigint NOT NULL DEFAULT 1,
  store_mode text NOT NULL DEFAULT 'internal_preview' CHECK(store_mode='internal_preview'),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(store_id,community_id)
);
CREATE TABLE retail_listing_revisions (
  listing_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities,
  store_id uuid NOT NULL, offer_version_id uuid NOT NULL,
  seller_ref uuid NOT NULL REFERENCES users, supplier_ref uuid NOT NULL REFERENCES users,
  retail_price_minor bigint NOT NULL CHECK(retail_price_minor>0 AND retail_price_minor<=100000000000),
  currency text NOT NULL CHECK(currency IN ('TWD','USD')), sale_terms text NOT NULL,
  snapshot jsonb NOT NULL, snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','requested','accepted','declined')),
  aggregate_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(listing_id,community_id),
  FOREIGN KEY(store_id,community_id) REFERENCES retail_stores(store_id,community_id),
  FOREIGN KEY(offer_version_id,community_id) REFERENCES supplier_offer_versions(offer_version_id,community_id)
);
CREATE TABLE distribution_acceptances (
  acceptance_id uuid PRIMARY KEY, listing_id uuid UNIQUE NOT NULL, community_id uuid NOT NULL,
  supplier_ref uuid NOT NULL REFERENCES users, seller_ref uuid NOT NULL REFERENCES users,
  snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','accepted','declined')),
  aggregate_version bigint NOT NULL DEFAULT 1, decision_note text, decided_at timestamptz,
  confirmation_kind text NOT NULL DEFAULT 'internal_preview' CHECK(confirmation_kind='internal_preview'),
  official boolean NOT NULL DEFAULT false CHECK(NOT official),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(listing_id,community_id) REFERENCES retail_listing_revisions(listing_id,community_id)
);
CREATE INDEX catalog_products_community ON catalog_products(community_id,created_at DESC);
CREATE INDEX retail_listings_seller ON retail_listing_revisions(community_id,seller_ref,created_at DESC);
CREATE INDEX distribution_requests_supplier ON distribution_acceptances(community_id,supplier_ref,created_at DESC);
CREATE FUNCTION reject_supplier_offer_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Supplier offer versions are immutable'; END;
$$;
CREATE TRIGGER supplier_offer_immutable BEFORE UPDATE OR DELETE ON supplier_offer_versions
FOR EACH ROW EXECUTE FUNCTION reject_supplier_offer_rewrite();
CREATE FUNCTION protect_retail_listing_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'state'-'aggregate_version') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'aggregate_version')
  THEN RAISE EXCEPTION 'Listing snapshots are immutable; create a new revision'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER retail_listing_immutable BEFORE UPDATE ON retail_listing_revisions
FOR EACH ROW EXECUTE FUNCTION protect_retail_listing_snapshot();
