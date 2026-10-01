-- Reseller distribution for AI shops. Records only: the platform is not the collector and does not debit.
CREATE TABLE commerce_distribution_acceptances (
  acceptance_id uuid PRIMARY KEY,
  selection_id uuid NOT NULL REFERENCES commerce_selections,
  community_id uuid NOT NULL,
  supplier_user_id uuid NOT NULL REFERENCES users,
  seller_user_id uuid NOT NULL REFERENCES users,
  listing_sha256 text NOT NULL CHECK (listing_sha256 ~ '^[a-f0-9]{64}$'),
  decision text NOT NULL CHECK (decision IN ('accepted','declined','changes_requested','revoked')),
  note text NOT NULL DEFAULT '',
  signer_user_id uuid NOT NULL REFERENCES users,
  signed_digest text NOT NULL CHECK (signed_digest = listing_sha256),
  acceptance_kind text NOT NULL DEFAULT 'distribution_acceptance' CHECK (acceptance_kind = 'distribution_acceptance'),
  arrangement jsonb NOT NULL,
  money_movement_enabled boolean NOT NULL DEFAULT false CHECK (money_movement_enabled = false),
  official boolean NOT NULL DEFAULT false CHECK (NOT official),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commerce_acceptances_selection ON commerce_distribution_acceptances(selection_id, created_at);
ALTER TABLE commerce_selections
  ADD COLUMN listing_sha256 text CHECK (listing_sha256 IS NULL OR listing_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN acceptance_state text NOT NULL DEFAULT 'awaiting_supply_acceptance'
    CHECK (acceptance_state IN ('awaiting_supply_acceptance','sellable','declined','changes_requested','revoked')),
  ADD COLUMN current_acceptance_id uuid REFERENCES commerce_distribution_acceptances,
  ADD COLUMN aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0);
ALTER TABLE commerce_order_lines
  ADD COLUMN acceptance_id uuid REFERENCES commerce_distribution_acceptances,
  ADD COLUMN listing_sha256 text;
CREATE TABLE commerce_supplier_payables (
  payable_id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES commerce_orders,
  transfer_id uuid NOT NULL REFERENCES commerce_transfers,
  selection_id uuid NOT NULL,
  acceptance_id uuid NOT NULL REFERENCES commerce_distribution_acceptances,
  listing_sha256 text NOT NULL,
  beneficiary_user_id uuid NOT NULL REFERENCES users,
  supplier_net_minor bigint NOT NULL CHECK (supplier_net_minor > 0 AND supplier_net_minor <= 100000000000),
  shipping_minor bigint NOT NULL CHECK (shipping_minor >= 0 AND shipping_minor <= 100000000000),
  tax_minor bigint NOT NULL CHECK (tax_minor >= 0 AND tax_minor <= 100000000000),
  currency text NOT NULL,
  source_payment_event_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'recorded' CHECK (status = 'recorded'),
  settlement_mode text NOT NULL DEFAULT 'record_only' CHECK (settlement_mode = 'record_only'),
  money_movement_enabled boolean NOT NULL DEFAULT false CHECK (NOT money_movement_enabled),
  display_label text NOT NULL DEFAULT '已記錄' CHECK (display_label = '已記錄'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, selection_id)
);
CREATE TABLE commerce_obligation_reversals (
  reversal_id uuid PRIMARY KEY,
  payable_id uuid NOT NULL REFERENCES commerce_supplier_payables,
  payment_event_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payable_id, payment_event_id)
);
CREATE TABLE commerce_settlement_records (
  settlement_id uuid PRIMARY KEY,
  payable_id uuid UNIQUE NOT NULL REFERENCES commerce_supplier_payables,
  mode text NOT NULL DEFAULT 'record_only' CHECK (mode = 'record_only'),
  state text NOT NULL DEFAULT 'recorded' CHECK (state = 'recorded'),
  money_movement_enabled boolean NOT NULL DEFAULT false CHECK (NOT money_movement_enabled),
  platform_collects boolean NOT NULL DEFAULT false CHECK (NOT platform_collects),
  auto_debit boolean NOT NULL DEFAULT false CHECK (NOT auto_debit),
  display_label text NOT NULL DEFAULT '已記錄' CHECK (display_label = '已記錄'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION reject_commerce_payable_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Supplier payables and settlements are append-only'; END;
$$;
CREATE TRIGGER commerce_supplier_payable_immutable BEFORE UPDATE OR DELETE ON commerce_supplier_payables
  FOR EACH ROW EXECUTE FUNCTION reject_commerce_payable_rewrite();
CREATE TRIGGER commerce_settlement_immutable BEFORE UPDATE OR DELETE ON commerce_settlement_records
  FOR EACH ROW EXECUTE FUNCTION reject_commerce_payable_rewrite();
CREATE TRIGGER commerce_reversal_immutable BEFORE UPDATE OR DELETE ON commerce_obligation_reversals
  FOR EACH ROW EXECUTE FUNCTION reject_commerce_payable_rewrite();
CREATE FUNCTION reject_commerce_acceptance_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Distribution acceptances are append-only'; END;
$$;
CREATE TRIGGER commerce_acceptance_immutable BEFORE UPDATE OR DELETE ON commerce_distribution_acceptances
  FOR EACH ROW EXECUTE FUNCTION reject_commerce_acceptance_rewrite();
