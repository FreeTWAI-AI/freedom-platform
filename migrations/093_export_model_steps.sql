-- Explicit inference export approval and one-use text dispatch. No policy is
-- seeded. Historical 076--092 bytes and blocked Attempt rows remain intact.
CREATE TABLE model_inference_export_policy (
  policy_id uuid PRIMARY KEY,
  scope_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL,
  scope_kind text GENERATED ALWAYS AS ('personal'::text) STORED,
  purpose text NOT NULL DEFAULT 'model.private-draft' CHECK(purpose='model.private-draft'),
  environment text NOT NULL CHECK(environment IN ('local','staging-next','next')),
  client_id text NOT NULL CHECK(client_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  selection jsonb NOT NULL CHECK(jsonb_typeof(selection)='object'),
  revision bigint NOT NULL CHECK(revision>0),
  export_allowed boolean NOT NULL DEFAULT false,
  max_prompt_bytes integer NOT NULL CHECK(max_prompt_bytes BETWEEN 1 AND 16384),
  max_output_tokens integer NOT NULL CHECK(max_output_tokens BETWEEN 1 AND 4096),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(scope_id,scope_kind,owner_principal_id) REFERENCES resource_scopes(scope_id,kind,owner_principal_id),
  UNIQUE(scope_id,owner_principal_id,purpose,environment,client_id,selection),
  UNIQUE(policy_id,scope_id,owner_principal_id)
);
CREATE FUNCTION preserve_model_export_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Export policy is retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision IS DISTINCT FROM 1::bigint THEN RAISE EXCEPTION 'Export policy starts at one' USING ERRCODE='23514'; END IF;
    NEW.created_at:=clock_timestamp(); NEW.updated_at:=NEW.created_at; RETURN NEW;
  END IF;
  IF ROW(NEW.policy_id,NEW.scope_id,NEW.owner_principal_id,NEW.purpose,NEW.environment,NEW.client_id,NEW.selection,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.policy_id,OLD.scope_id,OLD.owner_principal_id,OLD.purpose,OLD.environment,OLD.client_id,OLD.selection,OLD.created_at) THEN
    RAISE EXCEPTION 'Export policy identity is immutable' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.revision,NEW.export_allowed,NEW.max_prompt_bytes,NEW.max_output_tokens,NEW.updated_at)
    IS NOT DISTINCT FROM ROW(OLD.revision,OLD.export_allowed,OLD.max_prompt_bytes,OLD.max_output_tokens,OLD.updated_at) THEN RETURN NEW; END IF;
  IF OLD.revision=9223372036854775807 OR NEW.revision::numeric<>OLD.revision::numeric+1 THEN
    RAISE EXCEPTION 'Export policy changes advance revision' USING ERRCODE='23514'; END IF;
  NEW.updated_at:=clock_timestamp(); RETURN NEW;
END; $$;
CREATE TRIGGER preserve_model_export_policy BEFORE INSERT OR UPDATE OR DELETE ON model_inference_export_policy FOR EACH ROW EXECUTE FUNCTION preserve_model_export_policy();

-- Canonical context derives only the approved current Work fields. No Asset,
-- caller prompt, hidden instruction, arbitrary path or provider URL is admitted.
CREATE FUNCTION model_step_context_bytes(work jsonb) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
 SELECT convert_to('{"schema":"model-step.context/v1","title":'||to_json(work->>'title')::text||',"objective":'||to_json(work->>'objective')::text||'}','UTF8');
$$;
CREATE TABLE model_export_approvals (
  approval_id uuid PRIMARY KEY,
  grant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  work_item_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  environment text NOT NULL,
  client_id text NOT NULL,
  selection jsonb NOT NULL,
  input_work_version bigint NOT NULL CHECK(input_work_version>0),
  grant_version bigint NOT NULL CHECK(grant_version>0),
  base_run_version bigint NOT NULL CHECK(base_run_version>0),
  policy_id uuid NOT NULL,
  export_policy_revision bigint NOT NULL CHECK(export_policy_revision>0),
  persistence_policy_revision text NOT NULL,
  context_sha256 text NOT NULL CHECK(context_sha256 ~ '^[0-9a-f]{64}$'),
  input_byte_size integer NOT NULL CHECK(input_byte_size BETWEEN 1 AND 16384),
  max_output_tokens integer NOT NULL CHECK(max_output_tokens BETWEEN 1 AND 4096),
  consent boolean NOT NULL CHECK(consent),
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0),
  creation_key text NOT NULL CHECK(creation_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK(isfinite(issued_at) AND issued_at=date_trunc('milliseconds',issued_at)),
  CHECK(isfinite(expires_at) AND expires_at=date_trunc('milliseconds',expires_at) AND expires_at>issued_at AND expires_at<=issued_at+interval '1 hour'),
  CHECK((state='active' AND revoked_at IS NULL) OR (state='revoked' AND revoked_at IS NOT NULL AND isfinite(revoked_at) AND revoked_at>=issued_at AND revoked_at=date_trunc('milliseconds',revoked_at))),
  FOREIGN KEY(grant_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id) REFERENCES execution_grants(grant_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id),
  FOREIGN KEY(policy_id,scope_id,owner_principal_id) REFERENCES model_inference_export_policy(policy_id,scope_id,owner_principal_id),
  UNIQUE(owner_principal_id,scope_id,environment,client_id,creation_key),
  UNIQUE(approval_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id)
);
ALTER TABLE execution_attempts ADD COLUMN activation_binding jsonb;
ALTER TABLE execution_attempts DROP CONSTRAINT execution_attempts_state_check;
ALTER TABLE execution_attempts DROP CONSTRAINT execution_attempts_blockers_check;
ALTER TABLE execution_attempts ADD CONSTRAINT execution_attempt_profile CHECK(
  (state='preflight_blocked' AND activation_binding IS NULL AND blockers='["model_authentication_unavailable","model_adapter_unavailable"]'::jsonb)
  OR (state='active' AND blockers='[]'::jsonb AND activation_binding IS NOT NULL AND jsonb_typeof(activation_binding)='object'));
ALTER TABLE execution_attempts ADD CHECK(activation_binding IS NULL OR octet_length(activation_binding::text)<=8192);
ALTER TABLE execution_attempts ADD UNIQUE(attempt_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id);
ALTER TABLE execution_runs ADD COLUMN current_attempt_id uuid;
ALTER TABLE execution_runs DROP CONSTRAINT execution_runs_state_check;
ALTER TABLE execution_runs ADD CONSTRAINT execution_runs_state_check CHECK(state IN ('created','running','paused','cancelled','reconciling','succeeded'));
ALTER TABLE execution_runs ADD CONSTRAINT execution_run_current_attempt FOREIGN KEY(current_attempt_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id)
  REFERENCES execution_attempts(attempt_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE model_text_steps (
  step_id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL UNIQUE,
  intent_id uuid NOT NULL UNIQUE,
  approval_id uuid NOT NULL,
  run_id uuid NOT NULL,
  work_item_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  environment text NOT NULL,
  client_id text NOT NULL,
  binding jsonb NOT NULL CHECK(jsonb_typeof(binding)='object' AND octet_length(binding::text)<=8192),
  verified_binding jsonb NOT NULL CHECK(jsonb_typeof(verified_binding)='object' AND octet_length(verified_binding::text)<=8192),
  evidence_origin text NOT NULL CHECK(evidence_origin IN ('synthetic_local_fixture','provider_https')),
  activated_run_version bigint NOT NULL CHECK(activated_run_version>1),
  task_lease_epoch bigint NOT NULL CHECK(task_lease_epoch>1),
  control_epoch bigint NOT NULL CHECK(control_epoch>0),
  context_sha256 text NOT NULL CHECK(context_sha256 ~ '^[0-9a-f]{64}$'),
  input_byte_size integer NOT NULL CHECK(input_byte_size BETWEEN 1 AND 16384),
  max_output_tokens integer NOT NULL CHECK(max_output_tokens BETWEEN 1 AND 4096),
  state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','dispatched','awaiting_result','outcome_unknown','cancelled','succeeded')),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0),
  usage_status text NOT NULL DEFAULT 'not_dispatched' CHECK(usage_status IN ('not_dispatched','unknown','known')),
  reservation_held boolean NOT NULL DEFAULT true,
  creation_key text NOT NULL CHECK(creation_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  created_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  permit_expires_at timestamptz,
  dispatched_at timestamptz,
  observation jsonb,
  observed_at timestamptz,
  CHECK(isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
  CHECK(isfinite(lease_expires_at) AND lease_expires_at=date_trunc('milliseconds',lease_expires_at) AND lease_expires_at>created_at AND lease_expires_at<=created_at+interval '90 seconds'),
  CHECK(permit_expires_at IS NULL OR (isfinite(permit_expires_at) AND permit_expires_at=date_trunc('milliseconds',permit_expires_at) AND dispatched_at IS NOT NULL AND permit_expires_at>dispatched_at AND permit_expires_at<=dispatched_at+interval '5 seconds')),
  CHECK(dispatched_at IS NULL OR (isfinite(dispatched_at) AND dispatched_at=date_trunc('milliseconds',dispatched_at) AND dispatched_at>=created_at)),
  CHECK(observed_at IS NULL OR (isfinite(observed_at) AND observed_at=date_trunc('milliseconds',observed_at) AND observed_at>=dispatched_at)),
  CHECK(observation IS NULL OR COALESCE(jsonb_typeof(observation)='object' AND octet_length(observation::text)<=4096
    AND observation ?& ARRAY['bindingId','evidenceDigest','recoveryGeneration','expiresAt','evidenceOrigin','adapterProfile','outputSha256','outputByteSize','reportedModelRef','usage']
    AND observation-ARRAY['bindingId','evidenceDigest','recoveryGeneration','expiresAt','evidenceOrigin','adapterProfile','outputSha256','outputByteSize','reportedModelRef','usage']='{}'::jsonb
    AND jsonb_typeof(observation->'usage')='object' AND observation->'usage' ?& ARRAY['inputTokens','outputTokens','totalTokens']
    AND (observation->'usage')-ARRAY['inputTokens','outputTokens','totalTokens']='{}'::jsonb,false)),
  CHECK((state='reserved' AND dispatched_at IS NULL AND permit_expires_at IS NULL AND observation IS NULL AND observed_at IS NULL AND usage_status='not_dispatched' AND reservation_held)
    OR (state='cancelled' AND dispatched_at IS NULL AND permit_expires_at IS NULL AND observation IS NULL AND observed_at IS NULL AND usage_status='not_dispatched' AND NOT reservation_held)
    OR (state IN ('dispatched','outcome_unknown') AND dispatched_at IS NOT NULL AND permit_expires_at IS NOT NULL AND observation IS NULL AND observed_at IS NULL AND usage_status='unknown' AND reservation_held)
    OR (state='awaiting_result' AND dispatched_at IS NOT NULL AND permit_expires_at IS NOT NULL AND observation IS NOT NULL AND observed_at IS NOT NULL AND usage_status='known' AND reservation_held)
    OR (state='succeeded' AND dispatched_at IS NOT NULL AND permit_expires_at IS NOT NULL AND observation IS NOT NULL AND observed_at IS NOT NULL AND usage_status='known' AND NOT reservation_held)),
  FOREIGN KEY(attempt_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id) REFERENCES execution_attempts(attempt_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id),
  FOREIGN KEY(approval_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id) REFERENCES model_export_approvals(approval_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id),
  UNIQUE(owner_principal_id,scope_id,environment,client_id,creation_key),
  UNIQUE(step_id,attempt_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id)
);
CREATE UNIQUE INDEX model_text_step_unresolved_run ON model_text_steps(run_id) WHERE state IN ('reserved','dispatched','outcome_unknown');
CREATE UNIQUE INDEX model_text_step_single_run ON model_text_steps(run_id);

CREATE FUNCTION check_model_export_approval(target_schema text,binding jsonb,operational boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE g record; w record; r record; m record; p record; a record; actual bytea; current_owner boolean;
BEGIN
  EXECUTE format('SELECT * FROM %I.execution_grants WHERE grant_id=$1',target_schema) INTO g USING (binding->>'grant_id')::uuid;
  IF g.grant_id IS NULL THEN RAISE EXCEPTION 'Actual model consent required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT true FROM %I.users WHERE user_id=$1 AND active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL) FOR SHARE',target_schema) INTO current_owner USING g.owner_user_id;
  IF current_owner IS DISTINCT FROM true THEN RAISE EXCEPTION 'Current export owner required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT true FROM %I.principals WHERE principal_id=$1 AND user_ref=$2 AND kind=''person'' AND status=''active'' FOR SHARE',target_schema) INTO current_owner USING g.owner_principal_id,g.owner_user_id;
  IF current_owner IS DISTINCT FROM true THEN RAISE EXCEPTION 'Current export principal required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT true FROM %I.resource_scopes WHERE scope_id=$1 AND owner_principal_id=$2 AND kind=''personal'' AND status=''active'' FOR SHARE',target_schema) INTO current_owner USING g.scope_id,g.owner_principal_id;
  IF current_owner IS DISTINCT FROM true THEN RAISE EXCEPTION 'Current export scope required' USING ERRCODE='23514'; END IF;
  -- The original binding guard is valid only before activation. Operational
  -- service checks use the activated Run and preserve the original Grant.
  IF NOT operational THEN PERFORM check_execution_prerequisite_binding(target_schema,to_jsonb(g),true); END IF;
  EXECUTE format('SELECT * FROM %I.work_items WHERE work_item_id=$1 FOR SHARE',target_schema) INTO w USING g.work_item_id;
  EXECUTE format('SELECT * FROM %I.execution_runs WHERE run_id=$1 FOR SHARE',target_schema) INTO r USING g.run_id;
  EXECUTE format('SELECT * FROM %I.model_connections WHERE model_connection_id=$1 FOR SHARE',target_schema) INTO m USING g.model_connection_id;
  EXECUTE format('SELECT * FROM %I.execution_grants WHERE grant_id=$1 FOR SHARE',target_schema) INTO g USING g.grant_id;
  actual:=model_step_context_bytes(to_jsonb(w));
  EXECUTE format('SELECT * FROM %I.private_work_persistence_policy WHERE scope_id=$1 AND owner_principal_id=$2 AND purpose=''work.private-draft'' FOR SHARE',target_schema) INTO a USING g.scope_id,g.owner_principal_id;
  EXECUTE format('SELECT * FROM %I.model_inference_export_policy WHERE policy_id=$1 FOR SHARE',target_schema) INTO p USING (binding->>'policy_id')::uuid;
  IF w.work_item_id IS NULL OR r.run_id IS NULL OR m.model_connection_id IS NULL OR p.policy_id IS NULL OR a.scope_id IS NULL
    OR g.state IS DISTINCT FROM 'active' OR g.aggregate_version IS DISTINCT FROM (binding->>'grant_version')::bigint OR g.expires_at<=clock_timestamp()
    OR w.state IS DISTINCT FROM 'draft' OR w.aggregate_version IS DISTINCT FROM (binding->>'input_work_version')::bigint
    OR m.state IS DISTINCT FROM 'unverified' OR m.aggregate_version IS DISTINCT FROM g.model_version OR m.selection IS DISTINCT FROM binding->'selection'
    OR ROW(g.run_id,g.work_item_id,g.owner_user_id,g.owner_principal_id,g.scope_id,g.environment,g.client_id)
      IS DISTINCT FROM ROW((binding->>'run_id')::uuid,(binding->>'work_item_id')::uuid,(binding->>'owner_user_id')::uuid,(binding->>'owner_principal_id')::uuid,(binding->>'scope_id')::uuid,binding->>'environment',binding->>'client_id')
    OR p.scope_id IS DISTINCT FROM g.scope_id OR p.owner_principal_id IS DISTINCT FROM g.owner_principal_id OR p.environment IS DISTINCT FROM g.environment OR p.client_id IS DISTINCT FROM g.client_id
    OR p.selection IS DISTINCT FROM g.selection OR p.export_allowed IS DISTINCT FROM true OR p.revision IS DISTINCT FROM (binding->>'export_policy_revision')::bigint
    OR a.persistence_allowed IS DISTINCT FROM true OR a.retained_byte_limit IS NULL OR a.retained_byte_limit<262144
    OR 'private-work.v'||a.revision::text IS DISTINCT FROM binding->>'persistence_policy_revision'
    OR actual IS NULL OR octet_length(actual) IS DISTINCT FROM (binding->>'input_byte_size')::integer OR octet_length(actual)>p.max_prompt_bytes
    OR encode(sha256(actual),'hex') IS DISTINCT FROM binding->>'context_sha256' OR (binding->>'max_output_tokens')::integer>p.max_output_tokens
    OR (binding->>'issued_at')::timestamptz<g.created_at OR (binding->>'issued_at')::timestamptz<p.created_at
    OR (binding->>'expires_at')::timestamptz>g.expires_at OR (binding->>'expires_at')::timestamptz<=clock_timestamp() THEN
    RAISE EXCEPTION 'Current exact export approval required' USING ERRCODE='23514'; END IF;
END; $$;

CREATE FUNCTION check_model_text_step_current(target_schema text,s jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE g record; runtime record; connection record; family record; r record; attempt record; approval record; expected jsonb;
BEGIN
  EXECUTE format('SELECT * FROM %I.execution_grants WHERE grant_id=$1',target_schema) INTO g USING (s->'binding'->>'grantId')::uuid;
  IF g.grant_id IS NULL THEN RAISE EXCEPTION 'Actual step Grant required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT * FROM %I.runtime_registrations WHERE runtime_device_id=$1 FOR SHARE',target_schema) INTO runtime USING g.runtime_device_id;
  EXECUTE format('SELECT * FROM %I.agent_connections WHERE connection_id=$1 FOR SHARE',target_schema) INTO connection USING g.connection_id;
  EXECUTE format('SELECT * FROM %I.bootstrap_refresh_families WHERE family_id=$1 FOR SHARE',target_schema) INTO family USING g.family_id;
  EXECUTE format('SELECT * FROM %I.work_items WHERE work_item_id=$1 FOR SHARE',target_schema) INTO approval USING g.work_item_id;
  EXECUTE format('SELECT * FROM %I.execution_runs WHERE run_id=$1 FOR SHARE',target_schema) INTO r USING g.run_id;
  EXECUTE format('SELECT * FROM %I.model_export_approvals WHERE approval_id=$1 FOR SHARE',target_schema) INTO approval USING (s->>'approval_id')::uuid;
  EXECUTE format('SELECT * FROM %I.execution_attempts WHERE attempt_id=$1 FOR SHARE',target_schema) INTO attempt USING (s->>'attempt_id')::uuid;
  expected:=jsonb_build_object('profile','model-step.binding/v1','stepId',s->>'step_id','attemptId',s->>'attempt_id','intentId',s->>'intent_id',
    'approvalId',approval.approval_id::text,'approvalVersion',approval.aggregate_version::text,'runId',g.run_id::text,'workId',g.work_item_id::text,
    'inputWorkVersion',g.input_work_version::text,'baseRunVersion',g.run_version::text,'runVersion',(g.run_version+1)::text,
    'baseTaskLeaseEpoch',g.task_lease_epoch::text,'taskLeaseEpoch',(g.task_lease_epoch+1)::text,'controlEpoch',g.control_epoch::text,
    'ownerUserId',g.owner_user_id::text,'ownerPrincipalId',g.owner_principal_id::text,'scopeId',g.scope_id::text,'environment',g.environment,'clientId',g.client_id,
    'runtimeDeviceId',g.runtime_device_id::text,'runtimeVersion',g.runtime_version::text,'connectionId',g.connection_id::text,'connectionVersion',g.connection_version::text,
    'familyId',g.family_id::text,'modelConnectionId',g.model_connection_id::text,'modelVersion',g.model_version::text,'selection',g.selection,
    'grantId',g.grant_id::text,'grantVersion',g.aggregate_version::text,'persistencePolicyRevision',approval.persistence_policy_revision,
    'exportPolicyId',approval.policy_id::text,'exportPolicyRevision',approval.export_policy_revision::text,'contextSha256',approval.context_sha256,
    'inputByteSize',approval.input_byte_size,'maxOutputTokens',approval.max_output_tokens);
  IF runtime.runtime_device_id IS NULL OR connection.connection_id IS NULL OR family.family_id IS NULL OR approval.approval_id IS NULL OR attempt.attempt_id IS NULL
    OR runtime.state IS DISTINCT FROM 'enrolled' OR runtime.aggregate_version IS DISTINCT FROM g.runtime_version
    OR connection.state IS DISTINCT FROM 'active' OR connection.aggregate_version IS DISTINCT FROM g.connection_version OR connection.expires_at<=clock_timestamp()
    OR family.state IS DISTINCT FROM 'active' OR family.expires_at<=clock_timestamp()
    OR g.selection->>'artifactCustody' IS DISTINCT FROM 'platform_asset'
    OR s->'binding' IS DISTINCT FROM expected OR attempt.grant_id IS DISTINCT FROM g.grant_id OR approval.grant_id IS DISTINCT FROM g.grant_id
    OR approval.state IS DISTINCT FROM 'active' OR approval.aggregate_version IS DISTINCT FROM (s->'binding'->>'approvalVersion')::bigint
    OR attempt.state IS DISTINCT FROM 'active' OR attempt.activation_binding IS DISTINCT FROM s->'binding'
    OR r.state IS DISTINCT FROM 'running' OR r.current_attempt_id IS DISTINCT FROM attempt.attempt_id
    OR r.aggregate_version IS DISTINCT FROM (s->>'activated_run_version')::bigint
    OR r.task_lease_epoch IS DISTINCT FROM (s->>'task_lease_epoch')::bigint OR r.control_epoch IS DISTINCT FROM (s->>'control_epoch')::bigint
    OR (s->>'created_at')::timestamptz>clock_timestamp() OR (s->>'lease_expires_at')::timestamptz<=clock_timestamp()
    OR (s->>'lease_expires_at')::timestamptz>approval.expires_at
    OR (s->>'created_at')::timestamptz<approval.issued_at
    OR s->'verified_binding'->'binding' IS DISTINCT FROM s->'binding'
    OR s->'verified_binding'->>'evidenceOrigin' IS DISTINCT FROM s->>'evidence_origin'
    OR (s->'verified_binding'->>'expiresAt')::timestamptz IS NULL OR (s->'verified_binding'->>'expiresAt')::timestamptz<=clock_timestamp()
    OR (s->>'lease_expires_at')::timestamptz>(s->'verified_binding'->>'expiresAt')::timestamptz THEN
    RAISE EXCEPTION 'Current genuine step binding required' USING ERRCODE='23514'; END IF;
  PERFORM check_model_export_approval(target_schema,to_jsonb(approval),true);
END; $$;
CREATE FUNCTION preserve_model_text_step() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Dispatch history retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'reserved' OR NEW.aggregate_version<>1 OR NEW.created_at>clock_timestamp()
      OR NEW.verified_binding->'binding' IS DISTINCT FROM NEW.binding
      OR NEW.binding->>'stepId' IS DISTINCT FROM NEW.step_id::text OR NEW.binding->>'attemptId' IS DISTINCT FROM NEW.attempt_id::text
      OR NEW.binding->>'intentId' IS DISTINCT FROM NEW.intent_id::text OR NEW.binding->>'approvalId' IS DISTINCT FROM NEW.approval_id::text
      OR NEW.binding->>'runId' IS DISTINCT FROM NEW.run_id::text OR NEW.binding->>'workId' IS DISTINCT FROM NEW.work_item_id::text
      OR NEW.binding->>'ownerUserId' IS DISTINCT FROM NEW.owner_user_id::text OR NEW.binding->>'ownerPrincipalId' IS DISTINCT FROM NEW.owner_principal_id::text
      OR NEW.binding->>'scopeId' IS DISTINCT FROM NEW.scope_id::text OR NEW.binding->>'environment' IS DISTINCT FROM NEW.environment
      OR NEW.binding->>'clientId' IS DISTINCT FROM NEW.client_id OR NEW.binding->>'contextSha256' IS DISTINCT FROM NEW.context_sha256
      OR (NEW.binding->>'inputByteSize')::integer IS DISTINCT FROM NEW.input_byte_size OR (NEW.binding->>'maxOutputTokens')::integer IS DISTINCT FROM NEW.max_output_tokens
      OR (NEW.binding->>'runVersion')::bigint IS DISTINCT FROM NEW.activated_run_version OR (NEW.binding->>'taskLeaseEpoch')::bigint IS DISTINCT FROM NEW.task_lease_epoch
      OR (NEW.binding->>'controlEpoch')::bigint IS DISTINCT FROM NEW.control_epoch THEN
      RAISE EXCEPTION 'Exact immutable step profile required' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['state','aggregate_version','usage_status','reservation_held','permit_expires_at','dispatched_at','observation','observed_at','verified_binding','result_id'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','aggregate_version','usage_status','reservation_held','permit_expires_at','dispatched_at','observation','observed_at','verified_binding','result_id'])
    OR NEW.aggregate_version::numeric<>OLD.aggregate_version::numeric+1 THEN RAISE EXCEPTION 'Dispatch identity immutable and updates CAS' USING ERRCODE='23514'; END IF;
  IF OLD.state='reserved' AND NEW.state='dispatched' THEN
    PERFORM check_model_text_step_current(TG_TABLE_SCHEMA,to_jsonb(NEW));
    IF NEW.dispatched_at IS NULL OR NEW.permit_expires_at IS NULL OR NEW.dispatched_at>clock_timestamp() OR NEW.permit_expires_at>NEW.lease_expires_at OR NEW.permit_expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'Current one-use dispatch required' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.verified_binding IS DISTINCT FROM OLD.verified_binding OR NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at OR NEW.permit_expires_at IS DISTINCT FROM OLD.permit_expires_at THEN
    RAISE EXCEPTION 'Consumed dispatch cannot be rebound' USING ERRCODE='23514'; END IF;
  IF OLD.state='reserved' AND NEW.state='cancelled' THEN RETURN NEW; END IF;
  IF OLD.state='dispatched' AND NEW.state='outcome_unknown' THEN RETURN NEW; END IF;
  IF OLD.state IN ('awaiting_result','outcome_unknown') AND NEW.state=OLD.state
    AND (to_jsonb(NEW)-'aggregate_version') IS NOT DISTINCT FROM (to_jsonb(OLD)-'aggregate_version') THEN RETURN NEW; END IF;
  IF OLD.state='dispatched' AND NEW.state='awaiting_result' THEN
    PERFORM check_model_text_step_current(TG_TABLE_SCHEMA,to_jsonb(NEW));
    IF NEW.observation IS NULL OR jsonb_typeof(NEW.observation) IS DISTINCT FROM 'object'
      OR NEW.observation ?| ARRAY['text','prompt','secret','credential','stderr']
      OR NEW.observation->>'reportedModelRef' IS DISTINCT FROM NEW.binding->'selection'->>'modelRef'
      OR NEW.observation->>'bindingId' IS DISTINCT FROM NEW.verified_binding->>'bindingId'
      OR NEW.observation->>'evidenceOrigin' IS DISTINCT FROM NEW.evidence_origin
      OR NEW.observation->>'recoveryGeneration' IS DISTINCT FROM NEW.verified_binding->>'recoveryGeneration'
      OR NEW.observation->>'outputSha256' IS NULL OR NEW.observation->>'outputSha256' !~ '^[0-9a-f]{64}$'
      OR (NEW.observation->>'outputByteSize')::integer IS NULL OR (NEW.observation->>'outputByteSize')::integer NOT BETWEEN 1 AND 16384
      OR (NEW.observation->'usage'->>'outputTokens')::integer IS NULL OR (NEW.observation->'usage'->>'outputTokens')::integer NOT BETWEEN 1 AND NEW.max_output_tokens THEN
      RAISE EXCEPTION 'Exact bounded private observation required' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.state='awaiting_result' AND NEW.state='succeeded' AND NEW.observation IS NOT DISTINCT FROM OLD.observation AND NEW.observed_at IS NOT DISTINCT FROM OLD.observed_at THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Dispatch cannot retry or revive' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER preserve_model_text_step BEFORE INSERT OR UPDATE OR DELETE ON model_text_steps FOR EACH ROW EXECUTE FUNCTION preserve_model_text_step();
CREATE FUNCTION check_model_text_insert_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM check_model_text_step_current(TG_TABLE_SCHEMA,to_jsonb(NEW)); RETURN NULL; END; $$;
CREATE CONSTRAINT TRIGGER check_model_text_insert_clock AFTER INSERT ON model_text_steps DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_model_text_insert_clock();
CREATE FUNCTION check_model_text_update_clock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_row record;
BEGIN
  -- Inspect final state, rather than an intermediate trigger NEW snapshot.
  -- Result completion uses the separate094 guard after its sole Work CAS.
  IF NOT ((OLD.state='reserved' AND NEW.state='dispatched') OR (OLD.state='dispatched' AND NEW.state='awaiting_result')) THEN RETURN NULL; END IF;
  EXECUTE format('SELECT * FROM %I.model_text_steps WHERE step_id=$1',TG_TABLE_SCHEMA) INTO current_row USING NEW.step_id;
  IF current_row.state IN ('dispatched','awaiting_result') THEN
    PERFORM check_model_text_step_current(TG_TABLE_SCHEMA,to_jsonb(current_row));
    IF current_row.state='dispatched' AND (current_row.permit_expires_at IS NULL OR current_row.permit_expires_at<=clock_timestamp()) THEN
      RAISE EXCEPTION 'Dispatch expired before actual commit decision' USING ERRCODE='23514'; END IF;
    IF current_row.state='awaiting_result' AND ((current_row.observation->>'expiresAt')::timestamptz IS NULL OR (current_row.observation->>'expiresAt')::timestamptz<=clock_timestamp()) THEN
      RAISE EXCEPTION 'Observation expired before actual commit decision' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER check_model_text_update_clock AFTER UPDATE ON model_text_steps DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_model_text_update_clock();

-- The original blocked Attempt still uses the original guard. An active
-- Attempt instead requires its real activated step and Run in this transaction.
CREATE FUNCTION check_execution_attempt_v2_clock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g record; s record;
BEGIN
  IF NEW.state='preflight_blocked' THEN
    EXECUTE format('SELECT * FROM %I.execution_grants WHERE grant_id=$1',TG_TABLE_SCHEMA) INTO g USING NEW.grant_id;
    PERFORM check_execution_prerequisite_binding(TG_TABLE_SCHEMA,to_jsonb(g),true);
  ELSE
    EXECUTE format('SELECT * FROM %I.model_text_steps WHERE attempt_id=$1',TG_TABLE_SCHEMA) INTO s USING NEW.attempt_id;
    IF s.step_id IS NULL OR NEW.activation_binding IS DISTINCT FROM s.binding THEN RAISE EXCEPTION 'Actual activated text step required' USING ERRCODE='23514'; END IF;
    PERFORM check_model_text_step_current(TG_TABLE_SCHEMA,to_jsonb(s));
  END IF;
  RETURN NULL;
END; $$;
DROP TRIGGER check_execution_attempt_insert_clock ON execution_attempts;
CREATE CONSTRAINT TRIGGER check_execution_attempt_insert_clock AFTER INSERT ON execution_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_execution_attempt_v2_clock();
CREATE FUNCTION preserve_model_export_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total bigint; current_owner boolean;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Export approval history retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['state','aggregate_version','revoked_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','aggregate_version','revoked_at'])
      OR OLD.state<>'active' OR NEW.state<>'revoked' OR NEW.aggregate_version::numeric<>OLD.aggregate_version::numeric+1 OR NEW.revoked_at IS NULL OR NEW.revoked_at>clock_timestamp() THEN
      RAISE EXCEPTION 'Export revocation is terminal CAS' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  -- Member locks precede the shared owner quota advisory, including raw DML.
  EXECUTE format('SELECT true FROM %I.users WHERE user_id=$1 AND active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL) FOR SHARE',TG_TABLE_SCHEMA) INTO current_owner USING NEW.owner_user_id;
  IF current_owner IS DISTINCT FROM true THEN RAISE EXCEPTION 'Current export owner required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT true FROM %I.principals WHERE principal_id=$1 AND user_ref=$2 AND kind=''person'' AND status=''active'' FOR SHARE',TG_TABLE_SCHEMA) INTO current_owner USING NEW.owner_principal_id,NEW.owner_user_id;
  IF current_owner IS DISTINCT FROM true THEN RAISE EXCEPTION 'Current export principal required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT true FROM %I.resource_scopes WHERE scope_id=$1 AND owner_principal_id=$2 AND kind=''personal'' AND status=''active'' FOR SHARE',TG_TABLE_SCHEMA) INTO current_owner USING NEW.scope_id,NEW.owner_principal_id;
  IF current_owner IS DISTINCT FROM true THEN RAISE EXCEPTION 'Current export scope required' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('freedom.execution-prerequisites.owner/v1:'||NEW.owner_principal_id::text,0));
  PERFORM check_model_export_approval(TG_TABLE_SCHEMA,to_jsonb(NEW),false);
  EXECUTE format('SELECT count(*) FROM %I.model_export_approvals WHERE owner_principal_id=$1',TG_TABLE_SCHEMA) INTO total USING NEW.owner_principal_id;
  IF total>=256 OR NEW.state<>'active' OR NEW.aggregate_version<>1 OR NEW.revoked_at IS NOT NULL OR NEW.issued_at>clock_timestamp() THEN
    RAISE EXCEPTION 'Bounded current approval required' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER preserve_model_export_approval BEFORE INSERT OR UPDATE OR DELETE ON model_export_approvals FOR EACH ROW EXECUTE FUNCTION preserve_model_export_approval();
CREATE FUNCTION check_model_export_insert_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM check_model_export_approval(TG_TABLE_SCHEMA,to_jsonb(NEW),false); RETURN NULL; END; $$;
CREATE CONSTRAINT TRIGGER check_model_export_insert_clock AFTER INSERT ON model_export_approvals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_model_export_insert_clock();

CREATE OR REPLACE FUNCTION preserve_execution_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target record; policy record; attempt record; step record;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Run history cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'created' OR NEW.aggregate_version<>1 OR NEW.task_lease_epoch<>1 OR NEW.control_epoch<>1 OR NEW.current_attempt_id IS NOT NULL THEN
      RAISE EXCEPTION 'Run must start unexecuted' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT * FROM %I.work_items WHERE work_item_id=$1 FOR SHARE',TG_TABLE_SCHEMA) INTO target USING NEW.work_item_id;
    EXECUTE format('SELECT * FROM %I.private_work_persistence_policy WHERE scope_id=$1 AND owner_principal_id=$2 AND purpose=''work.private-draft'' FOR SHARE',TG_TABLE_SCHEMA) INTO policy USING NEW.scope_id,NEW.owner_principal_id;
    IF target.work_item_id IS NULL OR target.work_mode<>'personal_execution' OR target.state<>'draft' OR target.aggregate_version<>NEW.input_work_version
      OR policy.scope_id IS NULL OR policy.persistence_allowed IS DISTINCT FROM true OR policy.retained_byte_limit IS NULL OR policy.retained_byte_limit<262144
      OR NEW.persistence_policy_revision IS DISTINCT FROM 'private-work.v'||policy.revision::text THEN
      RAISE EXCEPTION 'Current draft and persistence required' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.run_id,NEW.work_item_id,NEW.scope_id,NEW.owner_principal_id,NEW.owner_user_id,NEW.input_work_version,NEW.persistence_policy_revision,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.run_id,OLD.work_item_id,OLD.scope_id,OLD.owner_principal_id,OLD.owner_user_id,OLD.input_work_version,OLD.persistence_policy_revision,OLD.created_at)
    OR NEW.aggregate_version::numeric<>OLD.aggregate_version::numeric+1 THEN
    RAISE EXCEPTION 'Run identity and task fence preserved' USING ERRCODE='23514'; END IF;
  IF NEW.state IN ('paused','cancelled') AND OLD.state NOT IN ('cancelled','succeeded') THEN
    IF NEW.control_epoch::numeric<>OLD.control_epoch::numeric+1 OR NEW.task_lease_epoch::numeric<>OLD.task_lease_epoch::numeric+1 OR NEW.current_attempt_id IS DISTINCT FROM OLD.current_attempt_id THEN
      RAISE EXCEPTION 'Member control advances independent fences' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.state='reconciling' AND OLD.state NOT IN ('cancelled','succeeded')
    AND NEW.control_epoch::numeric=OLD.control_epoch::numeric+1 AND NEW.task_lease_epoch::numeric=OLD.task_lease_epoch::numeric+1
    AND NEW.current_attempt_id IS NOT DISTINCT FROM OLD.current_attempt_id THEN
    EXECUTE format('SELECT * FROM %I.model_text_steps WHERE attempt_id=$1',TG_TABLE_SCHEMA) INTO step USING NEW.current_attempt_id;
    IF step.step_id IS NULL OR step.state<>'outcome_unknown' THEN RAISE EXCEPTION 'Unknown dispatch remains reconciling' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.control_epoch IS DISTINCT FROM OLD.control_epoch THEN RAISE EXCEPTION 'Operational transitions preserve member control fence' USING ERRCODE='23514'; END IF;
  IF OLD.state='created' AND NEW.state='running' AND OLD.current_attempt_id IS NULL AND NEW.current_attempt_id IS NOT NULL THEN
    IF NEW.task_lease_epoch::numeric<>OLD.task_lease_epoch::numeric+1 THEN RAISE EXCEPTION 'Activation advances task fence' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT * FROM %I.execution_attempts WHERE attempt_id=$1',TG_TABLE_SCHEMA) INTO attempt USING NEW.current_attempt_id;
    IF attempt.attempt_id IS NULL OR attempt.state<>'active' OR attempt.run_id IS DISTINCT FROM NEW.run_id
      OR (attempt.activation_binding->>'runVersion')::bigint IS DISTINCT FROM NEW.aggregate_version
      OR (attempt.activation_binding->>'taskLeaseEpoch')::bigint IS DISTINCT FROM NEW.task_lease_epoch
      OR (attempt.activation_binding->>'controlEpoch')::bigint IS DISTINCT FROM NEW.control_epoch THEN
      RAISE EXCEPTION 'Actual active attempt required' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.state='running' AND NEW.state IN ('reconciling','succeeded') AND NEW.current_attempt_id IS NOT DISTINCT FROM OLD.current_attempt_id THEN
    IF (NEW.state='succeeded' AND NEW.task_lease_epoch IS DISTINCT FROM OLD.task_lease_epoch)
      OR (NEW.state='reconciling' AND NEW.task_lease_epoch::numeric<>OLD.task_lease_epoch::numeric+1) THEN RAISE EXCEPTION 'Outcome fence mismatch' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT * FROM %I.model_text_steps WHERE attempt_id=$1',TG_TABLE_SCHEMA) INTO step USING NEW.current_attempt_id;
    IF step.step_id IS NULL OR (NEW.state='reconciling' AND step.state<>'outcome_unknown') OR (NEW.state='succeeded' AND step.state<>'succeeded') THEN
      RAISE EXCEPTION 'Actual step outcome required' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Unsupported Run transition' USING ERRCODE='23514';
END; $$;
