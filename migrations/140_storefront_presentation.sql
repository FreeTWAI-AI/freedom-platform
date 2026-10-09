-- Presentation metadata only. Existing strict projection JSON and its digest are immutable.
-- Missing historical choices retain the original catalog grid; no publication is rewritten.
ALTER TABLE commerce_storefront_profiles
  ADD COLUMN template_id text NOT NULL DEFAULT 'catalog-grid-v1'
  CHECK (template_id IN ('catalog-grid-v1', 'catalog-list-v1'));

ALTER TABLE commerce_storefront_publications
  ADD COLUMN template_id text NOT NULL DEFAULT 'catalog-grid-v1'
  CHECK (template_id IN ('catalog-grid-v1', 'catalog-list-v1'));

-- Existing profile tenant mappings, publication immutability, and runtime grants apply.
-- No new module release, configuration schema, capability, or reservation setting is installed.
