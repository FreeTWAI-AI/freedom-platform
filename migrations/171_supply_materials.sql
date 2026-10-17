-- S3 cooperation materials (SC-09). Records of a supplier business in its own
-- tenant: an image, a video or a copy text about one own product or the brand.
-- Image and video bytes are tenant Assets under the existing write protocol.
-- Versions are append-only and only move forward. Grants are one row per partner
-- shop and are only ever revoked, never deleted. Partners read through narrow
-- SELECT policies: an active grant held by a storefront shop of the reading
-- tenant; current cooperation is checked by the reading statement itself.
-- No storage is enabled: both new purposes get an off ('legacy') policy row and
-- an operator must approve persistence, revision and quota before uploads.
CREATE TABLE supply_materials (
 material_id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL, instance_id uuid NOT NULL,
 scope_id uuid NOT NULL, scope_kind text GENERATED ALWAYS AS ('tenant'::text) STORED,
 kind text NOT NULL CHECK(kind IN ('image','video','copy')),
 product_id uuid,
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 80 AND title !~ '[[:cntrl:]]'),
 description text NOT NULL DEFAULT '' CHECK(char_length(description)<=500 AND translate(description,E'\n','') !~ '[[:cntrl:]]'),
 access text NOT NULL DEFAULT 'partners' CHECK(access IN ('partners','public_use')),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','withdrawn')),
 current_version_id uuid,
 aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0),
 created_by_principal_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 withdrawn_at timestamptz,
 CHECK((state='withdrawn')=(withdrawn_at IS NOT NULL)),
 FOREIGN KEY(scope_id,scope_kind,tenant_id) REFERENCES resource_scopes(scope_id,kind,tenant_ref),
 FOREIGN KEY(tenant_id,instance_id) REFERENCES module_instances(tenant_id,instance_id),
 FOREIGN KEY(tenant_id,instance_id) REFERENCES commerce_storefront_profiles(tenant_id,instance_id),
 UNIQUE(material_id,tenant_id,instance_id),
 UNIQUE(material_id,tenant_id,instance_id,scope_id),
 UNIQUE(material_id,kind)
);
CREATE INDEX supply_materials_list ON supply_materials(tenant_id,instance_id,state,updated_at DESC,material_id);
CREATE INDEX supply_materials_product ON supply_materials(product_id) WHERE product_id IS NOT NULL;

CREATE TABLE supply_material_versions (
 version_id uuid PRIMARY KEY,
 material_id uuid NOT NULL, tenant_id uuid NOT NULL, instance_id uuid NOT NULL,
 scope_id uuid NOT NULL, scope_kind text GENERATED ALWAYS AS ('tenant'::text) STORED,
 kind text NOT NULL,
 version_no integer NOT NULL CHECK(version_no BETWEEN 1 AND 100),
 body text,
 asset_id uuid UNIQUE, representation_id uuid, policy_revision text, purpose text,
 asset_state text GENERATED ALWAYS AS ('ready'::text) STORED,
 content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
 created_by_principal_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((kind='copy' AND body IS NOT NULL AND char_length(body) BETWEEN 1 AND 2000 AND translate(body,E'\n','') !~ '[[:cntrl:]]'
   AND asset_id IS NULL AND representation_id IS NULL AND policy_revision IS NULL AND purpose IS NULL)
  OR (kind='image' AND body IS NULL AND asset_id IS NOT NULL AND representation_id IS NOT NULL AND policy_revision IS NOT NULL
   AND purpose='storefront.supply-material')
  OR (kind='video' AND body IS NULL AND asset_id IS NOT NULL AND representation_id IS NOT NULL AND policy_revision IS NOT NULL
   AND purpose='storefront.supply-material-video')),
 UNIQUE(material_id,version_no),
 UNIQUE(version_id,material_id),
 FOREIGN KEY(material_id,tenant_id,instance_id,scope_id) REFERENCES supply_materials(material_id,tenant_id,instance_id,scope_id),
 FOREIGN KEY(material_id,kind) REFERENCES supply_materials(material_id,kind),
 FOREIGN KEY(scope_id,scope_kind,tenant_id) REFERENCES resource_scopes(scope_id,kind,tenant_ref),
 FOREIGN KEY(asset_id,scope_id,tenant_id,purpose,representation_id,asset_state)
  REFERENCES assets(asset_id,scope_id,tenant_ref,purpose,representation_id,state),
 FOREIGN KEY(asset_id,scope_id,representation_id,policy_revision,purpose)
  REFERENCES asset_objects(asset_id,scope_id,representation_id,policy_revision,purpose)
);
ALTER TABLE supply_materials ADD CONSTRAINT supply_material_current_version
 FOREIGN KEY(current_version_id,material_id) REFERENCES supply_material_versions(version_id,material_id);

CREATE TABLE supply_material_grants (
 grant_id uuid PRIMARY KEY,
 material_id uuid NOT NULL, tenant_id uuid NOT NULL, instance_id uuid NOT NULL,
 partner_shop_id uuid NOT NULL,
 granted_by_principal_id uuid NOT NULL,
 granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_by_principal_id uuid, revoked_at timestamptz,
 CHECK((revoked_at IS NULL)=(revoked_by_principal_id IS NULL)),
 CHECK(revoked_at IS NULL OR revoked_at>=granted_at),
 FOREIGN KEY(material_id,tenant_id,instance_id) REFERENCES supply_materials(material_id,tenant_id,instance_id)
);
CREATE UNIQUE INDEX supply_material_active_grant ON supply_material_grants(material_id,partner_shop_id) WHERE revoked_at IS NULL;
CREATE INDEX supply_material_partner_grants ON supply_material_grants(partner_shop_id,material_id) WHERE revoked_at IS NULL;

ALTER TABLE supply_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE supply_material_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE supply_material_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY supply_materials_tenant ON supply_materials FOR ALL TO PUBLIC
 USING(tenant_id=freedom_ctx_tenant()) WITH CHECK(tenant_id=freedom_ctx_tenant());
CREATE POLICY supply_material_versions_tenant ON supply_material_versions FOR ALL TO PUBLIC
 USING(tenant_id=freedom_ctx_tenant()) WITH CHECK(tenant_id=freedom_ctx_tenant());
CREATE POLICY supply_material_grants_tenant ON supply_material_grants FOR ALL TO PUBLIC
 USING(tenant_id=freedom_ctx_tenant()) WITH CHECK(tenant_id=freedom_ctx_tenant());
-- Partner reads, SELECT only. A grant row is visible to the tenant of its storefront
-- shop while active; through it the active material; through that its current version.
CREATE POLICY supply_material_grants_partner_read ON supply_material_grants FOR SELECT TO PUBLIC
 USING(revoked_at IS NULL AND EXISTS(SELECT 1 FROM commerce_storefront_profiles p
  WHERE p.storefront_shop_id=supply_material_grants.partner_shop_id AND p.tenant_id=freedom_ctx_tenant()));
CREATE POLICY supply_materials_partner_read ON supply_materials FOR SELECT TO PUBLIC
 USING(state='active' AND EXISTS(SELECT 1 FROM supply_material_grants g
  WHERE g.material_id=supply_materials.material_id AND g.revoked_at IS NULL));
CREATE POLICY supply_material_versions_partner_read ON supply_material_versions FOR SELECT TO PUBLIC
 USING(EXISTS(SELECT 1 FROM supply_materials m
  WHERE m.material_id=supply_material_versions.material_id AND m.current_version_id=supply_material_versions.version_id));

CREATE FUNCTION preserve_supply_material() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous integer; following integer;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Supply materials are retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'active' OR NEW.aggregate_version<>1 OR NEW.current_version_id IS NOT NULL OR NEW.withdrawn_at IS NOT NULL
  THEN RAISE EXCEPTION 'A material starts active, empty and at version 1' USING ERRCODE='23514'; END IF;
  IF NEW.product_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM commerce_storefront_profiles p
   JOIN commerce_items i ON i.shop_id=p.supply_shop_id AND i.item_id=NEW.product_id
   JOIN commerce_resource_tenants m ON m.resource_kind='shop' AND m.resource_id=p.supply_shop_id
    AND m.tenant_id=p.tenant_id AND m.instance_id=p.instance_id AND m.mapping_state='confirmed'
   WHERE p.tenant_id=NEW.tenant_id AND p.instance_id=NEW.instance_id)
  THEN RAISE EXCEPTION 'A material product must be an own supply product' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF ROW(NEW.material_id,NEW.tenant_id,NEW.instance_id,NEW.scope_id,NEW.kind,NEW.product_id,NEW.created_by_principal_id,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.material_id,OLD.tenant_id,OLD.instance_id,OLD.scope_id,OLD.kind,OLD.product_id,OLD.created_by_principal_id,OLD.created_at)
 THEN RAISE EXCEPTION 'Material identity is immutable' USING ERRCODE='23514'; END IF;
 IF OLD.state='withdrawn' THEN RAISE EXCEPTION 'A withdrawn material is final' USING ERRCODE='23514'; END IF;
 IF NEW.aggregate_version<>OLD.aggregate_version+1 THEN RAISE EXCEPTION 'Material version must advance by one' USING ERRCODE='23514'; END IF;
 IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
  SELECT version_no INTO following FROM supply_material_versions WHERE version_id=NEW.current_version_id AND material_id=NEW.material_id;
  SELECT version_no INTO previous FROM supply_material_versions WHERE version_id=OLD.current_version_id AND material_id=OLD.material_id;
  IF following IS NULL OR following<=COALESCE(previous,0) THEN RAISE EXCEPTION 'The current version only moves forward' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.updated_at:=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER preserve_supply_material BEFORE INSERT OR UPDATE OR DELETE ON supply_materials
 FOR EACH ROW EXECUTE FUNCTION preserve_supply_material();

CREATE FUNCTION preserve_supply_material_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE material_state text; object_sha256 text; digest text;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Material versions are immutable' USING ERRCODE='23514'; END IF;
 SELECT state INTO material_state FROM supply_materials WHERE material_id=NEW.material_id;
 IF material_state IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'Only an active material takes new versions' USING ERRCODE='23514'; END IF;
 IF NEW.version_no<>COALESCE((SELECT max(version_no) FROM supply_material_versions WHERE material_id=NEW.material_id),0)+1
 THEN RAISE EXCEPTION 'Material versions are numbered in order' USING ERRCODE='23514'; END IF;
 IF NEW.kind='copy' THEN
  digest:=encode(sha256(convert_to(NEW.body,'UTF8')),'hex');
 ELSE
  SELECT content_sha256 INTO object_sha256 FROM asset_objects WHERE asset_id=NEW.asset_id AND scope_id=NEW.scope_id
   AND representation_id=NEW.representation_id AND policy_revision=NEW.policy_revision AND purpose=NEW.purpose;
  IF object_sha256 IS NULL THEN RAISE EXCEPTION 'A media version needs its stored object' USING ERRCODE='23514'; END IF;
  digest:=object_sha256;
 END IF;
 IF NEW.content_sha256 IS NOT NULL AND NEW.content_sha256<>digest THEN
  RAISE EXCEPTION 'Version digest must match its content' USING ERRCODE='23514';
 END IF;
 NEW.content_sha256:=digest;
 RETURN NEW;
END $$;
CREATE TRIGGER preserve_supply_material_version BEFORE INSERT OR UPDATE OR DELETE ON supply_material_versions
 FOR EACH ROW EXECUTE FUNCTION preserve_supply_material_version();
CREATE TRIGGER reject_fenced_asset_reference BEFORE INSERT ON supply_material_versions
 FOR EACH ROW EXECUTE FUNCTION reject_fenced_asset_reference();

CREATE FUNCTION preserve_supply_material_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Material grants are retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'A grant starts active' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM supply_materials WHERE material_id=NEW.material_id AND state='active')
  THEN RAISE EXCEPTION 'Only an active material can be granted' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM commerce_storefront_profiles p JOIN commerce_shops s ON s.shop_id=p.storefront_shop_id AND s.origin='hosted'
    WHERE p.storefront_shop_id=NEW.partner_shop_id)
   OR EXISTS(SELECT 1 FROM commerce_storefront_profiles own WHERE own.tenant_id=NEW.tenant_id
    AND NEW.partner_shop_id IN (own.supply_shop_id,own.storefront_shop_id))
  THEN RAISE EXCEPTION 'A grant names another hosted storefront shop' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF ROW(NEW.grant_id,NEW.material_id,NEW.tenant_id,NEW.instance_id,NEW.partner_shop_id,NEW.granted_by_principal_id,NEW.granted_at)
  IS DISTINCT FROM ROW(OLD.grant_id,OLD.material_id,OLD.tenant_id,OLD.instance_id,OLD.partner_shop_id,OLD.granted_by_principal_id,OLD.granted_at)
  OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
 THEN RAISE EXCEPTION 'A grant can only be revoked, once' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER preserve_supply_material_grant BEFORE INSERT OR UPDATE OR DELETE ON supply_material_grants
 FOR EACH ROW EXECUTE FUNCTION preserve_supply_material_grant();

-- Upload intents name their material; the tuple binds tenant, instance and scope.
ALTER TABLE asset_upload_intents ADD COLUMN target_material_id uuid;
ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_supply_material_target
 FOREIGN KEY(target_material_id,target_tenant_id,target_instance_id,scope_id)
 REFERENCES supply_materials(material_id,tenant_id,instance_id,scope_id);
CREATE FUNCTION preserve_supply_material_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.target_material_id IS DISTINCT FROM OLD.target_material_id THEN RAISE EXCEPTION 'Material intent target is immutable' USING ERRCODE='23514';END IF;RETURN NEW; END $$;
CREATE TRIGGER preserve_supply_material_intent BEFORE UPDATE ON asset_upload_intents
 FOR EACH ROW EXECUTE FUNCTION preserve_supply_material_intent();

-- Two closed purposes, both tenant-scoped. Each live predicate is kept as it is
-- for every other purpose; purpose is NOT NULL on all four tables.
DO $$DECLARE old_shape text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_shape FROM pg_constraint WHERE conrelid='domain_media_storage_policy'::regclass AND conname='domain_media_storage_policy_purpose_check';
 ALTER TABLE domain_media_storage_policy DROP CONSTRAINT domain_media_storage_policy_purpose_check;
 EXECUTE format('ALTER TABLE domain_media_storage_policy ADD CONSTRAINT domain_media_storage_policy_purpose_check CHECK (((%s) AND purpose NOT IN (''storefront.supply-material'',''storefront.supply-material-video'')) OR purpose IN (''storefront.supply-material'',''storefront.supply-material-video''))',old_shape);
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_shape FROM pg_constraint WHERE conrelid='assets'::regclass AND conname='assets_purpose_check';
 ALTER TABLE assets DROP CONSTRAINT assets_purpose_check;
 EXECUTE format('ALTER TABLE assets ADD CONSTRAINT assets_purpose_check CHECK (((%s) AND purpose NOT IN (''storefront.supply-material'',''storefront.supply-material-video'')) OR purpose IN (''storefront.supply-material'',''storefront.supply-material-video''))',old_shape);
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_shape FROM pg_constraint WHERE conrelid='assets'::regclass AND conname='asset_scope_purpose';
 ALTER TABLE assets DROP CONSTRAINT asset_scope_purpose;
 EXECUTE format('ALTER TABLE assets ADD CONSTRAINT asset_scope_purpose CHECK (((%s) AND purpose NOT IN (''storefront.supply-material'',''storefront.supply-material-video'')) OR (purpose IN (''storefront.supply-material'',''storefront.supply-material-video'') AND scope_kind=''tenant'' AND tenant_ref IS NOT NULL AND community_ref IS NULL))',old_shape);
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_shape FROM pg_constraint WHERE conrelid='asset_objects'::regclass AND conname='asset_object_profile_shape';
 ALTER TABLE asset_objects DROP CONSTRAINT asset_object_profile_shape;
 EXECUTE format('ALTER TABLE asset_objects ADD CONSTRAINT asset_object_profile_shape CHECK (((%s) AND purpose NOT IN (''storefront.supply-material'',''storefront.supply-material-video'')) OR (purpose=''storefront.supply-material'' AND variant=''image'' AND content_type=''image/webp'' AND byte_size BETWEEN 1 AND 1048576 AND transform_version=''storefront.supply-material.webp.v1'') OR (purpose=''storefront.supply-material-video'' AND variant=''video'' AND content_type IN (''video/mp4'',''video/webm'') AND byte_size BETWEEN 1 AND 20971520 AND transform_version=''storefront.supply-material-video.original.v1''))',old_shape);
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_shape FROM pg_constraint WHERE conrelid='asset_objects'::regclass AND conname='asset_object_profile_id_shape';
 ALTER TABLE asset_objects DROP CONSTRAINT asset_object_profile_id_shape;
 EXECUTE format('ALTER TABLE asset_objects ADD CONSTRAINT asset_object_profile_id_shape CHECK (((%s) AND purpose NOT IN (''storefront.supply-material'',''storefront.supply-material-video'')) OR (purpose IN (''storefront.supply-material'',''storefront.supply-material-video'') AND profile_id IS NOT NULL AND profile_id=purpose))',old_shape);
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_shape FROM pg_constraint WHERE conrelid='asset_objects'::regclass AND conname='asset_object_photo_dimensions';
 ALTER TABLE asset_objects DROP CONSTRAINT asset_object_photo_dimensions;
 EXECUTE format('ALTER TABLE asset_objects ADD CONSTRAINT asset_object_photo_dimensions CHECK (((%s) AND purpose<>''storefront.supply-material'') OR (purpose=''storefront.supply-material'' AND pixel_width IS NOT NULL AND pixel_height IS NOT NULL AND pixel_width BETWEEN 1 AND 1920 AND pixel_height BETWEEN 1 AND 1920))',old_shape);
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_shape FROM pg_constraint WHERE conrelid='asset_upload_intents'::regclass AND conname='upload_profile_shape';
 ALTER TABLE asset_upload_intents DROP CONSTRAINT upload_profile_shape;
 EXECUTE format('ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_profile_shape CHECK (((%s) AND purpose NOT IN (''storefront.supply-material'',''storefront.supply-material-video'') AND target_material_id IS NULL) OR (purpose=''storefront.supply-material'' AND target_kind=purpose AND target_material_id IS NOT NULL AND target_tenant_id IS NOT NULL AND target_instance_id IS NOT NULL AND target_product_id IS NULL AND target_ar_id IS NULL AND target_comment_image_id IS NULL AND target_message_image_id IS NULL AND target_work_id IS NULL AND target_service_id IS NULL AND target_event_id IS NULL AND target_video_event_id IS NULL AND target_post_id IS NULL AND target_submission_id IS NULL AND target_highlight_media_id IS NULL AND target_community_id IS NULL AND display_name IS NULL AND source_orientation IS NULL AND source_content_type IN (''image/png'',''image/jpeg'',''image/webp'') AND source_byte_size BETWEEN 1 AND 2097152 AND reserved_bytes=1048576) OR (purpose=''storefront.supply-material-video'' AND target_kind=purpose AND target_material_id IS NOT NULL AND target_tenant_id IS NOT NULL AND target_instance_id IS NOT NULL AND target_product_id IS NULL AND target_ar_id IS NULL AND target_comment_image_id IS NULL AND target_message_image_id IS NULL AND target_work_id IS NULL AND target_service_id IS NULL AND target_event_id IS NULL AND target_video_event_id IS NULL AND target_post_id IS NULL AND target_submission_id IS NULL AND target_highlight_media_id IS NULL AND target_community_id IS NULL AND display_name IS NULL AND source_orientation IS NULL AND source_content_type IN (''video/mp4'',''video/webm'') AND source_byte_size BETWEEN 1 AND 20971520 AND reserved_bytes=20971520))',old_shape);
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_shape FROM pg_constraint WHERE conrelid='asset_upload_intents'::regclass AND conname='tenant_upload_identity';
 ALTER TABLE asset_upload_intents DROP CONSTRAINT tenant_upload_identity;
 EXECUTE format('ALTER TABLE asset_upload_intents ADD CONSTRAINT tenant_upload_identity CHECK (((%s) AND purpose NOT IN (''storefront.supply-material'',''storefront.supply-material-video'')) OR (purpose IN (''storefront.supply-material'',''storefront.supply-material-video'') AND target_tenant_id IS NOT NULL AND target_instance_id IS NOT NULL AND display_name IS NULL))',old_shape);
END $$;
-- Preserve the installed functions and their fixed search_path; add both closed
-- purposes to each exact admission list. Abort if the installed baseline differs.
DO $$DECLARE definition text;name text; BEGIN
 FOREACH name IN ARRAY ARRAY['preserve_domain_media_floor','preserve_asset_object_write_effect'] LOOP
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname=name AND n.nspname=current_schema();
  IF strpos(definition,'''community.comment-image'',''storefront.product-photo'',''member.ar-target''')=0 THEN RAISE EXCEPTION 'Unexpected asset admission baseline';END IF;
  EXECUTE replace(definition,'''community.comment-image'',''storefront.product-photo'',''member.ar-target''','''community.comment-image'',''storefront.product-photo'',''member.ar-target'',''storefront.supply-material'',''storefront.supply-material-video''');
 END LOOP;
END $$;
-- Off until an operator approves persistence, revision and quota for each purpose.
INSERT INTO domain_media_storage_policy(purpose) VALUES('storefront.supply-material'),('storefront.supply-material-video');
