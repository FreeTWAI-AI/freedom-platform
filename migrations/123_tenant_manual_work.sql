-- Tenant manual Work and human Results. Expand only: no backfill and no policy seed.
-- Personal and community Work, personal Results, and their triggers stay unchanged.
-- Tenant Result bytes are retained human records. They are not domain-media GC candidates,
-- so this migration does not add work.tenant-result to write-effect or GC purpose lists.
-- write_effect_coverage stays at its false default, the same exclusion as work.private-draft.

CREATE TABLE module_instances (
  instance_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  module_key text NOT NULL CHECK (module_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  application_release_ref text NOT NULL CHECK (char_length(application_release_ref) BETWEEN 1 AND 200),
  data_schema_version text NOT NULL CHECK (char_length(data_schema_version) BETWEEN 1 AND 32),
  contract_ref jsonb CHECK (contract_ref IS NULL),
  status text NOT NULL CHECK (status IN ('provisioning','active','suspended','archived')),
  binding_id uuid NOT NULL,
  authority_epoch bigint NOT NULL DEFAULT 1 CHECK (authority_epoch > 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  configuration_revision bigint NOT NULL DEFAULT 1 CHECK (configuration_revision > 0),
  provision_operation_id uuid CHECK (provision_operation_id IS NULL),
  created_by_principal_id uuid NOT NULL,
  created_by_principal_kind text GENERATED ALWAYS AS ('person'::text) STORED,
  origin_guild_key text NOT NULL REFERENCES positioning_guild_catalog(guild_key),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, instance_id),
  UNIQUE (instance_id, binding_id),
  FOREIGN KEY (created_by_principal_id, created_by_principal_kind) REFERENCES principals(principal_id, kind)
);
CREATE INDEX module_instances_tenant_page ON module_instances (tenant_id, created_at DESC, instance_id DESC);

CREATE TABLE deployment_bindings (
  binding_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('hosted','external')),
  environment text NOT NULL CHECK (char_length(environment) BETWEEN 1 AND 64),
  endpoint_ref text,
  service_principal_id uuid,
  contract_ref jsonb CHECK (contract_ref IS NULL),
  state text NOT NULL CHECK (state IN ('pending','active','suspended','retired')),
  authority_epoch bigint NOT NULL DEFAULT 1 CHECK (authority_epoch > 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (instance_id, binding_id),
  CHECK (
    (mode = 'hosted' AND endpoint_ref IS NULL AND service_principal_id IS NULL)
    OR mode = 'external'),
  FOREIGN KEY (tenant_id, instance_id) REFERENCES module_instances(tenant_id, instance_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX deployment_bindings_one_active ON deployment_bindings (instance_id) WHERE state = 'active';

ALTER TABLE module_instances
  ADD CONSTRAINT module_instance_binding FOREIGN KEY (instance_id, binding_id)
  REFERENCES deployment_bindings(instance_id, binding_id) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION preserve_module_instance_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Module instance identity is retained' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.instance_id, NEW.tenant_id, NEW.module_key, NEW.application_release_ref, NEW.created_by_principal_id, NEW.origin_guild_key, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.instance_id, OLD.tenant_id, OLD.module_key, OLD.application_release_ref, OLD.created_by_principal_id, OLD.origin_guild_key, OLD.created_at) THEN
    RAISE EXCEPTION 'Module instance identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_module_instance_identity BEFORE UPDATE OR DELETE ON module_instances
  FOR EACH ROW EXECUTE FUNCTION preserve_module_instance_identity();

CREATE TABLE workspace_module_bindings (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  entry_capability text NOT NULL CHECK (entry_capability IN ('work:create')),
  instance_id uuid NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, workspace_id, entry_capability),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, workspace_id),
  FOREIGN KEY (tenant_id, instance_id) REFERENCES module_instances(tenant_id, instance_id)
);

CREATE FUNCTION preserve_workspace_module_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE instance_key text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Workspace module binding is retained' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW.tenant_id, NEW.workspace_id, NEW.entry_capability, NEW.instance_id, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.tenant_id, OLD.workspace_id, OLD.entry_capability, OLD.instance_id, OLD.created_at) THEN
    RAISE EXCEPTION 'Workspace module binding cannot be rebound' USING ERRCODE = '23514';
  END IF;
  SELECT module_key INTO STRICT instance_key FROM module_instances
    WHERE tenant_id = NEW.tenant_id AND instance_id = NEW.instance_id;
  IF instance_key IS DISTINCT FROM 'work' THEN
    RAISE EXCEPTION 'Workspace work binding requires a work instance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_workspace_module_binding BEFORE INSERT OR UPDATE OR DELETE ON workspace_module_bindings
  FOR EACH ROW EXECUTE FUNCTION preserve_workspace_module_binding();

CREATE TABLE tenant_capacity_policies (
  policy_id uuid PRIMARY KEY,
  revision bigint NOT NULL CHECK (revision > 0),
  tenant_id uuid REFERENCES tenants(tenant_id),
  plan_ref text NOT NULL CHECK (char_length(plan_ref) BETWEEN 1 AND 120),
  max_active_instances integer NOT NULL CHECK (max_active_instances >= 0),
  max_instances_per_module integer NOT NULL CHECK (max_instances_per_module >= 0),
  max_concurrent_provisions integer NOT NULL CHECK (max_concurrent_provisions >= 0),
  max_work_items integer NOT NULL CHECK (max_work_items >= 0),
  max_retained_bytes bigint NOT NULL CHECK (max_retained_bytes >= 0),
  max_concurrent_jobs integer NOT NULL CHECK (max_concurrent_jobs >= 0),
  max_model_budget bigint CHECK (max_model_budget IS NULL OR max_model_budget >= 0),
  status text NOT NULL CHECK (status IN ('active','retired')),
  policy_lock integer GENERATED ALWAYS AS (0) STORED,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX tenant_capacity_one_active_default ON tenant_capacity_policies (policy_lock)
  WHERE status = 'active' AND tenant_id IS NULL;
CREATE UNIQUE INDEX tenant_capacity_one_active_override ON tenant_capacity_policies (tenant_id)
  WHERE status = 'active' AND tenant_id IS NOT NULL;

-- Tenant Work is a third mode of work_items. Personal and community shape text
-- is the 081 constraint, unchanged. New columns stay null off this mode.
ALTER TABLE work_items
  ADD COLUMN tenant_id uuid,
  ADD COLUMN instance_id uuid,
  ADD COLUMN workspace_id uuid,
  ADD COLUMN created_by_principal_id uuid,
  ADD COLUMN created_by_principal_kind text GENERATED ALWAYS AS (
    CASE WHEN created_by_principal_id IS NOT NULL THEN 'person'::text END) STORED,
  ADD COLUMN progress text,
  ADD COLUMN updated_at timestamptz;

DO $$ DECLARE constraint_name text; BEGIN
  SELECT conname INTO STRICT constraint_name FROM pg_constraint
    WHERE conrelid = 'work_items'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%work_mode = ANY%';
  EXECUTE format('ALTER TABLE work_items DROP CONSTRAINT %I', constraint_name);
END $$;
ALTER TABLE work_items ADD CONSTRAINT work_items_work_mode_check
  CHECK (work_mode IN ('community_collaboration','personal_execution','tenant_execution'));
ALTER TABLE work_items DROP CONSTRAINT work_mode_shape;
ALTER TABLE work_items ADD CONSTRAINT work_mode_shape CHECK (
    (work_mode='community_collaboration' AND community_id IS NOT NULL AND owner_principal_id IS NULL
      AND state IN ('open','claiming_closed','accepted') AND gain IS NOT NULL AND acceptance_criteria IS NOT NULL
      AND participation_terms IS NOT NULL AND participation_terms_revision IS NOT NULL
      AND participation_terms_sha256 IS NOT NULL AND claim_window_expires_at IS NOT NULL AND due_at IS NOT NULL)
    OR (work_mode='personal_execution' AND community_id IS NULL AND scope_id IS NOT NULL AND owner_principal_id IS NOT NULL
      AND state IN ('draft','archived') AND gain IS NULL AND acceptance_criteria IS NULL AND participation_terms IS NULL
      AND participation_terms_revision IS NULL AND participation_terms_sha256 IS NULL
      AND claim_window_expires_at IS NULL AND due_at IS NULL)
    OR (work_mode='tenant_execution' AND community_id IS NULL AND owner_principal_id IS NULL
      AND tenant_id IS NOT NULL AND instance_id IS NOT NULL AND workspace_id IS NOT NULL
      AND scope_id IS NOT NULL AND created_by_principal_id IS NOT NULL AND progress IS NOT NULL
      AND updated_at IS NOT NULL AND state IN ('draft','archived')
      AND progress IN ('todo','in_progress','done')
      AND gain IS NULL AND acceptance_criteria IS NULL AND participation_terms IS NULL
      AND participation_terms_revision IS NULL AND participation_terms_sha256 IS NULL
      AND claim_window_expires_at IS NULL AND due_at IS NULL)
  );
ALTER TABLE work_items ADD CONSTRAINT tenant_work_columns_absent CHECK (
  work_mode = 'tenant_execution' OR (
    tenant_id IS NULL AND instance_id IS NULL AND workspace_id IS NULL
    AND created_by_principal_id IS NULL AND progress IS NULL AND updated_at IS NULL));
ALTER TABLE work_items ALTER COLUMN scope_kind SET EXPRESSION AS (
  CASE WHEN work_mode = 'personal_execution' THEN 'personal'
       WHEN work_mode = 'tenant_execution' THEN 'tenant'
       ELSE 'community' END);
ALTER TABLE work_items
  ADD CONSTRAINT work_tenant_instance FOREIGN KEY (tenant_id, instance_id)
    REFERENCES module_instances(tenant_id, instance_id),
  ADD CONSTRAINT work_tenant_workspace FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES workspaces(tenant_id, workspace_id),
  ADD CONSTRAINT work_tenant_scope FOREIGN KEY (scope_id, scope_kind, tenant_id)
    REFERENCES resource_scopes(scope_id, kind, tenant_ref),
  ADD CONSTRAINT work_tenant_author FOREIGN KEY (created_by_principal_id, created_by_principal_kind)
    REFERENCES principals(principal_id, kind),
  ADD CONSTRAINT work_tenant_target_identity UNIQUE (work_item_id, work_mode, scope_id, tenant_id),
  ADD CONSTRAINT work_tenant_instance_identity UNIQUE (work_item_id, work_mode, scope_id, tenant_id, instance_id);
CREATE INDEX tenant_work_workspace_page ON work_items (tenant_id, workspace_id, created_at DESC, work_item_id DESC)
  WHERE work_mode = 'tenant_execution' AND state = 'draft';

CREATE FUNCTION preserve_tenant_work_archive() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bound uuid;
BEGIN
  IF NEW.work_mode = 'tenant_execution' THEN
    IF TG_OP = 'INSERT' AND NEW.state <> 'draft' THEN
      RAISE EXCEPTION 'Tenant Work must start draft' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.state = 'archived' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Archived tenant Work is immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND ROW(NEW.tenant_id, NEW.instance_id, NEW.workspace_id, NEW.created_by_principal_id)
      IS DISTINCT FROM ROW(OLD.tenant_id, OLD.instance_id, OLD.workspace_id, OLD.created_by_principal_id) THEN
      RAISE EXCEPTION 'Tenant Work placement is immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
      SELECT instance_id INTO bound FROM workspace_module_bindings
        WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND entry_capability = 'work:create';
      IF bound IS DISTINCT FROM NEW.instance_id THEN
        RAISE EXCEPTION 'Tenant Work instance must match the workspace binding' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_tenant_work_archive BEFORE INSERT OR UPDATE ON work_items
  FOR EACH ROW EXECUTE FUNCTION preserve_tenant_work_archive();

ALTER TABLE assets ADD COLUMN tenant_ref uuid;
CREATE OR REPLACE FUNCTION preserve_asset_scope_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.scope_kind, NEW.community_ref, NEW.tenant_ref) IS DISTINCT FROM ROW(OLD.scope_kind, OLD.community_ref, OLD.tenant_ref) THEN
  RAISE EXCEPTION 'Asset scope identity is immutable' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
ALTER TABLE assets ADD CONSTRAINT asset_tenant_scope_owner
  FOREIGN KEY (scope_id, scope_kind, tenant_ref) REFERENCES resource_scopes(scope_id, kind, tenant_ref);
ALTER TABLE assets DROP CONSTRAINT assets_purpose_check;
ALTER TABLE assets ADD CONSTRAINT assets_purpose_check CHECK (purpose IN (
  'member.avatar','work.private-draft','member.service-cover','community.event-banner','community.event-video',
  'community.social-thumbnail','skill.submission-image','community.event-highlight','work.tenant-result'));
ALTER TABLE assets DROP CONSTRAINT asset_scope_purpose;
ALTER TABLE assets ADD CONSTRAINT asset_scope_purpose CHECK (
  (scope_kind = 'personal' AND community_ref IS NULL AND tenant_ref IS NULL
    AND purpose IN ('member.avatar','work.private-draft','member.service-cover','skill.submission-image'))
  OR (scope_kind = 'community' AND community_ref IS NOT NULL AND tenant_ref IS NULL
    AND purpose IN ('community.event-banner','community.event-video','community.social-thumbnail','community.event-highlight'))
  OR (scope_kind = 'tenant' AND tenant_ref IS NOT NULL AND community_ref IS NULL AND purpose = 'work.tenant-result'));

ALTER TABLE asset_upload_intents
  ADD COLUMN target_tenant_id uuid,
  ADD COLUMN display_name text,
  ADD COLUMN tenant_work_mode text GENERATED ALWAYS AS (
    CASE WHEN target_kind = 'work.tenant-result' THEN 'tenant_execution'::text ELSE NULL END) STORED;
ALTER TABLE asset_upload_intents DROP CONSTRAINT upload_profile_shape;
ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_profile_shape CHECK((target_highlight_media_id IS NULL AND (
(target_submission_id IS NULL AND ((target_post_id IS NULL AND (

 (target_video_event_id IS NULL AND (

 (target_event_id IS NULL AND target_community_id IS NULL AND source_orientation IS NULL AND purpose='member.avatar' AND target_kind='member.avatar' AND target_work_id IS NULL AND target_service_id IS NULL AND source_content_type IN ('image/png','image/jpeg','image/webp') AND source_byte_size BETWEEN 1 AND 2097152 AND reserved_bytes=131072)
 OR (target_event_id IS NULL AND target_community_id IS NULL AND source_orientation IS NULL AND purpose='work.private-draft' AND target_kind='work.private-result' AND target_work_id IS NOT NULL AND target_service_id IS NULL AND source_content_type IN ('text/plain','text/markdown') AND source_byte_size BETWEEN 1 AND 262144 AND reserved_bytes=262144)
 OR (target_event_id IS NULL AND target_community_id IS NULL AND source_orientation IS NULL AND purpose='work.private-draft' AND target_kind='work.model-result' AND target_work_id IS NOT NULL AND target_service_id IS NULL AND source_content_type='text/plain' AND source_byte_size BETWEEN 1 AND 16384 AND reserved_bytes=16384)
 OR (target_event_id IS NULL AND target_community_id IS NULL AND source_orientation IS NULL AND purpose='member.service-cover' AND target_kind='member.service-cover' AND target_service_id IS NOT NULL AND target_work_id IS NULL AND source_content_type IN ('image/png','image/jpeg','image/webp') AND source_byte_size BETWEEN 1 AND 4194304 AND reserved_bytes=524288)
 OR (purpose='community.event-banner' AND target_kind='community.event-banner' AND target_event_id IS NOT NULL AND target_community_id IS NOT NULL AND target_work_id IS NULL AND target_service_id IS NULL AND source_orientation IS NOT NULL AND source_orientation IN ('landscape','portrait') AND source_content_type IN ('image/png','image/jpeg','image/webp') AND source_byte_size BETWEEN 1 AND 524288 AND reserved_bytes=524288))) OR (purpose='community.event-video' AND target_kind='community.event-video' AND target_video_event_id IS NOT NULL AND target_event_id IS NULL AND target_community_id IS NOT NULL AND target_work_id IS NULL AND target_service_id IS NULL AND source_orientation IS NULL AND source_content_type IN ('video/mp4','video/webm') AND source_byte_size BETWEEN 1 AND 20971520 AND reserved_bytes=20971520))) OR (purpose='community.social-thumbnail' AND target_kind='community.social-thumbnail' AND target_post_id IS NOT NULL AND target_community_id IS NOT NULL AND target_event_id IS NULL AND target_video_event_id IS NULL AND target_work_id IS NULL AND target_service_id IS NULL AND source_orientation IS NULL AND source_content_type IN ('image/png','image/jpeg','image/webp') AND source_byte_size BETWEEN 1 AND 524288 AND reserved_bytes=524288))) OR (purpose='skill.submission-image' AND target_kind='skill.submission-image' AND target_submission_id IS NOT NULL AND target_work_id IS NULL AND target_service_id IS NULL AND target_event_id IS NULL AND target_video_event_id IS NULL AND target_post_id IS NULL AND target_community_id IS NULL AND source_orientation IS NULL AND source_content_type='image/webp' AND source_byte_size BETWEEN 1 AND 524288 AND reserved_bytes=524288))) OR (purpose='community.event-highlight' AND target_highlight_media_id IS NOT NULL AND target_community_id IS NOT NULL AND target_work_id IS NULL AND target_service_id IS NULL AND target_event_id IS NULL AND target_video_event_id IS NULL AND target_post_id IS NULL AND target_submission_id IS NULL AND source_orientation IS NULL AND source_content_type='image/webp' AND ((target_kind='community.event-highlight.image' AND source_byte_size BETWEEN 1 AND 1048576 AND reserved_bytes=1048576) OR (target_kind='community.event-highlight.thumb' AND source_byte_size BETWEEN 1 AND 204800 AND reserved_bytes=204800))) OR (target_highlight_media_id IS NULL AND target_submission_id IS NULL AND target_post_id IS NULL AND target_video_event_id IS NULL AND target_event_id IS NULL AND target_service_id IS NULL AND target_community_id IS NULL AND source_orientation IS NULL AND purpose='work.tenant-result' AND target_kind='work.tenant-result' AND target_work_id IS NOT NULL AND target_tenant_id IS NOT NULL AND display_name IS NOT NULL AND source_content_type IN ('text/plain','text/markdown') AND source_byte_size BETWEEN 1 AND 262144 AND reserved_bytes=262144));
ALTER TABLE asset_upload_intents ADD CONSTRAINT tenant_upload_identity CHECK (
  (target_kind = 'work.tenant-result' AND target_tenant_id IS NOT NULL AND display_name IS NOT NULL
    AND char_length(display_name) BETWEEN 1 AND 120 AND octet_length(display_name) <= 480
    AND strpos(display_name, '/') = 0 AND strpos(display_name, E'\\') = 0
    AND display_name !~ '[[:cntrl:]]')
  OR (target_kind <> 'work.tenant-result' AND target_tenant_id IS NULL AND display_name IS NULL));
ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_tenant_work_target
  FOREIGN KEY (target_work_id, tenant_work_mode, scope_id, target_tenant_id)
  REFERENCES work_items(work_item_id, work_mode, scope_id, tenant_id);
CREATE OR REPLACE FUNCTION preserve_upload_typed_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.target_kind, NEW.target_work_id, NEW.target_service_id, NEW.target_event_id, NEW.target_video_event_id, NEW.target_submission_id, NEW.target_post_id, NEW.target_highlight_media_id, NEW.target_community_id, NEW.source_orientation, NEW.display_name, NEW.target_tenant_id)
  IS DISTINCT FROM ROW(OLD.target_kind, OLD.target_work_id, OLD.target_service_id, OLD.target_event_id, OLD.target_video_event_id, OLD.target_submission_id, OLD.target_post_id, OLD.target_highlight_media_id, OLD.target_community_id, OLD.source_orientation, OLD.display_name, OLD.target_tenant_id) THEN
  RAISE EXCEPTION 'Upload typed target is immutable' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;

ALTER TABLE asset_objects DROP CONSTRAINT asset_object_profile_shape;
ALTER TABLE asset_objects ADD CONSTRAINT asset_object_profile_shape CHECK(
(


 (purpose='member.avatar' AND variant='avatar' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 131072 AND transform_version IN ('avatar.webp.v1','member.avatar.legacy-bytes.v1'))
 OR (purpose='work.private-draft' AND variant='draft' AND content_type IN ('text/plain','text/markdown') AND byte_size BETWEEN 1 AND 262144 AND transform_version='private-text.utf8.v1')
 OR (purpose='member.service-cover' AND variant='cover' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 524288 AND transform_version='member.service-cover.legacy-bytes.v1')
 OR (purpose='community.event-banner' AND variant='banner' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 524288 AND transform_version='community.event-banner.legacy-bytes.v1') OR (purpose='community.event-video' AND variant='video' AND content_type IN ('video/mp4','video/webm') AND byte_size BETWEEN 1 AND 20971520 AND transform_version='community.event-video.legacy-bytes.v1') OR (purpose='community.social-thumbnail' AND variant='thumbnail' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 524288 AND transform_version='community.social-thumbnail.legacy-bytes.v1')) OR (purpose='skill.submission-image' AND variant='illustration' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 524288 AND transform_version='skill.submission-image.legacy-bytes.v1') OR (purpose='community.event-highlight' AND content_type='image/webp' AND ((variant='image' AND byte_size BETWEEN 1 AND 1048576 AND transform_version='community.event-highlight.legacy-bytes.v1') OR (variant='thumb' AND byte_size BETWEEN 1 AND 204800 AND transform_version='community.event-highlight.thumbnail.legacy-bytes.v1'))) OR (purpose='work.tenant-result' AND variant='draft' AND content_type IN ('text/plain','text/markdown') AND byte_size BETWEEN 1 AND 262144 AND transform_version='private-text.utf8.v1'));

CREATE TABLE tenant_work_results (
  result_id uuid PRIMARY KEY,
  intent_id uuid NOT NULL UNIQUE REFERENCES asset_upload_intents(intent_id),
  work_item_id uuid NOT NULL,
  work_mode text GENERATED ALWAYS AS ('tenant_execution'::text) STORED,
  scope_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  asset_id uuid NOT NULL UNIQUE,
  representation_id uuid NOT NULL,
  policy_revision text NOT NULL,
  purpose text GENERATED ALWAYS AS ('work.tenant-result'::text) STORED,
  provenance text GENERATED ALWAYS AS ('human'::text) STORED,
  display_name text NOT NULL,
  content_type text NOT NULL,
  byte_size integer NOT NULL,
  content_sha256 text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  work_version bigint NOT NULL CHECK (work_version > 1),
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (work_item_id, work_mode, scope_id, tenant_id, instance_id)
    REFERENCES work_items(work_item_id, work_mode, scope_id, tenant_id, instance_id),
  FOREIGN KEY (asset_id, scope_id, owner_principal_id, owner_user_id, purpose, policy_revision, representation_id)
    REFERENCES assets(asset_id, scope_id, owner_principal_id, owner_user_id, purpose, policy_revision, representation_id),
  UNIQUE (work_item_id, revision),
  UNIQUE (work_item_id, work_version),
  UNIQUE (result_id, work_item_id, scope_id, tenant_id, asset_id, work_version)
);
CREATE TABLE tenant_work_result_targets (
  work_item_id uuid PRIMARY KEY,
  work_mode text GENERATED ALWAYS AS ('tenant_execution'::text) STORED,
  scope_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  owner_principal_id uuid,
  owner_user_id uuid,
  result_id uuid,
  asset_id uuid,
  linked_at_work_version bigint,
  purpose text GENERATED ALWAYS AS ('work.tenant-result'::text) STORED,
  asset_state text GENERATED ALWAYS AS ('ready'::text) STORED,
  FOREIGN KEY (work_item_id, work_mode, scope_id, tenant_id, instance_id)
    REFERENCES work_items(work_item_id, work_mode, scope_id, tenant_id, instance_id),
  FOREIGN KEY (result_id, work_item_id, scope_id, tenant_id, asset_id, linked_at_work_version)
    REFERENCES tenant_work_results(result_id, work_item_id, scope_id, tenant_id, asset_id, work_version),
  FOREIGN KEY (asset_id, scope_id, owner_principal_id, owner_user_id, purpose, asset_state)
    REFERENCES assets(asset_id, scope_id, owner_principal_id, owner_user_id, purpose, state),
  CHECK ((result_id IS NULL AND asset_id IS NULL AND linked_at_work_version IS NULL
      AND owner_principal_id IS NULL AND owner_user_id IS NULL)
    OR (result_id IS NOT NULL AND asset_id IS NOT NULL AND linked_at_work_version IS NOT NULL
      AND owner_principal_id IS NOT NULL AND owner_user_id IS NOT NULL))
);

CREATE FUNCTION preserve_tenant_work_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Tenant Result history is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER preserve_tenant_work_result BEFORE UPDATE OR DELETE ON tenant_work_results
  FOR EACH ROW EXECUTE FUNCTION preserve_tenant_work_result();

CREATE FUNCTION preserve_tenant_result_target() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target work_items%ROWTYPE; latest tenant_work_results%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Tenant Result target is retained' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW.work_item_id, NEW.scope_id, NEW.tenant_id, NEW.instance_id)
    IS DISTINCT FROM ROW(OLD.work_item_id, OLD.scope_id, OLD.tenant_id, OLD.instance_id) THEN
    RAISE EXCEPTION 'Tenant Result target cannot be rebound' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO STRICT target FROM work_items WHERE work_item_id = NEW.work_item_id FOR UPDATE;
  IF target.work_mode <> 'tenant_execution' OR target.state <> 'draft' OR target.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Result target must be active tenant Work' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO latest FROM tenant_work_results WHERE work_item_id = NEW.work_item_id ORDER BY revision DESC LIMIT 1;
  IF NEW.result_id IS DISTINCT FROM latest.result_id THEN
    RAISE EXCEPTION 'Result pointer must reference the latest revision' USING ERRCODE = '23514';
  END IF;
  IF NEW.asset_id IS NOT NULL THEN
    PERFORM 1 FROM assets WHERE asset_id = NEW.asset_id AND deletion_fence = 0 FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Result asset is permanently fenced' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_tenant_result_target BEFORE UPDATE OR DELETE ON tenant_work_result_targets
  FOR EACH ROW EXECUTE FUNCTION preserve_tenant_result_target();

CREATE FUNCTION append_tenant_work_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent asset_upload_intents%ROWTYPE; target work_items%ROWTYPE; artifact assets%ROWTYPE; object asset_objects%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Tenant Result history is immutable' USING ERRCODE = '23514'; END IF;
  IF NEW.work_item_id IS NOT NULL OR NEW.scope_id IS NOT NULL OR NEW.tenant_id IS NOT NULL OR NEW.instance_id IS NOT NULL
    OR NEW.workspace_id IS NOT NULL OR NEW.owner_principal_id IS NOT NULL OR NEW.owner_user_id IS NOT NULL
    OR NEW.asset_id IS NOT NULL OR NEW.representation_id IS NOT NULL OR NEW.policy_revision IS NOT NULL
    OR NEW.display_name IS NOT NULL OR NEW.content_type IS NOT NULL OR NEW.byte_size IS NOT NULL
    OR NEW.content_sha256 IS NOT NULL OR NEW.revision IS NOT NULL OR NEW.work_version IS NOT NULL
    OR NEW.created_by_principal_id IS NOT NULL THEN
    RAISE EXCEPTION 'Tenant Result identity is derived from the upload intent' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO STRICT intent FROM asset_upload_intents WHERE intent_id = NEW.intent_id;
  IF intent.purpose <> 'work.tenant-result' OR intent.target_kind <> 'work.tenant-result' THEN
    RAISE EXCEPTION 'Tenant Result requires a tenant text intent' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO STRICT target FROM work_items WHERE work_item_id = intent.target_work_id FOR UPDATE;
  IF target.work_mode <> 'tenant_execution' OR target.state <> 'draft'
    OR target.tenant_id IS DISTINCT FROM intent.target_tenant_id OR target.scope_id IS DISTINCT FROM intent.scope_id THEN
    RAISE EXCEPTION 'Tenant Result requires active tenant Work in the same scope' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM tenant_work_result_targets WHERE work_item_id = target.work_item_id FOR UPDATE;
  SELECT * INTO STRICT intent FROM asset_upload_intents WHERE intent_id = NEW.intent_id FOR UPDATE;
  SELECT * INTO STRICT artifact FROM assets WHERE asset_id = intent.asset_id FOR UPDATE;
  SELECT * INTO STRICT object FROM asset_objects WHERE asset_id = intent.asset_id;
  IF intent.state <> 'stored' OR intent.expires_at <= clock_timestamp() OR intent.lease_expires_at <= clock_timestamp()
    OR artifact.state <> 'ready' OR artifact.deletion_fence <> 0 OR artifact.purpose <> 'work.tenant-result'
    OR artifact.scope_kind <> 'tenant' OR artifact.tenant_ref IS DISTINCT FROM target.tenant_id THEN
    RAISE EXCEPTION 'Tenant Result requires a live stored intent and ready unfenced asset' USING ERRCODE = '23514';
  END IF;
  IF intent.expected_version <> target.aggregate_version THEN
    RAISE EXCEPTION 'Tenant Work version changed' USING ERRCODE = 'P0412';
  END IF;
  NEW.work_item_id := target.work_item_id;
  NEW.scope_id := intent.scope_id;
  NEW.tenant_id := target.tenant_id;
  NEW.instance_id := target.instance_id;
  NEW.workspace_id := target.workspace_id;
  NEW.owner_principal_id := intent.owner_principal_id;
  NEW.owner_user_id := intent.target_user_id;
  NEW.asset_id := intent.asset_id;
  NEW.representation_id := intent.representation_id;
  NEW.policy_revision := intent.policy_revision;
  NEW.display_name := intent.display_name;
  NEW.content_type := object.content_type;
  NEW.byte_size := object.byte_size;
  NEW.content_sha256 := object.content_sha256;
  NEW.created_by_principal_id := intent.owner_principal_id;
  NEW.work_version := target.aggregate_version + 1;
  SELECT COALESCE(max(revision), 0) + 1 INTO NEW.revision FROM tenant_work_results WHERE work_item_id = target.work_item_id;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER append_tenant_work_result BEFORE INSERT ON tenant_work_results
  FOR EACH ROW EXECUTE FUNCTION append_tenant_work_result();

CREATE FUNCTION publish_tenant_work_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM asset_upload_intents i JOIN assets a ON a.asset_id = i.asset_id
    WHERE i.intent_id = NEW.intent_id AND i.state = 'stored' AND i.expires_at > clock_timestamp()
      AND i.lease_expires_at > clock_timestamp() AND a.state = 'ready' AND a.deletion_fence = 0) THEN
    RAISE EXCEPTION 'Tenant Result lease expired before insertion' USING ERRCODE = '23514';
  END IF;
  UPDATE work_items SET aggregate_version = NEW.work_version, updated_at = clock_timestamp()
    WHERE work_item_id = NEW.work_item_id AND work_mode = 'tenant_execution'
      AND aggregate_version = NEW.work_version - 1 AND state = 'draft';
  IF NOT FOUND THEN RAISE EXCEPTION 'Tenant Work version changed' USING ERRCODE = 'P0412'; END IF;
  INSERT INTO tenant_work_result_targets(
      work_item_id, scope_id, tenant_id, instance_id, owner_principal_id, owner_user_id, result_id, asset_id, linked_at_work_version)
    VALUES (NEW.work_item_id, NEW.scope_id, NEW.tenant_id, NEW.instance_id, NEW.owner_principal_id, NEW.owner_user_id,
      NEW.result_id, NEW.asset_id, NEW.work_version)
    ON CONFLICT (work_item_id) DO UPDATE SET
      owner_principal_id = EXCLUDED.owner_principal_id, owner_user_id = EXCLUDED.owner_user_id,
      result_id = EXCLUDED.result_id, asset_id = EXCLUDED.asset_id, linked_at_work_version = EXCLUDED.linked_at_work_version;
  RETURN NULL;
END;
$$;
CREATE TRIGGER publish_tenant_work_result AFTER INSERT ON tenant_work_results
  FOR EACH ROW EXECUTE FUNCTION publish_tenant_work_result();

CREATE FUNCTION require_tenant_result_finalization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM asset_upload_intents WHERE intent_id = NEW.intent_id AND state = 'finalized') THEN
    RAISE EXCEPTION 'Tenant Result and intent finalization must commit together' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER require_tenant_result_finalization AFTER INSERT ON tenant_work_results
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_tenant_result_finalization();

CREATE FUNCTION require_finalized_tenant_intent_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_work_results WHERE intent_id = NEW.intent_id) THEN
    RAISE EXCEPTION 'Tenant intent finalization requires its immutable Result' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER require_finalized_tenant_intent_result AFTER INSERT OR UPDATE ON asset_upload_intents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.purpose = 'work.tenant-result' AND NEW.state = 'finalized')
  EXECUTE FUNCTION require_finalized_tenant_intent_result();
