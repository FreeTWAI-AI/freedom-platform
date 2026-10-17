-- D-11: seller-owned product-photo snapshots. No policy, flag or GC activation.
CREATE TABLE commerce_distribution_photo_copies (
 asset_id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL, instance_id uuid NOT NULL, product_id uuid NOT NULL,
 scope_id uuid NOT NULL, scope_kind text GENERATED ALWAYS AS ('tenant'::text) STORED,
 representation_id uuid NOT NULL, policy_revision text NOT NULL,
 purpose text GENERATED ALWAYS AS ('storefront.product-photo'::text) STORED,
 asset_state text GENERATED ALWAYS AS ('ready'::text) STORED,
 source_material_id uuid NOT NULL, source_version_id uuid NOT NULL,
 source_content_sha256 text NOT NULL CHECK(source_content_sha256 ~ '^[0-9a-f]{64}$'),
 -- Safe provenance survives withdrawal without widening the supplier's RLS.
 source_version_no integer NOT NULL CHECK(source_version_no BETWEEN 1 AND 100),
 source_title text NOT NULL CHECK(char_length(source_title) BETWEEN 1 AND 80),
 copied_by_principal_id uuid NOT NULL REFERENCES principals(principal_id),
 copied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(asset_id,tenant_id,instance_id,product_id,scope_id),
 FOREIGN KEY(scope_id,scope_kind,tenant_id) REFERENCES resource_scopes(scope_id,kind,tenant_ref),
 FOREIGN KEY(tenant_id,instance_id) REFERENCES commerce_storefront_profiles(tenant_id,instance_id),
 FOREIGN KEY(asset_id,scope_id,tenant_id,purpose,representation_id,asset_state)
  REFERENCES assets(asset_id,scope_id,tenant_ref,purpose,representation_id,state),
 FOREIGN KEY(asset_id,scope_id,representation_id,policy_revision,purpose)
  REFERENCES asset_objects(asset_id,scope_id,representation_id,policy_revision,purpose),
 FOREIGN KEY(source_version_id,source_material_id) REFERENCES supply_material_versions(version_id,material_id)
);
CREATE FUNCTION preserve_distribution_photo_copy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Distribution photo provenance is append-only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER preserve_distribution_photo_copy BEFORE UPDATE OR DELETE ON commerce_distribution_photo_copies
 FOR EACH ROW EXECUTE FUNCTION preserve_distribution_photo_copy();
CREATE TRIGGER reject_fenced_asset_reference BEFORE INSERT ON commerce_distribution_photo_copies
 FOR EACH ROW EXECUTE FUNCTION reject_fenced_asset_reference();

CREATE TABLE commerce_distribution_photo_targets (
 tenant_id uuid NOT NULL, instance_id uuid NOT NULL, product_id uuid NOT NULL,
 scope_id uuid NOT NULL, scope_kind text GENERATED ALWAYS AS ('tenant'::text) STORED,
 asset_id uuid, representation_id uuid, policy_revision text,
 purpose text GENERATED ALWAYS AS ('storefront.product-photo'::text) STORED,
 asset_state text GENERATED ALWAYS AS ('ready'::text) STORED,
 aggregate_version bigint NOT NULL DEFAULT 0 CHECK(aggregate_version>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,instance_id,product_id), UNIQUE(product_id,tenant_id,instance_id,scope_id),
 FOREIGN KEY(scope_id,scope_kind,tenant_id) REFERENCES resource_scopes(scope_id,kind,tenant_ref),
 FOREIGN KEY(tenant_id,instance_id) REFERENCES module_instances(tenant_id,instance_id),
 FOREIGN KEY(tenant_id,instance_id) REFERENCES commerce_storefront_profiles(tenant_id,instance_id),
 FOREIGN KEY(asset_id,scope_id,tenant_id,purpose,representation_id,asset_state)
  REFERENCES assets(asset_id,scope_id,tenant_ref,purpose,representation_id,state),
 FOREIGN KEY(asset_id,scope_id,representation_id,policy_revision,purpose)
  REFERENCES asset_objects(asset_id,scope_id,representation_id,policy_revision,purpose),
 FOREIGN KEY(asset_id,tenant_id,instance_id,product_id,scope_id)
  REFERENCES commerce_distribution_photo_copies(asset_id,tenant_id,instance_id,product_id,scope_id),
 CHECK((asset_id IS NULL AND representation_id IS NULL AND policy_revision IS NULL)
  OR (asset_id IS NOT NULL AND representation_id IS NOT NULL AND policy_revision IS NOT NULL))
);
CREATE FUNCTION preserve_distribution_photo_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Distribution photo routing is permanent' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.aggregate_version<>0 OR NEW.asset_id IS NOT NULL THEN RAISE EXCEPTION 'Initial photo version must be zero' USING ERRCODE='23514'; END IF;
 ELSE
  IF ROW(NEW.tenant_id,NEW.instance_id,NEW.product_id,NEW.scope_id,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.tenant_id,OLD.instance_id,OLD.product_id,OLD.scope_id,OLD.created_at)
   THEN RAISE EXCEPTION 'Distribution photo identity is immutable' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.asset_id,NEW.representation_id,NEW.policy_revision) IS DISTINCT FROM ROW(OLD.asset_id,OLD.representation_id,OLD.policy_revision) THEN
   IF NEW.aggregate_version<>OLD.aggregate_version+1 THEN RAISE EXCEPTION 'Photo version must advance once' USING ERRCODE='23514'; END IF;
  ELSIF NEW.aggregate_version<>OLD.aggregate_version THEN RAISE EXCEPTION 'Photo version requires a pointer change' USING ERRCODE='23514'; END IF;
  NEW.updated_at:=clock_timestamp();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM commerce_storefront_profiles p
  JOIN commerce_shops s ON s.shop_id=p.storefront_shop_id AND s.origin='hosted'
  JOIN commerce_resource_tenants r ON r.resource_kind='shop' AND r.resource_id=s.shop_id
   AND r.tenant_id=p.tenant_id AND r.instance_id=p.instance_id AND r.mapping_state='confirmed'
  JOIN commerce_selections l ON l.shop_id=s.shop_id AND l.item_id=NEW.product_id
  JOIN commerce_hosted_supply_offers o ON o.offer_id=l.hosted_offer_id AND o.item_id=l.item_id
  WHERE p.tenant_id=NEW.tenant_id AND p.instance_id=NEW.instance_id)
 THEN RAISE EXCEPTION 'Photo requires a hosted distribution selection' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER preserve_distribution_photo_target BEFORE INSERT OR UPDATE OR DELETE ON commerce_distribution_photo_targets
 FOR EACH ROW EXECUTE FUNCTION preserve_distribution_photo_target();
CREATE TRIGGER reject_fenced_asset_reference BEFORE INSERT OR UPDATE ON commerce_distribution_photo_targets
 FOR EACH ROW EXECUTE FUNCTION reject_fenced_asset_reference();
ALTER TABLE commerce_distribution_photo_copies ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_distribution_photo_copies_tenant ON commerce_distribution_photo_copies FOR ALL TO PUBLIC
 USING(tenant_id=freedom_ctx_tenant()) WITH CHECK(tenant_id=freedom_ctx_tenant());
ALTER TABLE commerce_distribution_photo_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_distribution_photo_targets_tenant ON commerce_distribution_photo_targets FOR ALL TO PUBLIC
 USING(tenant_id=freedom_ctx_tenant()) WITH CHECK(tenant_id=freedom_ctx_tenant());

ALTER TABLE asset_upload_intents ADD COLUMN target_distribution_product_id uuid;
ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_distribution_photo_target
 FOREIGN KEY(target_distribution_product_id,target_tenant_id,target_instance_id,scope_id)
 REFERENCES commerce_distribution_photo_targets(product_id,tenant_id,instance_id,scope_id);
CREATE FUNCTION preserve_distribution_photo_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.target_distribution_product_id IS DISTINCT FROM OLD.target_distribution_product_id THEN
  RAISE EXCEPTION 'Distribution photo intent is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER preserve_distribution_photo_intent BEFORE UPDATE ON asset_upload_intents
 FOR EACH ROW EXECUTE FUNCTION preserve_distribution_photo_intent();
-- Preserve the exact installed predicates for all existing profiles.
DO $$DECLARE old_expr text; constraint_name text; BEGIN
 FOREACH constraint_name IN ARRAY ARRAY['upload_profile_shape','tenant_upload_identity'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_expr FROM pg_constraint
   WHERE conrelid='asset_upload_intents'::regclass AND conname=constraint_name;
  EXECUTE format('ALTER TABLE asset_upload_intents DROP CONSTRAINT %I',constraint_name);
  EXECUTE format($shape$ALTER TABLE asset_upload_intents ADD CONSTRAINT %I CHECK(
   ((%s) AND target_kind<>'storefront.distribution-photo' AND target_distribution_product_id IS NULL)
   OR (target_kind='storefront.distribution-photo' AND purpose='storefront.product-photo'
    AND target_distribution_product_id IS NOT NULL AND target_tenant_id IS NOT NULL AND target_instance_id IS NOT NULL
    AND target_product_id IS NULL AND target_material_id IS NULL AND target_ar_id IS NULL
    AND target_work_id IS NULL AND target_service_id IS NULL AND target_event_id IS NULL
    AND target_video_event_id IS NULL AND target_post_id IS NULL AND target_submission_id IS NULL
    AND target_highlight_media_id IS NULL AND target_message_image_id IS NULL AND target_comment_image_id IS NULL
    AND target_community_id IS NULL AND display_name IS NULL AND source_orientation IS NULL
    AND source_content_type='image/webp' AND source_byte_size BETWEEN 1 AND 1048576 AND reserved_bytes=1048576))$shape$,
   constraint_name,old_expr);
 END LOOP;
END $$;
DO $$DECLARE old_expr text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_expr FROM pg_constraint
 WHERE conrelid='asset_upload_intents'::regclass AND conname='asset_upload_intents_expected_version_check';
 ALTER TABLE asset_upload_intents DROP CONSTRAINT asset_upload_intents_expected_version_check;
 EXECUTE format('ALTER TABLE asset_upload_intents ADD CONSTRAINT asset_upload_intents_expected_version_check CHECK((%s) OR (target_kind=''storefront.distribution-photo'' AND expected_version=0))',old_expr);
END $$;
