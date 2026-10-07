-- Application catalog, module releases, launch plans, and provision operations.
-- First-party rows are the reviewed manual-workspace and work releases only.
-- Existing manual-work rows keep their identity; release pins and installations are filled in.

CREATE FUNCTION release_status_rank(value text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE value
    WHEN 'draft' THEN 1
    WHEN 'reviewed' THEN 2
    WHEN 'available' THEN 3
    WHEN 'retired' THEN 4
    ELSE 0
  END
$$;

CREATE FUNCTION contract_ref_shape_ok(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NOT NULL
    AND jsonb_typeof(value) = 'object'
    AND (SELECT count(*) FROM jsonb_object_keys(value)) = 5
    AND value ? 'family' AND value ? 'version' AND value ? 'source_commit'
    AND value ? 'artifact_sha256' AND value ? 'behavior_profile'
    AND (value->>'source_commit') ~ '^[0-9a-f]{40}$'
    AND (value->>'artifact_sha256') ~ '^[0-9a-f]{64}$'
    AND (value->>'family') ~ '^[a-z][a-z0-9_.-]{0,159}$'
    AND (value->>'version') ~ '^[1-9][0-9]{0,18}$'
    AND char_length(value->>'behavior_profile') BETWEEN 1 AND 160
    AND (value->>'behavior_profile') !~ '[[:space:]]'
$$;

CREATE FUNCTION policy_ref_shape_ok(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NOT NULL
    AND jsonb_typeof(value) = 'object'
    AND (SELECT count(*) FROM jsonb_object_keys(value)) = 2
    AND value ? 'policy_key' AND value ? 'version'
    AND (value->>'policy_key') ~ '^[a-z][a-z0-9_.-]{0,159}$'
    AND (value->>'version') ~ '^[1-9][0-9]{0,18}$'
$$;

CREATE FUNCTION digest_shape_ok(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NOT NULL
    AND jsonb_typeof(value) = 'object'
    AND (SELECT count(*) FROM jsonb_object_keys(value)) = 2
    AND value ? 'algorithm' AND value ? 'value'
    AND value->>'algorithm' = 'sha256'
    AND (value->>'value') ~ '^[0-9a-f]{64}$'
$$;

CREATE TABLE application_definitions (
  application_key text NOT NULL CHECK (application_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  release_ref text NOT NULL CHECK (
    char_length(release_ref) BETWEEN 1 AND 160
    AND release_ref ~ '^[a-z][a-z0-9_-]{0,140}@[0-9]+\.[0-9]+\.[0-9]+$'
    AND split_part(release_ref, '@', 1) = application_key),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  source_commit text NOT NULL CHECK (source_commit ~ '^[0-9a-f]{40}$'),
  artifact_digest jsonb NOT NULL CHECK (digest_shape_ok(artifact_digest)),
  skill_book_refs jsonb NOT NULL CHECK (jsonb_typeof(skill_book_refs) = 'array'),
  module_requirements jsonb NOT NULL CHECK (jsonb_typeof(module_requirements) = 'array'),
  entry_capability text NOT NULL CHECK (entry_capability ~ '^[a-z][a-z0-9_.:-]{0,159}$'),
  runtime_profiles jsonb NOT NULL CHECK (jsonb_typeof(runtime_profiles) = 'array'),
  launch_policy_ref jsonb NOT NULL CHECK (policy_ref_shape_ok(launch_policy_ref)),
  license_state text NOT NULL CHECK (license_state IN ('unresolved','reviewed','blocked')),
  release_status text NOT NULL CHECK (release_status IN ('draft','reviewed','available','retired')),
  customization_schema_ref text NOT NULL CHECK (char_length(customization_schema_ref) BETWEEN 1 AND 160),
  license_review_ref text CHECK (license_review_ref IS NULL OR char_length(license_review_ref) BETWEEN 1 AND 160),
  version bigint NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (application_key, release_ref),
  UNIQUE (release_ref)
);

CREATE FUNCTION preserve_application_definition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  status_changed boolean;
  license_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'application definition is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'application definition is immutable' USING ERRCODE = '23514';
  END IF;
  status_changed := NEW.release_status IS DISTINCT FROM OLD.release_status;
  license_changed := NEW.license_state IS DISTINCT FROM OLD.license_state;
  IF status_changed = license_changed THEN
    RAISE EXCEPTION 'application definition is immutable' USING ERRCODE = '23514';
  END IF;
  IF status_changed AND release_status_rank(NEW.release_status) <= release_status_rank(OLD.release_status) THEN
    RAISE EXCEPTION 'application definition is immutable' USING ERRCODE = '23514';
  END IF;
  IF license_changed AND (OLD.license_state IS DISTINCT FROM 'unresolved' OR NEW.license_state NOT IN ('reviewed','blocked')) THEN
    RAISE EXCEPTION 'application definition is immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.application_key, NEW.release_ref, NEW.display_name, NEW.source_commit, NEW.artifact_digest,
      NEW.skill_book_refs, NEW.module_requirements, NEW.entry_capability, NEW.runtime_profiles,
      NEW.launch_policy_ref, NEW.customization_schema_ref, NEW.license_review_ref, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.application_key, OLD.release_ref, OLD.display_name, OLD.source_commit, OLD.artifact_digest,
      OLD.skill_book_refs, OLD.module_requirements, OLD.entry_capability, OLD.runtime_profiles,
      OLD.launch_policy_ref, OLD.customization_schema_ref, OLD.license_review_ref, OLD.created_at) THEN
    RAISE EXCEPTION 'application definition is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_application_definition BEFORE UPDATE OR DELETE ON application_definitions
  FOR EACH ROW EXECUTE FUNCTION preserve_application_definition();

CREATE TABLE module_definitions (
  module_key text NOT NULL CHECK (module_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  release_ref text NOT NULL CHECK (
    char_length(release_ref) BETWEEN 1 AND 160
    AND release_ref ~ '^[a-z][a-z0-9_-]{0,140}@[0-9]+\.[0-9]+\.[0-9]+$'
    AND split_part(release_ref, '@', 1) = module_key),
  capabilities jsonb NOT NULL CHECK (jsonb_typeof(capabilities) = 'array'),
  data_catalog_ref text NOT NULL CHECK (char_length(data_catalog_ref) BETWEEN 1 AND 160),
  contract_ref jsonb NOT NULL CHECK (contract_ref_shape_ok(contract_ref)),
  data_schema_version text NOT NULL CHECK (data_schema_version ~ '^[1-9][0-9]{0,18}$'),
  portable_profile_ref text CHECK (portable_profile_ref IS NULL OR char_length(portable_profile_ref) BETWEEN 1 AND 160),
  runtime_profiles jsonb NOT NULL CHECK (jsonb_typeof(runtime_profiles) = 'array'),
  config_schema_ref text NOT NULL CHECK (char_length(config_schema_ref) BETWEEN 1 AND 160),
  supported_upgrade_paths jsonb NOT NULL CHECK (jsonb_typeof(supported_upgrade_paths) = 'array'),
  license_review_ref text CHECK (license_review_ref IS NULL OR char_length(license_review_ref) BETWEEN 1 AND 160),
  license_state text NOT NULL CHECK (license_state IN ('unresolved','reviewed','blocked')),
  release_status text NOT NULL CHECK (release_status IN ('draft','reviewed','available','retired')),
  version bigint NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (module_key, release_ref),
  UNIQUE (release_ref)
);

CREATE FUNCTION preserve_module_definition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  status_changed boolean;
  license_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'module definition is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'module definition is immutable' USING ERRCODE = '23514';
  END IF;
  status_changed := NEW.release_status IS DISTINCT FROM OLD.release_status;
  license_changed := NEW.license_state IS DISTINCT FROM OLD.license_state;
  IF status_changed = license_changed THEN
    RAISE EXCEPTION 'module definition is immutable' USING ERRCODE = '23514';
  END IF;
  IF status_changed AND release_status_rank(NEW.release_status) <= release_status_rank(OLD.release_status) THEN
    RAISE EXCEPTION 'module definition is immutable' USING ERRCODE = '23514';
  END IF;
  IF license_changed AND (OLD.license_state IS DISTINCT FROM 'unresolved' OR NEW.license_state NOT IN ('reviewed','blocked')) THEN
    RAISE EXCEPTION 'module definition is immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.module_key, NEW.release_ref, NEW.capabilities, NEW.data_catalog_ref, NEW.contract_ref,
      NEW.data_schema_version, NEW.portable_profile_ref, NEW.runtime_profiles, NEW.config_schema_ref,
      NEW.supported_upgrade_paths, NEW.license_review_ref, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.module_key, OLD.release_ref, OLD.capabilities, OLD.data_catalog_ref, OLD.contract_ref,
      OLD.data_schema_version, OLD.portable_profile_ref, OLD.runtime_profiles, OLD.config_schema_ref,
      OLD.supported_upgrade_paths, OLD.license_review_ref, OLD.created_at) THEN
    RAISE EXCEPTION 'module definition is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_module_definition BEFORE UPDATE OR DELETE ON module_definitions
  FOR EACH ROW EXECUTE FUNCTION preserve_module_definition();

CREATE TABLE guild_application_offerings (
  offering_id uuid PRIMARY KEY,
  community_id uuid REFERENCES communities(community_id),
  guild_key text REFERENCES positioning_guild_catalog(guild_key),
  application_key text NOT NULL,
  release_ref text NOT NULL,
  status text NOT NULL CHECK (status IN ('offered','withdrawn')),
  display_order integer NOT NULL CHECK (display_order BETWEEN 0 AND 1000),
  launch_policy_ref jsonb NOT NULL CHECK (policy_ref_shape_ok(launch_policy_ref)),
  version bigint NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (guild_key IS NULL OR community_id IS NOT NULL),
  UNIQUE NULLS NOT DISTINCT (community_id, guild_key, application_key, release_ref),
  FOREIGN KEY (application_key, release_ref) REFERENCES application_definitions(application_key, release_ref)
);

CREATE FUNCTION preserve_guild_application_offering() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'application offering is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 OR OLD.status IS DISTINCT FROM 'offered' OR NEW.status IS DISTINCT FROM 'withdrawn' THEN
    RAISE EXCEPTION 'application offering is immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.offering_id, NEW.community_id, NEW.guild_key, NEW.application_key, NEW.release_ref,
      NEW.display_order, NEW.launch_policy_ref, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.offering_id, OLD.community_id, OLD.guild_key, OLD.application_key, OLD.release_ref,
      OLD.display_order, OLD.launch_policy_ref, OLD.created_at) THEN
    RAISE EXCEPTION 'application offering is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_guild_application_offering BEFORE UPDATE OR DELETE ON guild_application_offerings
  FOR EACH ROW EXECUTE FUNCTION preserve_guild_application_offering();

DO $$
DECLARE
  work_contract jsonb := jsonb_build_object(
    'family', 'guild-launchpad.tenant-work',
    'version', '1',
    'source_commit', '5ccd76c347a137ef896ffc266168c0e89cc5b575',
    'artifact_sha256', '8c121e2b2aa05a233f0402209ea75093252f383f337200a3d2707160a0278142',
    'behavior_profile', 'freedom.tenant-work/v1');
  launch_policy jsonb := jsonb_build_object('policy_key', 'manual-workspace.launch', 'version', '1');
  work_capabilities jsonb := jsonb_build_array('work:create','work:read','work:write','work:archive','work:result.write');
BEGIN
  INSERT INTO module_definitions (
    module_key, release_ref, capabilities, data_catalog_ref, contract_ref, data_schema_version,
    portable_profile_ref, runtime_profiles, config_schema_ref, supported_upgrade_paths,
    license_review_ref, license_state, release_status, version)
  VALUES (
    'work', 'work@1.0.0', work_capabilities, 'work.tenant/v1', work_contract, '1',
    NULL, jsonb_build_array('hosted-shared'), 'work.config/v1', '[]'::jsonb,
    NULL, 'reviewed', 'available', 1);
  INSERT INTO application_definitions (
    application_key, release_ref, display_name, source_commit, artifact_digest, skill_book_refs,
    module_requirements, entry_capability, runtime_profiles, launch_policy_ref, license_state,
    release_status, customization_schema_ref, license_review_ref, version)
  VALUES (
    'manual-workspace', 'manual-workspace@1.0.0', '人工工作空間',
    '5ccd76c347a137ef896ffc266168c0e89cc5b575',
    jsonb_build_object('algorithm','sha256','value','8c121e2b2aa05a233f0402209ea75093252f383f337200a3d2707160a0278142'),
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'requirement_key', 'work',
      'module_key', 'work',
      'module_release_ref', 'work@1.0.0',
      'capabilities', work_capabilities,
      'required', true,
      'cardinality', 'one',
      'allow_reuse', true,
      'compatible_contracts', jsonb_build_array(work_contract))),
    'work:create', jsonb_build_array('hosted-reviewed'), launch_policy, 'reviewed', 'available',
    'manual-workspace.config/v1', NULL, 1);
  INSERT INTO guild_application_offerings (
    offering_id, community_id, guild_key, application_key, release_ref, status, display_order, launch_policy_ref, version)
  VALUES (
    gen_random_uuid(), NULL, NULL, 'manual-workspace', 'manual-workspace@1.0.0', 'offered', 0, launch_policy, 1);
END $$;

DO $$ DECLARE constraint_name text; BEGIN
  SELECT conname INTO STRICT constraint_name FROM pg_constraint
    WHERE conrelid = 'module_instances'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%contract_ref IS NULL%';
  EXECUTE format('ALTER TABLE module_instances DROP CONSTRAINT %I', constraint_name);
  SELECT conname INTO STRICT constraint_name FROM pg_constraint
    WHERE conrelid = 'module_instances'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%provision_operation_id IS NULL%';
  EXECUTE format('ALTER TABLE module_instances DROP CONSTRAINT %I', constraint_name);
  SELECT conname INTO STRICT constraint_name FROM pg_constraint
    WHERE conrelid = 'module_instances'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status = ANY%';
  EXECUTE format('ALTER TABLE module_instances DROP CONSTRAINT %I', constraint_name);
  SELECT conname INTO STRICT constraint_name FROM pg_constraint
    WHERE conrelid = 'deployment_bindings'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%contract_ref IS NULL%';
  EXECUTE format('ALTER TABLE deployment_bindings DROP CONSTRAINT %I', constraint_name);
END $$;

ALTER TABLE module_instances
  ADD COLUMN module_release_ref text,
  ADD CONSTRAINT module_instances_status_check CHECK (status IN ('requested','provisioning','active','failed','suspended','archived'));

UPDATE module_instances
  SET module_release_ref = 'work@1.0.0',
      contract_ref = (
        SELECT contract_ref FROM module_definitions WHERE module_key = 'work' AND release_ref = 'work@1.0.0')
  WHERE module_release_ref IS NULL;

ALTER TABLE module_instances
  ALTER COLUMN module_release_ref SET NOT NULL,
  ALTER COLUMN contract_ref SET NOT NULL,
  ADD CONSTRAINT module_instances_contract_ref_check CHECK (contract_ref_shape_ok(contract_ref));

ALTER TABLE module_instances
  ADD CONSTRAINT module_instances_module_release_fkey
    FOREIGN KEY (module_key, module_release_ref) REFERENCES module_definitions(module_key, release_ref),
  ADD CONSTRAINT module_instances_application_release_fkey
    FOREIGN KEY (application_release_ref) REFERENCES application_definitions(release_ref);

UPDATE deployment_bindings AS binding
  SET contract_ref = instance.contract_ref
  FROM module_instances AS instance
  WHERE binding.tenant_id = instance.tenant_id
    AND binding.instance_id = instance.instance_id
    AND binding.contract_ref IS NULL;

ALTER TABLE deployment_bindings
  ALTER COLUMN contract_ref SET NOT NULL,
  ADD CONSTRAINT deployment_bindings_contract_ref_check CHECK (contract_ref_shape_ok(contract_ref));

DO $$ DECLARE constraint_name text; BEGIN
  SELECT conname INTO STRICT constraint_name FROM pg_constraint
    WHERE conrelid = 'workspace_module_bindings'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%entry_capability%';
  EXECUTE format('ALTER TABLE workspace_module_bindings DROP CONSTRAINT %I', constraint_name);
END $$;

ALTER TABLE workspace_module_bindings
  ADD CONSTRAINT workspace_module_bindings_entry_capability_check
  CHECK (entry_capability ~ '^[a-z][a-z0-9_.:-]{0,159}$');

CREATE OR REPLACE FUNCTION preserve_workspace_module_binding() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF NEW.entry_capability = 'work:create' AND instance_key IS DISTINCT FROM 'work' THEN
    RAISE EXCEPTION 'Workspace work binding requires a work instance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE application_installations (
  installation_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  workspace_id uuid NOT NULL,
  application_key text NOT NULL,
  release_ref text NOT NULL,
  configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration) = 'object'),
  configuration_digest text NOT NULL CHECK (configuration_digest ~ '^[0-9a-f]{64}$'),
  configuration_revision bigint NOT NULL DEFAULT 1 CHECK (configuration_revision > 0),
  status text NOT NULL CHECK (status IN ('requested','provisioning','active','failed','suspended','archived')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_principal_id uuid NOT NULL,
  created_by_principal_kind text GENERATED ALWAYS AS ('person'::text) STORED,
  origin_guild_key text NOT NULL REFERENCES positioning_guild_catalog(guild_key),
  provision_operation_id uuid,
  retained_instance_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(retained_instance_ids) = 'array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, installation_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, workspace_id),
  FOREIGN KEY (application_key, release_ref) REFERENCES application_definitions(application_key, release_ref),
  FOREIGN KEY (created_by_principal_id, created_by_principal_kind) REFERENCES principals(principal_id, kind)
);
CREATE UNIQUE INDEX application_installations_one_live
  ON application_installations (tenant_id, workspace_id, application_key)
  WHERE status <> 'archived' AND status <> 'failed';
CREATE INDEX application_installations_tenant_page
  ON application_installations (tenant_id, created_at DESC, installation_id DESC);

CREATE TABLE application_module_links (
  installation_id uuid NOT NULL,
  requirement_key text NOT NULL CHECK (requirement_key ~ '^[a-z][a-z0-9_.-]{0,159}$'),
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  binding_selection text NOT NULL CHECK (binding_selection IN ('reuse','create')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (installation_id, requirement_key),
  FOREIGN KEY (tenant_id, installation_id) REFERENCES application_installations(tenant_id, installation_id),
  FOREIGN KEY (tenant_id, instance_id) REFERENCES module_instances(tenant_id, instance_id)
);

CREATE TABLE module_dependencies (
  dependency_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  caller_instance_id uuid NOT NULL,
  requirement_key text NOT NULL CHECK (requirement_key ~ '^[a-z][a-z0-9_.-]{0,159}$'),
  capability text NOT NULL CHECK (capability ~ '^[a-z][a-z0-9_.:-]{0,159}$'),
  provider_instance_id uuid NOT NULL,
  sharing_policy_ref jsonb CHECK (sharing_policy_ref IS NULL OR policy_ref_shape_ok(sharing_policy_ref)),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (caller_instance_id <> provider_instance_id),
  FOREIGN KEY (tenant_id, caller_instance_id) REFERENCES module_instances(tenant_id, instance_id),
  FOREIGN KEY (tenant_id, provider_instance_id) REFERENCES module_instances(tenant_id, instance_id)
);

CREATE FUNCTION reject_module_dependency_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  frontier uuid[] := ARRAY[NEW.provider_instance_id];
  nxt uuid[] := ARRAY[]::uuid[];
  depth integer := 0;
BEGIN
  IF NEW.caller_instance_id = NEW.provider_instance_id THEN
    RAISE EXCEPTION 'module dependency cycle' USING ERRCODE = '23514';
  END IF;
  WHILE cardinality(frontier) > 0 AND depth < 20 LOOP
    IF NEW.caller_instance_id = ANY(frontier) THEN
      RAISE EXCEPTION 'module dependency cycle' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(array_agg(DISTINCT dependency.provider_instance_id), ARRAY[]::uuid[])
      INTO nxt
      FROM module_dependencies AS dependency
      WHERE dependency.tenant_id = NEW.tenant_id
        AND dependency.caller_instance_id = ANY(frontier);
    frontier := nxt;
    depth := depth + 1;
  END LOOP;
  IF cardinality(frontier) > 0 THEN
    RAISE EXCEPTION 'module dependency cycle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reject_module_dependency_cycle BEFORE INSERT OR UPDATE ON module_dependencies
  FOR EACH ROW EXECUTE FUNCTION reject_module_dependency_cycle();

CREATE TABLE module_launch_plans (
  plan_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  actor_principal_id uuid NOT NULL,
  actor_principal_kind text GENERATED ALWAYS AS ('person'::text) STORED,
  guild_key text NOT NULL REFERENCES positioning_guild_catalog(guild_key),
  application_key text NOT NULL,
  release_ref text NOT NULL,
  workspace_id uuid NOT NULL,
  installation_choice text NOT NULL CHECK (installation_choice IN ('reuse_existing','create_new')),
  existing_installation_id uuid,
  configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration) = 'object'),
  configuration_digest text NOT NULL CHECK (configuration_digest ~ '^[0-9a-f]{64}$'),
  selection_digest text NOT NULL CHECK (selection_digest ~ '^[0-9a-f]{64}$'),
  dependency_versions jsonb NOT NULL CHECK (jsonb_typeof(dependency_versions) = 'array'),
  warnings jsonb NOT NULL CHECK (jsonb_typeof(warnings) = 'array'),
  capacity_delta jsonb NOT NULL CHECK (jsonb_typeof(capacity_delta) = 'array'),
  policy_revision bigint NOT NULL CHECK (policy_revision > 0),
  expires_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, plan_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, workspace_id),
  FOREIGN KEY (application_key, release_ref) REFERENCES application_definitions(application_key, release_ref),
  FOREIGN KEY (actor_principal_id, actor_principal_kind) REFERENCES principals(principal_id, kind),
  FOREIGN KEY (tenant_id, existing_installation_id) REFERENCES application_installations(tenant_id, installation_id)
);

CREATE FUNCTION preserve_module_launch_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'launch plan is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER preserve_module_launch_plan BEFORE UPDATE OR DELETE ON module_launch_plans
  FOR EACH ROW EXECUTE FUNCTION preserve_module_launch_plan();

CREATE TABLE module_provision_operations (
  operation_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  installation_id uuid NOT NULL,
  actor_principal_id uuid NOT NULL,
  actor_principal_kind text GENERATED ALWAYS AS ('person'::text) STORED,
  operation_kind text NOT NULL CHECK (operation_kind = 'application.launch'),
  state text NOT NULL CHECK (state IN ('requested','running','succeeded','failed','needs_reconciliation','cancelled')),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  plan_id uuid REFERENCES module_launch_plans(plan_id),
  authorization_revision bigint NOT NULL CHECK (authorization_revision > 0),
  policy_revision bigint NOT NULL CHECK (policy_revision > 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cancel_requested_at timestamptz,
  terminal_problem jsonb,
  UNIQUE (tenant_id, operation_id),
  FOREIGN KEY (tenant_id, installation_id) REFERENCES application_installations(tenant_id, installation_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (actor_principal_id, actor_principal_kind) REFERENCES principals(principal_id, kind)
);
CREATE INDEX module_provision_operations_due ON module_provision_operations (state, accepted_at);

ALTER TABLE module_instances
  ADD CONSTRAINT module_instances_provision_operation_fkey
  FOREIGN KEY (provision_operation_id) REFERENCES module_provision_operations(operation_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE module_launch_plan_consumptions (
  tenant_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (plan_id),
  UNIQUE (operation_id),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES module_launch_plans (tenant_id, plan_id),
  FOREIGN KEY (tenant_id, operation_id) REFERENCES module_provision_operations (tenant_id, operation_id)
);

CREATE FUNCTION preserve_module_launch_plan_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'launch plan consumption is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER preserve_module_launch_plan_consumption BEFORE UPDATE OR DELETE ON module_launch_plan_consumptions
  FOR EACH ROW EXECUTE FUNCTION preserve_module_launch_plan_consumption();

CREATE TABLE module_provision_steps (
  operation_id uuid NOT NULL REFERENCES module_provision_operations(operation_id),
  step_key text NOT NULL CHECK (step_key ~ '^[a-z][a-z0-9_.-]{0,159}$'),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  instance_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  provider_effect_key uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','dispatched','confirmed','failed_known','unknown','compensating','compensated')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_fence integer NOT NULL DEFAULT 0 CHECK (lease_fence >= 0),
  lease_expires_at timestamptz,
  evidence_ref text,
  result_digest text CHECK (result_digest IS NULL OR result_digest ~ '^[0-9a-f]{64}$'),
  expected_authority_epoch bigint NOT NULL CHECK (expected_authority_epoch > 0),
  problem jsonb,
  PRIMARY KEY (operation_id, step_key),
  UNIQUE (operation_id, provider_effect_key),
  FOREIGN KEY (tenant_id, instance_id) REFERENCES module_instances(tenant_id, instance_id)
);
CREATE INDEX module_provision_steps_due ON module_provision_steps (state, next_attempt_at, lease_expires_at);

CREATE TABLE capacity_reservations (
  reservation_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  operation_id uuid NOT NULL REFERENCES module_provision_operations(operation_id),
  dimension text NOT NULL CHECK (dimension ~ '^[a-z][a-z0-9_.-]{0,159}$'),
  units bigint NOT NULL CHECK (units > 0),
  policy_revision bigint NOT NULL CHECK (policy_revision > 0),
  state text NOT NULL CHECK (state IN ('reserved','consumed','released','unknown')),
  expires_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (operation_id, dimension)
);

CREATE TABLE capacity_ledger (
  entry_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  operation_id uuid NOT NULL REFERENCES module_provision_operations(operation_id),
  dimension text NOT NULL CHECK (dimension ~ '^[a-z][a-z0-9_.-]{0,159}$'),
  delta bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('reserved','actual','released','unknown')),
  source_ref text NOT NULL CHECK (char_length(source_ref) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION preserve_capacity_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'capacity ledger is append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER preserve_capacity_ledger BEFORE UPDATE OR DELETE ON capacity_ledger
  FOR EACH ROW EXECUTE FUNCTION preserve_capacity_ledger();

CREATE FUNCTION backfill_manual_workspace_installations() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  binding record;
  inst record;
  installation uuid;
  earliest_workspace uuid;
  selection text;
  empty_digest text := '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
BEGIN
  FOR binding IN
    SELECT workspace_binding.tenant_id, workspace_binding.workspace_id, workspace_binding.instance_id, workspace_binding.created_at
    FROM workspace_module_bindings AS workspace_binding
    WHERE workspace_binding.entry_capability = 'work:create'
      AND NOT EXISTS (
        SELECT 1 FROM application_installations AS installation_row
        WHERE installation_row.tenant_id = workspace_binding.tenant_id
          AND installation_row.workspace_id = workspace_binding.workspace_id
          AND installation_row.application_key = 'manual-workspace'
          AND installation_row.status <> 'archived'
          AND installation_row.status <> 'failed')
    ORDER BY workspace_binding.tenant_id, workspace_binding.instance_id, workspace_binding.created_at, workspace_binding.workspace_id
  LOOP
    SELECT * INTO inst FROM module_instances
      WHERE tenant_id = binding.tenant_id AND instance_id = binding.instance_id;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    SELECT workspace_binding.workspace_id INTO earliest_workspace
      FROM workspace_module_bindings AS workspace_binding
      WHERE workspace_binding.tenant_id = binding.tenant_id
        AND workspace_binding.instance_id = binding.instance_id
        AND workspace_binding.entry_capability = 'work:create'
      ORDER BY workspace_binding.created_at, workspace_binding.workspace_id
      LIMIT 1;
    selection := CASE WHEN binding.workspace_id = earliest_workspace THEN 'create' ELSE 'reuse' END;
    installation := gen_random_uuid();
    INSERT INTO application_installations (
      installation_id, tenant_id, workspace_id, application_key, release_ref,
      configuration, configuration_digest, status, created_by_principal_id, origin_guild_key,
      provision_operation_id, retained_instance_ids)
    VALUES (
      installation, binding.tenant_id, binding.workspace_id, 'manual-workspace', 'manual-workspace@1.0.0',
      '{}'::jsonb, empty_digest, 'active', inst.created_by_principal_id, inst.origin_guild_key,
      NULL, '[]'::jsonb);
    INSERT INTO application_module_links (
      installation_id, requirement_key, tenant_id, instance_id, binding_selection)
    VALUES (
      installation, 'work', binding.tenant_id, binding.instance_id, selection);
  END LOOP;
END;
$$;

SELECT backfill_manual_workspace_installations();

-- Tenant tables created above. ENABLE, never FORCE: the runtime role is not
-- the owner, so enabling row security already applies to it. Policies are
-- permissive and TO PUBLIC. A missing tenant context reads as NULL, and
-- tenant_id = NULL is false, so an unbound connection sees no row.
-- application_definitions, module_definitions and guild_application_offerings
-- have no tenant column and stay exempt. module_instances,
-- deployment_bindings and workspace_module_bindings are already enabled by
-- 125_tenant_row_security.sql. The backfill above runs as the migration
-- owner, and row security does not apply to the table owner.

ALTER TABLE application_installations ENABLE ROW LEVEL SECURITY;
CREATE POLICY application_installations_tenant ON application_installations FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());

ALTER TABLE application_module_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY application_module_links_tenant ON application_module_links FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());

ALTER TABLE module_dependencies ENABLE ROW LEVEL SECURITY;
CREATE POLICY module_dependencies_tenant ON module_dependencies FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());

ALTER TABLE module_launch_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY module_launch_plans_tenant ON module_launch_plans FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());

ALTER TABLE module_provision_operations ENABLE ROW LEVEL SECURITY;
CREATE POLICY module_provision_operations_tenant ON module_provision_operations FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());

ALTER TABLE module_launch_plan_consumptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY module_launch_plan_consumptions_tenant ON module_launch_plan_consumptions FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());

ALTER TABLE module_provision_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY module_provision_steps_tenant ON module_provision_steps FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());

ALTER TABLE capacity_reservations ENABLE ROW LEVEL SECURITY;
CREATE POLICY capacity_reservations_tenant ON capacity_reservations FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());

ALTER TABLE capacity_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY capacity_ledger_tenant ON capacity_ledger FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());
