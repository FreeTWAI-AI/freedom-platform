-- #317: one closed tenant product-photo profile. No activation, backfill, grants,
-- cloud setup or GC admission. All pre-141 SQL and historical projections stay intact.
ALTER TABLE domain_media_storage_policy DROP CONSTRAINT domain_media_storage_policy_purpose_check;
ALTER TABLE domain_media_storage_policy ADD CONSTRAINT domain_media_storage_policy_purpose_check
 CHECK (purpose IN ('skill.submission-image','community.event-banner','community.event-video','community.event-highlight','community.social-thumbnail','member.service-cover','member.message-image','storefront.product-photo'));
ALTER TABLE assets DROP CONSTRAINT assets_purpose_check;
ALTER TABLE assets ADD CONSTRAINT assets_purpose_check CHECK(purpose IN ('member.avatar','work.private-draft','member.service-cover','community.event-banner','community.event-video','community.social-thumbnail','skill.submission-image','community.event-highlight','work.tenant-result','member.message-image','storefront.product-photo'));
INSERT INTO domain_media_storage_policy(purpose) VALUES ('storefront.product-photo');
CREATE OR REPLACE FUNCTION preserve_domain_media_floor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.purpose IS DISTINCT FROM OLD.purpose OR (OLD.mode<>'legacy' AND NEW.mode='legacy') THEN RAISE EXCEPTION 'Media storage floor cannot rewind' USING ERRCODE='23514';END IF;
 IF NEW.purpose NOT IN ('member.service-cover','community.event-banner','community.event-video','community.social-thumbnail','skill.submission-image','community.event-highlight','member.message-image','storefront.product-photo') AND NEW.mode<>'legacy' THEN RAISE EXCEPTION 'Domain media adapter is not installed' USING ERRCODE='23514';END IF;
 IF NEW.mode='r2_only' AND ((NEW.purpose='community.social-thumbnail' AND EXISTS(SELECT 1 FROM community_social_post_thumbnails WHERE storage_source='legacy' OR image_bytes IS NOT NULL))
  OR (NEW.purpose='community.event-highlight' AND EXISTS(SELECT 1 FROM community_event_highlights h JOIN community_event_highlight_images i USING(media_id) WHERE h.storage_source='legacy' OR i.bytes IS NOT NULL))
  OR (NEW.purpose='skill.submission-image' AND EXISTS(SELECT 1 FROM skill_submissions WHERE image_bytes IS NOT NULL))
  OR (NEW.purpose='community.event-banner' AND EXISTS(SELECT 1 FROM community_event_banners WHERE storage_source='legacy' OR image_bytes IS NOT NULL))
  OR (NEW.purpose='member.service-cover' AND EXISTS(SELECT 1 FROM member_service_covers WHERE storage_source='legacy' OR image_bytes IS NOT NULL))
  OR (NEW.purpose='community.event-video' AND EXISTS(SELECT 1 FROM community_event_videos WHERE storage_source='legacy' OR media_bytes IS NOT NULL))) THEN RAISE EXCEPTION 'Legacy media sources remain' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
ALTER TABLE assets DROP CONSTRAINT asset_scope_purpose;
ALTER TABLE assets ADD CONSTRAINT asset_scope_purpose CHECK ((((scope_kind = 'personal'::text) AND (community_ref IS NULL) AND (tenant_ref IS NULL) AND (purpose = ANY (ARRAY['member.avatar'::text, 'work.private-draft'::text, 'member.service-cover'::text, 'skill.submission-image'::text, 'member.message-image'::text])))
 OR ((scope_kind = 'community'::text) AND (community_ref IS NOT NULL) AND (tenant_ref IS NULL) AND (purpose = ANY (ARRAY['community.event-banner'::text, 'community.event-video'::text, 'community.social-thumbnail'::text, 'community.event-highlight'::text])))
 OR ((scope_kind = 'tenant'::text) AND (tenant_ref IS NOT NULL) AND (community_ref IS NULL) AND (purpose IN ('work.tenant-result','storefront.product-photo')))));
ALTER TABLE assets ADD CONSTRAINT asset_storefront_ready_identity
 UNIQUE(asset_id,scope_id,tenant_ref,purpose,representation_id,state);
ALTER TABLE asset_objects ADD COLUMN pixel_width integer, ADD COLUMN pixel_height integer;
ALTER TABLE asset_objects ADD CONSTRAINT asset_object_photo_dimensions CHECK (
 (purpose='storefront.product-photo' AND pixel_width IS NOT NULL AND pixel_height IS NOT NULL
   AND pixel_width BETWEEN 1 AND 1920 AND pixel_height BETWEEN 1 AND 1920)
 OR (purpose<>'storefront.product-photo' AND pixel_width IS NULL AND pixel_height IS NULL));
ALTER TABLE asset_objects ADD CONSTRAINT asset_object_photo_identity
 UNIQUE(asset_id,scope_id,representation_id,policy_revision,purpose);
ALTER TABLE asset_objects DROP CONSTRAINT asset_object_profile_shape;
ALTER TABLE asset_objects ADD CONSTRAINT asset_object_profile_shape CHECK ((((
((((purpose = 'member.avatar'::text) AND (variant = 'avatar'::text) AND (content_type = 'image/webp'::text) AND ((byte_size >= 1) AND (byte_size <= 131072)) AND (transform_version = ANY (ARRAY['avatar.webp.v1'::text, 'member.avatar.legacy-bytes.v1'::text])))
 OR ((purpose = 'work.private-draft'::text) AND (variant = 'draft'::text) AND (content_type = ANY (ARRAY['text/plain'::text, 'text/markdown'::text])) AND ((byte_size >= 1) AND (byte_size <= 262144)) AND (transform_version = 'private-text.utf8.v1'::text))
 OR ((purpose = 'member.service-cover'::text) AND (variant = 'cover'::text) AND (content_type = 'image/webp'::text) AND ((byte_size >= 1) AND (byte_size <= 524288)) AND (transform_version = 'member.service-cover.legacy-bytes.v1'::text))
 OR ((purpose = 'community.event-banner'::text) AND (variant = 'banner'::text) AND (content_type = 'image/webp'::text) AND ((byte_size >= 1) AND (byte_size <= 524288)) AND (transform_version = 'community.event-banner.legacy-bytes.v1'::text))
 OR ((purpose = 'community.event-video'::text) AND (variant = 'video'::text) AND (content_type = ANY (ARRAY['video/mp4'::text, 'video/webm'::text])) AND ((byte_size >= 1) AND (byte_size <= 20971520)) AND (transform_version = 'community.event-video.legacy-bytes.v1'::text))
 OR ((purpose = 'community.social-thumbnail'::text) AND (variant = 'thumbnail'::text) AND (content_type = 'image/webp'::text) AND ((byte_size >= 1) AND (byte_size <= 524288)) AND (transform_version = 'community.social-thumbnail.legacy-bytes.v1'::text))
 OR ((purpose = 'skill.submission-image'::text) AND (variant = 'illustration'::text) AND (content_type = 'image/webp'::text) AND ((byte_size >= 1) AND (byte_size <= 524288)) AND (transform_version = 'skill.submission-image.legacy-bytes.v1'::text))
 OR ((purpose = 'community.event-highlight'::text) AND (content_type = 'image/webp'::text) AND (((variant = 'image'::text) AND ((byte_size >= 1) AND (byte_size <= 1048576)) AND (transform_version = 'community.event-highlight.legacy-bytes.v1'::text))
 OR ((variant = 'thumb'::text) AND ((byte_size >= 1) AND (byte_size <= 204800)) AND (transform_version = 'community.event-highlight.thumbnail.legacy-bytes.v1'::text))))
 OR ((purpose = 'work.tenant-result'::text) AND (variant = 'draft'::text) AND (content_type = ANY (ARRAY['text/plain'::text, 'text/markdown'::text])) AND ((byte_size >= 1) AND (byte_size <= 262144)) AND (transform_version = 'private-text.utf8.v1'::text)))))
 OR ((purpose = 'member.message-image'::text) AND (variant = 'image'::text) AND (content_type = 'image/webp'::text) AND ((byte_size >= 1) AND (byte_size <= 1048576)) AND (transform_version = 'member.message-image.webp.v1'::text)))) OR (purpose='storefront.product-photo' AND variant='image' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 1048576 AND transform_version='storefront.product-photo.webp.v1'));
ALTER TABLE asset_objects DROP CONSTRAINT asset_object_profile_id_shape;
ALTER TABLE asset_objects ADD CONSTRAINT asset_object_profile_id_shape CHECK ((((((purpose = 'member.avatar'::text) AND (((transform_version = 'avatar.webp.v1'::text) AND (profile_id IS NULL))
 OR ((transform_version = 'member.avatar.legacy-bytes.v1'::text) AND (profile_id IS NOT NULL) AND (profile_id = 'member.avatar'::text))))
 OR ((purpose = 'community.event-highlight'::text) AND (profile_id IS NOT NULL) AND (((variant = 'image'::text) AND (profile_id = 'community.event-highlight'::text))
 OR ((variant = 'thumb'::text) AND (profile_id = 'community.event-highlight.thumbnail'::text))))
 OR ((purpose = ANY (ARRAY['member.service-cover'::text, 'community.event-banner'::text, 'community.event-video'::text, 'community.social-thumbnail'::text, 'skill.submission-image'::text, 'member.message-image'::text])) AND (profile_id IS NOT NULL) AND (profile_id = purpose))
 OR ((purpose <> ALL (ARRAY['member.avatar'::text, 'member.service-cover'::text, 'community.event-banner'::text, 'community.event-video'::text, 'community.social-thumbnail'::text, 'skill.submission-image'::text, 'community.event-highlight'::text, 'member.message-image'::text])) AND (profile_id IS NULL)))) AND purpose<>'storefront.product-photo') OR (purpose='storefront.product-photo' AND profile_id IS NOT NULL AND profile_id=purpose));

-- Retained routing is not the live product. Removing a product clears its pointer
-- but never deletes historical intents or published references.
ALTER TABLE commerce_storefront_profiles ADD CONSTRAINT storefront_photo_profile_identity UNIQUE(tenant_id,instance_id);
CREATE TABLE commerce_product_photo_targets (
 tenant_id uuid NOT NULL, instance_id uuid NOT NULL, product_id uuid NOT NULL,
 scope_id uuid NOT NULL, scope_kind text GENERATED ALWAYS AS ('tenant'::text) STORED,
 asset_id uuid, representation_id uuid, policy_revision text, linked_at_product_version bigint,
 purpose text GENERATED ALWAYS AS ('storefront.product-photo'::text) STORED,
 asset_state text GENERATED ALWAYS AS ('ready'::text) STORED,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,instance_id,product_id), UNIQUE(product_id,tenant_id,instance_id,scope_id),
 FOREIGN KEY(scope_id,scope_kind,tenant_id) REFERENCES resource_scopes(scope_id,kind,tenant_id),
 FOREIGN KEY(tenant_id,instance_id) REFERENCES module_instances(tenant_id,instance_id),
 FOREIGN KEY(tenant_id,instance_id) REFERENCES commerce_storefront_profiles(tenant_id,instance_id),
 FOREIGN KEY(asset_id,scope_id,tenant_id,purpose,representation_id,asset_state)
  REFERENCES assets(asset_id,scope_id,tenant_ref,purpose,representation_id,state),
 FOREIGN KEY(asset_id,scope_id,representation_id,policy_revision,purpose)
  REFERENCES asset_objects(asset_id,scope_id,representation_id,policy_revision,purpose),
 CHECK ((asset_id IS NULL AND representation_id IS NULL AND policy_revision IS NULL AND linked_at_product_version IS NULL)
  OR (asset_id IS NOT NULL AND representation_id IS NOT NULL AND policy_revision IS NOT NULL
    AND linked_at_product_version IS NOT NULL AND linked_at_product_version>0))
);
ALTER TABLE commerce_product_photo_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_product_photo_targets_tenant ON commerce_product_photo_targets FOR ALL TO PUBLIC
 USING(tenant_id=freedom_ctx_tenant()) WITH CHECK(tenant_id=freedom_ctx_tenant());
CREATE FUNCTION preserve_commerce_photo_target() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_version bigint;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Product photo routing is permanent' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.tenant_id,NEW.instance_id,NEW.product_id,NEW.scope_id,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.tenant_id,OLD.instance_id,OLD.product_id,OLD.scope_id,OLD.created_at)
 THEN RAISE EXCEPTION 'Product photo routing is immutable' USING ERRCODE='23514'; END IF;
 -- Callers already hold boundary/policy/item/selection locks. Recheck actual
 -- mappings without introducing a reversed trigger-level locking order.
 SELECT s.aggregate_version INTO current_version FROM commerce_storefront_profiles p
 JOIN commerce_items i ON i.shop_id=p.supply_shop_id AND i.item_id=NEW.product_id
 JOIN commerce_selections s ON s.item_id=i.item_id AND s.shop_id=p.storefront_shop_id
 JOIN commerce_shops supply ON supply.shop_id=i.shop_id AND supply.origin='hosted'
 JOIN commerce_shops retail ON retail.shop_id=s.shop_id AND retail.origin='hosted'
 JOIN commerce_resource_tenants m ON m.resource_kind='shop' AND m.resource_id=i.shop_id
  AND m.tenant_id=p.tenant_id AND m.instance_id=p.instance_id AND m.mapping_state='confirmed'
 JOIN commerce_resource_tenants r ON r.resource_kind='shop' AND r.resource_id=s.shop_id
  AND r.tenant_id=p.tenant_id AND r.instance_id=p.instance_id AND r.mapping_state='confirmed'
 WHERE p.tenant_id=NEW.tenant_id AND p.instance_id=NEW.instance_id;
 IF current_version IS NULL OR (NEW.asset_id IS NOT NULL AND NEW.linked_at_product_version<>current_version)
 THEN RAISE EXCEPTION 'Product photo requires the current product version' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER preserve_commerce_photo_target BEFORE INSERT OR UPDATE OR DELETE ON commerce_product_photo_targets
 FOR EACH ROW EXECUTE FUNCTION preserve_commerce_photo_target();
CREATE TRIGGER reject_fenced_asset_reference BEFORE INSERT OR UPDATE ON commerce_product_photo_targets
 FOR EACH ROW EXECUTE FUNCTION reject_fenced_asset_reference();
CREATE FUNCTION require_detached_commerce_product_photo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM commerce_product_photo_targets WHERE product_id=OLD.item_id AND asset_id IS NOT NULL)
 THEN RAISE EXCEPTION 'Detach the current photo before deleting its product' USING ERRCODE='23514'; END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER require_detached_commerce_product_photo BEFORE DELETE ON commerce_items
 FOR EACH ROW EXECUTE FUNCTION require_detached_commerce_product_photo();
CREATE TRIGGER require_detached_commerce_product_photo BEFORE DELETE ON commerce_selections
 FOR EACH ROW EXECUTE FUNCTION require_detached_commerce_product_photo();

ALTER TABLE asset_upload_intents ADD COLUMN target_product_id uuid, ADD COLUMN target_instance_id uuid;
ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_storefront_photo_target
 FOREIGN KEY(target_product_id,target_tenant_id,target_instance_id,scope_id)
 REFERENCES commerce_product_photo_targets(product_id,tenant_id,instance_id,scope_id);
ALTER TABLE asset_upload_intents DROP CONSTRAINT upload_profile_shape;
ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_profile_shape CHECK ((((
((((target_highlight_media_id IS NULL) AND (((target_submission_id IS NULL) AND (((target_post_id IS NULL) AND (((target_video_event_id IS NULL) AND (((target_event_id IS NULL) AND (target_community_id IS NULL) AND (source_orientation IS NULL) AND (purpose = 'member.avatar'::text) AND (target_kind = 'member.avatar'::text) AND (target_work_id IS NULL) AND (target_service_id IS NULL) AND (source_content_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text])) AND ((source_byte_size >= 1) AND (source_byte_size <= 2097152)) AND (reserved_bytes = 131072))
 OR ((target_event_id IS NULL) AND (target_community_id IS NULL) AND (source_orientation IS NULL) AND (purpose = 'work.private-draft'::text) AND (target_kind = 'work.private-result'::text) AND (target_work_id IS NOT NULL) AND (target_service_id IS NULL) AND (source_content_type = ANY (ARRAY['text/plain'::text, 'text/markdown'::text])) AND ((source_byte_size >= 1) AND (source_byte_size <= 262144)) AND (reserved_bytes = 262144))
 OR ((target_event_id IS NULL) AND (target_community_id IS NULL) AND (source_orientation IS NULL) AND (purpose = 'work.private-draft'::text) AND (target_kind = 'work.model-result'::text) AND (target_work_id IS NOT NULL) AND (target_service_id IS NULL) AND (source_content_type = 'text/plain'::text) AND ((source_byte_size >= 1) AND (source_byte_size <= 16384)) AND (reserved_bytes = 16384))
 OR ((target_event_id IS NULL) AND (target_community_id IS NULL) AND (source_orientation IS NULL) AND (purpose = 'member.service-cover'::text) AND (target_kind = 'member.service-cover'::text) AND (target_service_id IS NOT NULL) AND (target_work_id IS NULL) AND (source_content_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text])) AND ((source_byte_size >= 1) AND (source_byte_size <= 4194304)) AND (reserved_bytes = 524288))
 OR ((purpose = 'community.event-banner'::text) AND (target_kind = 'community.event-banner'::text) AND (target_event_id IS NOT NULL) AND (target_community_id IS NOT NULL) AND (target_work_id IS NULL) AND (target_service_id IS NULL) AND (source_orientation IS NOT NULL) AND (source_orientation = ANY (ARRAY['landscape'::text, 'portrait'::text])) AND (source_content_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text])) AND ((source_byte_size >= 1) AND (source_byte_size <= 524288)) AND (reserved_bytes = 524288))))
 OR ((purpose = 'community.event-video'::text) AND (target_kind = 'community.event-video'::text) AND (target_video_event_id IS NOT NULL) AND (target_event_id IS NULL) AND (target_community_id IS NOT NULL) AND (target_work_id IS NULL) AND (target_service_id IS NULL) AND (source_orientation IS NULL) AND (source_content_type = ANY (ARRAY['video/mp4'::text, 'video/webm'::text])) AND ((source_byte_size >= 1) AND (source_byte_size <= 20971520)) AND (reserved_bytes = 20971520))))
 OR ((purpose = 'community.social-thumbnail'::text) AND (target_kind = 'community.social-thumbnail'::text) AND (target_post_id IS NOT NULL) AND (target_community_id IS NOT NULL) AND (target_event_id IS NULL) AND (target_video_event_id IS NULL) AND (target_work_id IS NULL) AND (target_service_id IS NULL) AND (source_orientation IS NULL) AND (source_content_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text])) AND ((source_byte_size >= 1) AND (source_byte_size <= 524288)) AND (reserved_bytes = 524288))))
 OR ((purpose = 'skill.submission-image'::text) AND (target_kind = 'skill.submission-image'::text) AND (target_submission_id IS NOT NULL) AND (target_work_id IS NULL) AND (target_service_id IS NULL) AND (target_event_id IS NULL) AND (target_video_event_id IS NULL) AND (target_post_id IS NULL) AND (target_community_id IS NULL) AND (source_orientation IS NULL) AND (source_content_type = 'image/webp'::text) AND ((source_byte_size >= 1) AND (source_byte_size <= 524288)) AND (reserved_bytes = 524288))))
 OR ((purpose = 'community.event-highlight'::text) AND (target_highlight_media_id IS NOT NULL) AND (target_community_id IS NOT NULL) AND (target_work_id IS NULL) AND (target_service_id IS NULL) AND (target_event_id IS NULL) AND (target_video_event_id IS NULL) AND (target_post_id IS NULL) AND (target_submission_id IS NULL) AND (source_orientation IS NULL) AND (source_content_type = 'image/webp'::text) AND (((target_kind = 'community.event-highlight.image'::text) AND ((source_byte_size >= 1) AND (source_byte_size <= 1048576)) AND (reserved_bytes = 1048576))
 OR ((target_kind = 'community.event-highlight.thumb'::text) AND ((source_byte_size >= 1) AND (source_byte_size <= 204800)) AND (reserved_bytes = 204800))))
 OR ((target_highlight_media_id IS NULL) AND (target_submission_id IS NULL) AND (target_post_id IS NULL) AND (target_video_event_id IS NULL) AND (target_event_id IS NULL) AND (target_service_id IS NULL) AND (target_community_id IS NULL) AND (source_orientation IS NULL) AND (purpose = 'work.tenant-result'::text) AND (target_kind = 'work.tenant-result'::text) AND (target_work_id IS NOT NULL) AND (target_tenant_id IS NOT NULL) AND (display_name IS NOT NULL) AND (source_content_type = ANY (ARRAY['text/plain'::text, 'text/markdown'::text])) AND ((source_byte_size >= 1) AND (source_byte_size <= 262144)) AND (reserved_bytes = 262144)))) AND target_message_image_id IS NULL)
 OR ((purpose = 'member.message-image'::text) AND (target_kind = 'member.message-image'::text) AND (target_message_image_id IS NOT NULL) AND (target_work_id IS NULL) AND (target_service_id IS NULL) AND (target_event_id IS NULL) AND (target_video_event_id IS NULL) AND (target_post_id IS NULL) AND (target_submission_id IS NULL) AND (target_highlight_media_id IS NULL) AND (target_community_id IS NULL) AND (target_tenant_id IS NULL) AND (display_name IS NULL) AND (source_orientation IS NULL) AND (source_content_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text])) AND ((source_byte_size >= 1) AND (source_byte_size <= 2097152)) AND (reserved_bytes = 1048576))) AND target_product_id IS NULL AND target_instance_id IS NULL) OR (purpose='storefront.product-photo' AND target_kind='storefront.product-photo'
 AND target_product_id IS NOT NULL AND target_instance_id IS NOT NULL AND target_tenant_id IS NOT NULL
 AND target_work_id IS NULL AND target_service_id IS NULL AND target_event_id IS NULL
 AND target_video_event_id IS NULL AND target_post_id IS NULL AND target_submission_id IS NULL
 AND target_highlight_media_id IS NULL AND target_message_image_id IS NULL AND target_community_id IS NULL
 AND display_name IS NULL AND source_orientation IS NULL
 AND source_content_type IN ('image/png','image/jpeg','image/webp')
 AND source_byte_size BETWEEN 1 AND 2097152 AND reserved_bytes=1048576));
ALTER TABLE asset_upload_intents DROP CONSTRAINT tenant_upload_identity;
ALTER TABLE asset_upload_intents ADD CONSTRAINT tenant_upload_identity CHECK (
  (target_kind = 'work.tenant-result' AND target_tenant_id IS NOT NULL AND display_name IS NOT NULL
    AND char_length(display_name) BETWEEN 1 AND 120 AND octet_length(display_name) <= 480
    AND strpos(display_name, '/') = 0 AND strpos(display_name, E'\\') = 0
    AND display_name !~ '[[:cntrl:]]')
  OR (target_kind NOT IN ('work.tenant-result','storefront.product-photo') AND target_tenant_id IS NULL AND display_name IS NULL)
 OR (target_kind='storefront.product-photo' AND target_tenant_id IS NOT NULL AND display_name IS NULL));
CREATE OR REPLACE FUNCTION preserve_upload_typed_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.target_kind, NEW.target_work_id, NEW.target_service_id, NEW.target_event_id, NEW.target_video_event_id, NEW.target_submission_id, NEW.target_post_id, NEW.target_highlight_media_id, NEW.target_message_image_id, NEW.target_community_id, NEW.source_orientation, NEW.display_name, NEW.target_tenant_id, NEW.target_product_id, NEW.target_instance_id)
  IS DISTINCT FROM ROW(OLD.target_kind, OLD.target_work_id, OLD.target_service_id, OLD.target_event_id, OLD.target_video_event_id, OLD.target_submission_id, OLD.target_post_id, OLD.target_highlight_media_id, OLD.target_message_image_id, OLD.target_community_id, OLD.source_orientation, OLD.display_name, OLD.target_tenant_id, OLD.target_product_id, OLD.target_instance_id) THEN
  RAISE EXCEPTION 'Upload typed target is immutable' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;

-- Empty-media digest is the exact UTF-8 canonical domain manifest. Existing v1
-- projection and digest are never rewritten. Read adapters recompute media hash.
ALTER TABLE commerce_storefront_publications ADD COLUMN media_sha256 text NOT NULL
 DEFAULT 'dc5958eb8f6ff19262fb0ccb304d8f154e45c3a7e44b448aa3a329e1c4ba0e2e' CHECK(media_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE commerce_storefront_publications ADD CONSTRAINT storefront_publication_photo_identity
 UNIQUE(publication_id,tenant_id,instance_id);
CREATE TABLE commerce_publication_photo_refs (
 publication_id uuid NOT NULL, sku text NOT NULL CHECK(sku ~ '^P[0-9]{4,23}$'),
 tenant_id uuid NOT NULL, instance_id uuid NOT NULL, scope_id uuid NOT NULL,
 scope_kind text GENERATED ALWAYS AS ('tenant'::text) STORED,
 asset_id uuid NOT NULL, representation_id uuid NOT NULL, policy_revision text NOT NULL,
 purpose text GENERATED ALWAYS AS ('storefront.product-photo'::text) STORED,
 asset_state text GENERATED ALWAYS AS ('ready'::text) STORED,
 content_type text NOT NULL, byte_size integer NOT NULL, content_sha256 text NOT NULL,
 transform_version text NOT NULL, width integer NOT NULL, height integer NOT NULL,
 PRIMARY KEY(publication_id,sku),
 FOREIGN KEY(publication_id,tenant_id,instance_id)
  REFERENCES commerce_storefront_publications(publication_id,tenant_id,instance_id),
 FOREIGN KEY(scope_id,scope_kind,tenant_id) REFERENCES resource_scopes(scope_id,kind,tenant_id),
 FOREIGN KEY(asset_id,scope_id,tenant_id,purpose,representation_id,asset_state)
  REFERENCES assets(asset_id,scope_id,tenant_ref,purpose,representation_id,state),
 FOREIGN KEY(asset_id,scope_id,representation_id,policy_revision,purpose)
  REFERENCES asset_objects(asset_id,scope_id,representation_id,policy_revision,purpose)
);
ALTER TABLE commerce_publication_photo_refs ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_publication_photo_refs_tenant ON commerce_publication_photo_refs FOR ALL TO PUBLIC
 USING(tenant_id=freedom_ctx_tenant()) WITH CHECK(tenant_id=freedom_ctx_tenant());
CREATE FUNCTION preserve_commerce_publication_photo() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE object asset_objects%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Published photos are immutable' USING ERRCODE='23514'; END IF;
 -- Membership is in THIS immutable snapshot, never another publication or the
 -- current item/pointer. Old published photos survive live product deletion.
 IF NOT EXISTS (
  SELECT 1 FROM commerce_storefront_publications p
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.projection->'products')='array'
    THEN p.projection->'products' ELSE '[]'::jsonb END) AS product
  WHERE p.publication_id=NEW.publication_id AND p.tenant_id=NEW.tenant_id AND p.instance_id=NEW.instance_id
   AND jsonb_typeof(product->'sku')='string' AND product->>'sku'=NEW.sku
 ) THEN RAISE EXCEPTION 'Photo SKU must belong to its exact publication' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT object FROM asset_objects WHERE asset_id=NEW.asset_id AND scope_id=NEW.scope_id
  AND representation_id=NEW.representation_id AND policy_revision=NEW.policy_revision AND purpose='storefront.product-photo';
 IF (NEW.content_type IS NOT NULL AND NEW.content_type IS DISTINCT FROM object.content_type)
  OR (NEW.byte_size IS NOT NULL AND NEW.byte_size IS DISTINCT FROM object.byte_size)
  OR (NEW.content_sha256 IS NOT NULL AND NEW.content_sha256 IS DISTINCT FROM object.content_sha256)
  OR (NEW.transform_version IS NOT NULL AND NEW.transform_version IS DISTINCT FROM object.transform_version)
  OR (NEW.width IS NOT NULL AND NEW.width IS DISTINCT FROM object.pixel_width)
  OR (NEW.height IS NOT NULL AND NEW.height IS DISTINCT FROM object.pixel_height)
 THEN RAISE EXCEPTION 'Published photo metadata must match the immutable representation' USING ERRCODE='23514'; END IF;
 NEW.content_type:=object.content_type; NEW.byte_size:=object.byte_size; NEW.content_sha256:=object.content_sha256;
 NEW.transform_version:=object.transform_version; NEW.width:=object.pixel_width; NEW.height:=object.pixel_height;
 RETURN NEW;
END $$;
CREATE TRIGGER preserve_commerce_publication_photo BEFORE INSERT OR UPDATE OR DELETE ON commerce_publication_photo_refs
 FOR EACH ROW EXECUTE FUNCTION preserve_commerce_publication_photo();
CREATE TRIGGER reject_fenced_asset_reference BEFORE INSERT OR UPDATE ON commerce_publication_photo_refs
 FOR EACH ROW EXECUTE FUNCTION reject_fenced_asset_reference();

-- New PUT history is admitted, but photo GC stays uninstalled/fail-closed.
CREATE OR REPLACE FUNCTION preserve_asset_object_write_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i asset_upload_intents%ROWTYPE;a assets%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Write effect history is permanent' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.effect_id,NEW.intent_id,NEW.asset_id,NEW.intent_fence,NEW.settlement_nonce,NEW.begun_at) IS DISTINCT FROM ROW(OLD.effect_id,OLD.intent_id,OLD.asset_id,OLD.intent_fence,OLD.settlement_nonce,OLD.begun_at)
   OR OLD.state<>'started' OR NEW.state NOT IN ('fulfilled','unknown','not_started') OR NEW.finished_at IS NULL THEN RAISE EXCEPTION 'Invalid write effect transition' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 SELECT * INTO STRICT i FROM asset_upload_intents WHERE intent_id=NEW.intent_id AND asset_id=NEW.asset_id FOR UPDATE;
 SELECT * INTO STRICT a FROM assets WHERE asset_id=NEW.asset_id FOR UPDATE;
 IF NEW.state<>'started' OR NEW.finished_at IS NOT NULL OR i.fence<>NEW.intent_fence
  OR i.purpose NOT IN ('member.avatar','member.service-cover','community.event-banner','community.event-video','community.social-thumbnail','skill.submission-image','community.event-highlight','member.message-image','storefront.product-photo')
  OR i.state NOT IN ('processing','stored') OR i.expires_at<=clock_timestamp() OR i.lease_expires_at<=clock_timestamp()
  OR a.state<>'pending' OR a.deletion_fence<>0 THEN RAISE EXCEPTION 'Write effect admission is invalid' USING ERRCODE='23514';END IF;
 -- Separate PL/pgSQL statements keep the privileged avatar port out of the
 -- SQL expression planned for ordinary domain admission. SQL expression
 -- planning checks function privileges even when its AND branch is false.
 IF i.purpose='member.avatar' THEN
  IF NOT a.write_effect_coverage OR NOT operator_avatar_intent_admitted(i.intent_id) THEN
   RAISE EXCEPTION 'Avatar effect requires an approved operator intent' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END$$;
DO $$BEGIN
 EXECUTE format('ALTER FUNCTION %I.preserve_asset_object_write_effect() SET search_path=pg_catalog,%I',current_schema(),current_schema());
END$$;
