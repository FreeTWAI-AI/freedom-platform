-- Closed human-selected metadata and consent records. No model authentication,
-- machine grant, lease, dispatch, provider key, or operational execution exists.
ALTER TABLE runtime_registrations ADD UNIQUE(runtime_device_id,owner_user_id,owner_principal_id,scope_id,environment);
ALTER TABLE agent_connections ADD UNIQUE(connection_id,runtime_device_id,owner_user_id,owner_principal_id,scope_id,environment,client_id);
ALTER TABLE bootstrap_refresh_families ADD UNIQUE(family_id,connection_id);
ALTER TABLE execution_runs ADD UNIQUE(run_id,work_item_id,owner_user_id,owner_principal_id,scope_id);

CREATE TABLE model_connections (
  model_connection_id uuid PRIMARY KEY,
  runtime_device_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  family_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  environment text NOT NULL,
  client_id text NOT NULL,
  selection jsonb NOT NULL,
  creation_key text NOT NULL CHECK(creation_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  UNIQUE(owner_principal_id,scope_id,environment,client_id,creation_key),
  state text NOT NULL DEFAULT 'unverified' CHECK(state IN ('unverified','revoked')),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0),
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK(isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
  CHECK((state='unverified' AND revoked_at IS NULL) OR (state='revoked' AND revoked_at IS NOT NULL AND isfinite(revoked_at) AND revoked_at=date_trunc('milliseconds',revoked_at) AND revoked_at>=created_at)),
  CHECK(COALESCE(jsonb_typeof(selection)='object' AND selection ?& ARRAY['providerRef','modelRef','processingLocation','artifactCustody','credentialCustody','engineLocation','billingSource']
    AND selection-ARRAY['providerRef','modelRef','processingLocation','artifactCustody','credentialCustody','engineLocation','billingSource']='{}'::jsonb
    AND jsonb_typeof(selection->'providerRef')='string' AND length(selection->>'providerRef') BETWEEN 1 AND 96 AND selection->>'providerRef' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    AND jsonb_typeof(selection->'modelRef')='string' AND length(selection->>'modelRef') BETWEEN 1 AND 96 AND selection->>'modelRef' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    AND jsonb_typeof(selection->'processingLocation')='string' AND length(selection->>'processingLocation') BETWEEN 1 AND 96 AND selection->>'processingLocation' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    AND selection->>'artifactCustody' IN ('runtime_local','platform_asset')
    AND ((selection->>'credentialCustody'='official_cli' AND selection->>'engineLocation'='runtime_local' AND selection->>'billingSource'='user_cli')
      OR (selection->>'credentialCustody'='local_keychain' AND selection->>'engineLocation'='runtime_local' AND selection->>'billingSource'='user_byok')
      OR (selection->>'credentialCustody'='platform_vault' AND selection->>'engineLocation'='platform' AND selection->>'billingSource'='user_byok')),false)),
  FOREIGN KEY(runtime_device_id,owner_user_id,owner_principal_id,scope_id,environment) REFERENCES runtime_registrations(runtime_device_id,owner_user_id,owner_principal_id,scope_id,environment),
  FOREIGN KEY(connection_id,runtime_device_id,owner_user_id,owner_principal_id,scope_id,environment,client_id) REFERENCES agent_connections(connection_id,runtime_device_id,owner_user_id,owner_principal_id,scope_id,environment,client_id),
  FOREIGN KEY(family_id,connection_id) REFERENCES bootstrap_refresh_families(family_id,connection_id),
  UNIQUE(model_connection_id,runtime_device_id,connection_id,family_id,owner_user_id,owner_principal_id,scope_id,environment,client_id)
);
CREATE INDEX model_connections_owner ON model_connections(owner_principal_id,environment,model_connection_id);

CREATE TABLE execution_grants (
  grant_id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  work_item_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  runtime_device_id uuid NOT NULL,
  runtime_version bigint NOT NULL CHECK(runtime_version>0),
  connection_id uuid NOT NULL,
  connection_version bigint NOT NULL CHECK(connection_version>0),
  family_id uuid NOT NULL,
  environment text NOT NULL,
  client_id text NOT NULL,
  model_connection_id uuid NOT NULL,
  model_version bigint NOT NULL CHECK(model_version>0),
  selection jsonb NOT NULL,
  input_work_version bigint NOT NULL CHECK(input_work_version>0),
  run_version bigint NOT NULL CHECK(run_version>0),
  task_lease_epoch bigint NOT NULL CHECK(task_lease_epoch>0),
  control_epoch bigint NOT NULL CHECK(control_epoch>0),
  persistence_policy_revision text NOT NULL,
  purpose text NOT NULL DEFAULT 'model.private-draft' CHECK(purpose='model.private-draft'),
  consent boolean NOT NULL CHECK(consent),
  creation_key text NOT NULL CHECK(creation_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  UNIQUE(owner_principal_id,scope_id,environment,client_id,creation_key),
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK(isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
  CHECK(isfinite(expires_at) AND expires_at=date_trunc('milliseconds',expires_at) AND expires_at>created_at AND expires_at<=created_at+interval '1 hour'),
  CHECK((state='active' AND revoked_at IS NULL) OR (state='revoked' AND revoked_at IS NOT NULL AND isfinite(revoked_at) AND revoked_at=date_trunc('milliseconds',revoked_at) AND revoked_at>=created_at)),
  FOREIGN KEY(run_id,work_item_id,owner_user_id,owner_principal_id,scope_id) REFERENCES execution_runs(run_id,work_item_id,owner_user_id,owner_principal_id,scope_id),
  FOREIGN KEY(model_connection_id,runtime_device_id,connection_id,family_id,owner_user_id,owner_principal_id,scope_id,environment,client_id) REFERENCES model_connections(model_connection_id,runtime_device_id,connection_id,family_id,owner_user_id,owner_principal_id,scope_id,environment,client_id),
  UNIQUE(grant_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id)
);
CREATE INDEX execution_grants_owner ON execution_grants(owner_principal_id,grant_id);

CREATE TABLE execution_attempts (
  attempt_id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  work_item_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK(attempt_number BETWEEN 1 AND 16),
  grant_snapshot jsonb NOT NULL,
  state text NOT NULL DEFAULT 'preflight_blocked' CHECK(state='preflight_blocked'),
  blockers jsonb NOT NULL DEFAULT '["model_authentication_unavailable","model_adapter_unavailable"]'::jsonb CHECK(blockers='["model_authentication_unavailable","model_adapter_unavailable"]'::jsonb),
  created_at timestamptz NOT NULL CHECK(isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
  UNIQUE(run_id,attempt_number),
  FOREIGN KEY(grant_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id) REFERENCES execution_grants(grant_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id)
);

-- Invoker rights and physical-schema qualification are intentional. Snapshot
-- values are binding metadata, never a verified context or auth evidence.
CREATE FUNCTION check_execution_prerequisite_binding(target_schema text, binding jsonb, full_binding boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE runtime record; connection record; family record; work record; run record; model record; policy record; grant_row record;
BEGIN
  EXECUTE format('SELECT * FROM %I.runtime_registrations WHERE runtime_device_id=$1 FOR SHARE',target_schema) INTO runtime USING (binding->>'runtime_device_id')::uuid;
  EXECUTE format('SELECT * FROM %I.agent_connections WHERE connection_id=$1 FOR SHARE',target_schema) INTO connection USING (binding->>'connection_id')::uuid;
  EXECUTE format('SELECT * FROM %I.bootstrap_refresh_families WHERE family_id=$1 FOR SHARE',target_schema) INTO family USING (binding->>'family_id')::uuid;
  IF runtime.runtime_device_id IS NULL OR connection.connection_id IS NULL OR family.family_id IS NULL
    OR runtime.state<>'enrolled' OR connection.state<>'active' OR family.state<>'active'
    OR ROW(runtime.runtime_device_id,runtime.owner_user_id,runtime.owner_principal_id,runtime.scope_id,runtime.environment)
      IS DISTINCT FROM ROW(connection.runtime_device_id,connection.owner_user_id,connection.owner_principal_id,connection.scope_id,connection.environment)
    OR ROW(connection.runtime_device_id,connection.owner_user_id,connection.owner_principal_id,connection.scope_id,connection.environment,connection.client_id)
      IS DISTINCT FROM ROW((binding->>'runtime_device_id')::uuid,(binding->>'owner_user_id')::uuid,(binding->>'owner_principal_id')::uuid,(binding->>'scope_id')::uuid,binding->>'environment',binding->>'client_id')
    OR (binding->>'created_at')::timestamptz<runtime.enrolled_at OR (binding->>'created_at')::timestamptz<connection.issued_at OR (binding->>'created_at')::timestamptz<family.issued_at
    OR family.connection_id IS DISTINCT FROM connection.connection_id
    OR connection.issued_at>clock_timestamp() OR connection.expires_at<=clock_timestamp()
    OR family.issued_at>clock_timestamp() OR family.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Current immutable execution backing required' USING ERRCODE='23514';
  END IF;
  IF full_binding THEN
    EXECUTE format('SELECT * FROM %I.work_items WHERE work_item_id=$1 FOR SHARE',target_schema) INTO work USING (binding->>'work_item_id')::uuid;
    EXECUTE format('SELECT * FROM %I.execution_runs WHERE run_id=$1 FOR SHARE',target_schema) INTO run USING (binding->>'run_id')::uuid;
    EXECUTE format('SELECT * FROM %I.model_connections WHERE model_connection_id=$1 FOR SHARE',target_schema) INTO model USING (binding->>'model_connection_id')::uuid;
    -- Existing Grant lock follows Model and precedes operator policy.
    EXECUTE format('SELECT * FROM %I.execution_grants WHERE grant_id=$1 FOR SHARE',target_schema) INTO grant_row USING (binding->>'grant_id')::uuid;
    IF grant_row.grant_id IS NOT NULL AND (grant_row.state<>'active' OR grant_row.aggregate_version<>1) THEN
      RAISE EXCEPTION 'Current consent record required' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT * FROM %I.private_work_persistence_policy WHERE scope_id=$1 AND owner_principal_id=$2 AND purpose=''work.private-draft'' FOR SHARE',target_schema)
      INTO policy USING (binding->>'scope_id')::uuid,(binding->>'owner_principal_id')::uuid;
    IF work.work_item_id IS NULL OR run.run_id IS NULL OR model.model_connection_id IS NULL OR policy.scope_id IS NULL
      OR work.work_mode<>'personal_execution' OR work.state<>'draft' OR run.state<>'created' OR model.state<>'unverified'
      OR ROW(work.owner_ref,work.owner_principal_id,work.scope_id) IS DISTINCT FROM ROW((binding->>'owner_user_id')::uuid,(binding->>'owner_principal_id')::uuid,(binding->>'scope_id')::uuid)
      OR ROW(run.work_item_id,run.owner_user_id,run.owner_principal_id,run.scope_id) IS DISTINCT FROM ROW(work.work_item_id,work.owner_ref,work.owner_principal_id,work.scope_id)
      OR ROW(model.runtime_device_id,model.connection_id,model.family_id,model.owner_user_id,model.owner_principal_id,model.scope_id,model.environment,model.client_id)
        IS DISTINCT FROM ROW(runtime.runtime_device_id,connection.connection_id,family.family_id,connection.owner_user_id,connection.owner_principal_id,connection.scope_id,connection.environment,connection.client_id)
      OR runtime.aggregate_version IS DISTINCT FROM (binding->>'runtime_version')::bigint
      OR connection.aggregate_version IS DISTINCT FROM (binding->>'connection_version')::bigint
      OR model.aggregate_version IS DISTINCT FROM (binding->>'model_version')::bigint OR model.selection IS DISTINCT FROM binding->'selection'
      OR work.aggregate_version IS DISTINCT FROM (binding->>'input_work_version')::bigint OR run.input_work_version IS DISTINCT FROM work.aggregate_version
      OR run.aggregate_version IS DISTINCT FROM (binding->>'run_version')::bigint
      OR run.task_lease_epoch IS DISTINCT FROM (binding->>'task_lease_epoch')::bigint OR run.control_epoch IS DISTINCT FROM (binding->>'control_epoch')::bigint
      OR NOT policy.persistence_allowed OR policy.retained_byte_limit IS NULL OR policy.retained_byte_limit<262144
      OR binding->>'persistence_policy_revision' IS DISTINCT FROM 'private-work.v'||policy.revision::text
      OR (binding->>'expires_at')::timestamptz>connection.expires_at OR (binding->>'expires_at')::timestamptz>family.expires_at
      OR (binding->>'created_at')::timestamptz<model.created_at
      OR (binding->>'created_at')::timestamptz>clock_timestamp() OR (binding->>'expires_at')::timestamptz<=clock_timestamp() THEN
      RAISE EXCEPTION 'Current exact consent binding required' USING ERRCODE='23514';
    END IF;
  END IF;
END;
$$;

CREATE FUNCTION execution_prerequisite_grant_snapshot(binding jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT binding || jsonb_build_object('aggregate_version',binding->>'aggregate_version','runtime_version',binding->>'runtime_version',
    'connection_version',binding->>'connection_version','model_version',binding->>'model_version','input_work_version',binding->>'input_work_version',
    'run_version',binding->>'run_version','task_lease_epoch',binding->>'task_lease_epoch','control_epoch',binding->>'control_epoch');
$$;

CREATE FUNCTION preserve_execution_prerequisite() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE grant_row record; total bigint; current_owner boolean;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Execution prerequisite history is retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='execution_attempts' THEN RAISE EXCEPTION 'Attempt snapshots are immutable' USING ERRCODE='23514'; END IF;
    IF (to_jsonb(NEW)-ARRAY['state','aggregate_version','revoked_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','aggregate_version','revoked_at'])
      OR OLD.state='revoked' OR NEW.state<>'revoked' OR NEW.aggregate_version::numeric<>OLD.aggregate_version::numeric+1
      OR NEW.revoked_at IS NULL OR NEW.revoked_at>clock_timestamp() THEN
      RAISE EXCEPTION 'Metadata identity is immutable and revocation terminal' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  -- Current physical member authority precedes all domain/advisory locks.
  EXECUTE format('SELECT true FROM %I.users WHERE user_id=$1 AND active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL) FOR SHARE',TG_TABLE_SCHEMA) INTO current_owner USING NEW.owner_user_id;
  IF current_owner IS DISTINCT FROM true THEN RAISE EXCEPTION 'Current owner required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT true FROM %I.principals WHERE principal_id=$1 AND user_ref=$2 AND kind=''person'' AND status=''active'' FOR SHARE',TG_TABLE_SCHEMA) INTO current_owner USING NEW.owner_principal_id,NEW.owner_user_id;
  IF current_owner IS DISTINCT FROM true THEN RAISE EXCEPTION 'Current person principal required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT true FROM %I.resource_scopes WHERE scope_id=$1 AND owner_principal_id=$2 AND kind=''personal'' AND status=''active'' FOR SHARE',TG_TABLE_SCHEMA) INTO current_owner USING NEW.scope_id,NEW.owner_principal_id;
  IF current_owner IS DISTINCT FROM true THEN RAISE EXCEPTION 'Current personal scope required' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='execution_attempts' THEN
    -- Resolve immutable grant identity before locking all backing rows in order.
    EXECUTE format('SELECT * FROM %I.execution_grants WHERE grant_id=$1',TG_TABLE_SCHEMA) INTO grant_row USING NEW.grant_id;
    IF grant_row.grant_id IS NULL THEN RAISE EXCEPTION 'Actual consent record required' USING ERRCODE='23514'; END IF;
    PERFORM check_execution_prerequisite_binding(TG_TABLE_SCHEMA,to_jsonb(grant_row),true);
    EXECUTE format('SELECT * FROM %I.execution_grants WHERE grant_id=$1 FOR SHARE',TG_TABLE_SCHEMA) INTO grant_row USING NEW.grant_id;
    IF grant_row.state<>'active' OR grant_row.aggregate_version<>1 OR NEW.grant_snapshot IS DISTINCT FROM execution_prerequisite_grant_snapshot(to_jsonb(grant_row))
      OR NEW.created_at<grant_row.created_at OR NEW.created_at>clock_timestamp() OR grant_row.expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'Attempt requires original current consent snapshot' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT count(*) FROM %I.execution_attempts WHERE run_id=$1',TG_TABLE_SCHEMA) INTO total USING NEW.run_id;
    IF NEW.attempt_number<>total+1 THEN RAISE EXCEPTION 'Attempt sequence must be contiguous' USING ERRCODE='23514'; END IF;
  ELSE
    -- Shared quota lock is independent of environment and follows member locks.
    PERFORM pg_advisory_xact_lock(hashtextextended('freedom.execution-prerequisites.owner/v1:'||NEW.owner_principal_id::text,0));
    PERFORM check_execution_prerequisite_binding(TG_TABLE_SCHEMA,to_jsonb(NEW),TG_TABLE_NAME='execution_grants');
    IF NEW.aggregate_version<>1 OR NEW.revoked_at IS NOT NULL OR NEW.created_at>clock_timestamp()
      OR (TG_TABLE_NAME='model_connections' AND NEW.state<>'unverified') OR (TG_TABLE_NAME='execution_grants' AND NEW.state<>'active') THEN
      RAISE EXCEPTION 'Prerequisite initial state is closed' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE owner_principal_id=$1',TG_TABLE_SCHEMA,TG_TABLE_NAME) INTO total USING NEW.owner_principal_id;
    IF total>=(CASE WHEN TG_TABLE_NAME='model_connections' THEN 32 ELSE 256 END) THEN
      RAISE EXCEPTION 'Retained prerequisite capacity exhausted' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_model_connection BEFORE INSERT OR UPDATE OR DELETE ON model_connections FOR EACH ROW EXECUTE FUNCTION preserve_execution_prerequisite();
CREATE TRIGGER preserve_execution_grant BEFORE INSERT OR UPDATE OR DELETE ON execution_grants FOR EACH ROW EXECUTE FUNCTION preserve_execution_prerequisite();
CREATE TRIGGER preserve_execution_attempt BEFORE INSERT OR UPDATE OR DELETE ON execution_attempts FOR EACH ROW EXECUTE FUNCTION preserve_execution_prerequisite();

-- Recheck after index/constraint waits, including final deferred commit checks.
CREATE FUNCTION check_execution_prerequisite_insert_clock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding jsonb; grant_row record;
BEGIN
  IF TG_TABLE_NAME='execution_attempts' THEN
    EXECUTE format('SELECT * FROM %I.execution_grants WHERE grant_id=$1',TG_TABLE_SCHEMA) INTO grant_row USING NEW.grant_id;
    IF grant_row.state<>'active' OR grant_row.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Consent expired before attempt completed' USING ERRCODE='23514'; END IF;
    binding:=to_jsonb(grant_row);
  ELSE binding:=to_jsonb(NEW); END IF;
  PERFORM check_execution_prerequisite_binding(TG_TABLE_SCHEMA,binding,TG_TABLE_NAME<>'model_connections');
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_model_connection_insert_clock AFTER INSERT ON model_connections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_execution_prerequisite_insert_clock();
CREATE CONSTRAINT TRIGGER check_execution_grant_insert_clock AFTER INSERT ON execution_grants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_execution_prerequisite_insert_clock();
CREATE CONSTRAINT TRIGGER check_execution_attempt_insert_clock AFTER INSERT ON execution_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_execution_prerequisite_insert_clock();
