-- Machine BYOK invocation state. No native CLI profile, secret, prompt or
-- provider output is admitted by these metadata-only records. 117/118 retain
-- their exact published bytes and composite fact constraints.
CREATE TABLE execution_machine_model_pins (
  authorization_id uuid PRIMARY KEY REFERENCES execution_machine_authorizations(authorization_id),
  profile text NOT NULL CHECK(profile='freedom.machine-model-pin/v1'),
  evidence_origin text NOT NULL CHECK(evidence_origin IN ('provider_https','synthetic_local_fixture')),
  credential_id uuid REFERENCES broker_model_credentials(credential_id),
  credential_generation bigint,
  CHECK((credential_id IS NOT NULL AND credential_generation>0)
    OR (evidence_origin='synthetic_local_fixture' AND credential_id IS NULL AND credential_generation IS NULL))
);
CREATE FUNCTION check_machine_model_admission(target_schema text,authorization_ref uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a record; s record; g record; m record; approval record; pin record; credential record; r record; ok boolean;
BEGIN
  -- Current device/family/owner is independent of model health. The additional
  -- execution deadline below does not borrow the five-minute evidence window.
  PERFORM check_machine_text_authorization(target_schema,authorization_ref,true);
  EXECUTE format('SELECT * FROM %I.execution_machine_authorizations WHERE authorization_id=$1',target_schema) INTO a USING authorization_ref;
  EXECUTE format('SELECT * FROM %I.model_text_steps WHERE step_id=$1',target_schema) INTO s USING a.step_id;
  EXECUTE format('SELECT * FROM %I.execution_grants WHERE grant_id=$1',target_schema) INTO g USING a.grant_id;
  EXECUTE format('SELECT * FROM %I.model_connections WHERE model_connection_id=$1',target_schema) INTO m USING g.model_connection_id;
  EXECUTE format('SELECT * FROM %I.model_export_approvals WHERE approval_id=$1',target_schema) INTO approval USING a.approval_id;
  EXECUTE format('SELECT * FROM %I.execution_runs WHERE run_id=$1',target_schema) INTO r USING a.run_id;
  EXECUTE format('SELECT * FROM %I.execution_machine_model_pins WHERE authorization_id=$1',target_schema) INTO pin USING authorization_ref;
  IF a.expires_at<=clock_timestamp() OR s.lease_expires_at<=clock_timestamp() OR s.created_at>clock_timestamp()
    OR g.state IS DISTINCT FROM 'active' OR g.aggregate_version IS DISTINCT FROM a.grant_version
    OR g.created_at>clock_timestamp() OR g.expires_at<=clock_timestamp()
    OR approval.state IS DISTINCT FROM 'active' OR approval.aggregate_version IS DISTINCT FROM a.approval_version
    OR approval.issued_at>clock_timestamp() OR approval.expires_at<=clock_timestamp()
    OR m.state IS DISTINCT FROM 'unverified' OR m.aggregate_version IS DISTINCT FROM g.model_version OR m.selection IS DISTINCT FROM g.selection
    OR r.current_attempt_id IS DISTINCT FROM a.attempt_id
    OR NOT (r.task_lease_epoch=s.task_lease_epoch AND r.state IN ('running','succeeded')
      OR s.state='outcome_unknown' AND r.state='reconciling' AND r.task_lease_epoch=s.task_lease_epoch+1)
    OR r.control_epoch IS DISTINCT FROM s.control_epoch
    OR pin.authorization_id IS NULL OR pin.evidence_origin IS DISTINCT FROM s.evidence_origin
    OR g.selection->>'billingSource' IS DISTINCT FROM 'user_byok' OR g.selection->>'credentialCustody' IS DISTINCT FROM 'platform_vault'
    OR g.selection->>'engineLocation' IS DISTINCT FROM 'platform' OR g.selection->>'artifactCustody' IS DISTINCT FROM 'platform_asset'
    OR g.selection->>'processingLocation' IS DISTINCT FROM 'provider_remote'
    THEN RAISE EXCEPTION 'Current machine model admission required' USING ERRCODE='23514'; END IF;
  -- Deliberately no old Work/run aggregate-version comparison here: the shared
  -- domain engine and final Result constraint own that CAS and may just have
  -- advanced it in THIS transaction. Revocation, policies and clocks still apply.
  EXECUTE format('SELECT true FROM %I.private_work_persistence_policy WHERE scope_id=$1 AND owner_principal_id=$2 AND purpose=''work.private-draft'' AND persistence_allowed AND ''private-work.v''||revision::text=$3 FOR SHARE',target_schema)
    INTO ok USING a.scope_id,a.owner_principal_id,g.persistence_policy_revision;
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Current machine persistence policy required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT true FROM %I.model_inference_export_policy WHERE policy_id=$1 AND scope_id=$2 AND owner_principal_id=$3 AND environment=$4 AND client_id=$5 AND purpose=''model.private-draft'' AND selection=$6 AND revision=$7 AND export_allowed AND max_prompt_bytes>=$8 AND max_output_tokens>=$9 FOR SHARE',target_schema)
    INTO ok USING approval.policy_id,a.scope_id,a.owner_principal_id,a.environment,a.client_id,g.selection,approval.export_policy_revision,approval.input_byte_size,approval.max_output_tokens;
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Current machine export policy required' USING ERRCODE='23514'; END IF;
  IF pin.evidence_origin='synthetic_local_fixture' AND a.environment<>'local' THEN RAISE EXCEPTION 'Fixture origin is local only' USING ERRCODE='23514'; END IF;
  IF pin.credential_id IS NOT NULL THEN
    -- Plain SELECT: the executor role is forbidden every credential column
    -- UPDATE, so FOR SHARE cannot run as invoker. Callers that mutate a
    -- credential already lock model_connections FOR UPDATE, and the machine
    -- resolver repeats its pre/post decrypt checks outside that lock.
    EXECUTE format('SELECT * FROM %I.broker_model_credentials WHERE credential_id=$1',target_schema) INTO credential USING pin.credential_id;
    IF credential.credential_id IS NULL OR credential.state IS DISTINCT FROM 'active' OR credential.generation IS DISTINCT FROM pin.credential_generation
      OR credential.recovery_generation IS DISTINCT FROM a.recovery_generation OR credential.issued_at>clock_timestamp() OR credential.expires_at<=clock_timestamp()
      OR ROW(credential.owner_user_id,credential.owner_principal_id,credential.scope_id,credential.environment,credential.client_id,credential.runtime_device_id,credential.connection_id,credential.family_id,credential.model_connection_id,credential.model_version,credential.selection)
        IS DISTINCT FROM ROW(a.owner_user_id,a.owner_principal_id,a.scope_id,a.environment,a.client_id,a.runtime_device_id,a.connection_id,a.family_id,g.model_connection_id,g.model_version,g.selection)
      THEN RAISE EXCEPTION 'Current exact machine credential required' USING ERRCODE='23514'; END IF;
  END IF;
END; $$;
CREATE FUNCTION preserve_machine_model_pin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record; a record;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Machine credential pin retained immutable' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT * FROM %I.execution_machine_authorizations WHERE authorization_id=$1',TG_TABLE_SCHEMA) INTO a USING NEW.authorization_id;
  EXECUTE format('SELECT * FROM %I.model_text_steps WHERE step_id=$1',TG_TABLE_SCHEMA) INTO s USING a.step_id;
  IF s.state IS DISTINCT FROM 'reserved' OR s.aggregate_version IS DISTINCT FROM 1::bigint OR s.evidence_origin IS DISTINCT FROM NEW.evidence_origin
    THEN RAISE EXCEPTION 'Fresh genuine model pin required' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER preserve_machine_model_pin BEFORE INSERT OR UPDATE OR DELETE ON execution_machine_model_pins FOR EACH ROW EXECUTE FUNCTION preserve_machine_model_pin();
CREATE FUNCTION validate_machine_model_pin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM check_machine_model_admission(TG_TABLE_SCHEMA,NEW.authorization_id); RETURN NEW; END; $$;
CREATE TRIGGER validate_machine_model_pin AFTER INSERT ON execution_machine_model_pins FOR EACH ROW EXECUTE FUNCTION validate_machine_model_pin();

CREATE TABLE execution_machine_dispatch_evidence (
  authorization_id uuid PRIMARY KEY REFERENCES execution_machine_authorizations(authorization_id),
  profile text NOT NULL CHECK(profile='freedom.machine-dispatch-evidence/v1'),
  outcome text NOT NULL CHECK(outcome IN ('outcome_unknown','observed_completion','observed_failure')),
  reason text NOT NULL CHECK(reason IN ('client_lost_response','transport_aborted','process_restarted','provider_observation')),
  evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL CHECK(isfinite(received_at) AND received_at=date_trunc('milliseconds',received_at))
);
CREATE FUNCTION preserve_machine_dispatch_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE consumed boolean;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Dispatch evidence retained immutable' USING ERRCODE='23514'; END IF;
  PERFORM check_machine_text_authorization(TG_TABLE_SCHEMA,NEW.authorization_id,true);
  EXECUTE format('SELECT s.dispatched_at IS NOT NULL FROM %I.model_text_steps s JOIN %I.execution_machine_authorizations a USING(step_id) WHERE a.authorization_id=$1',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA) INTO consumed USING NEW.authorization_id;
  IF consumed IS DISTINCT FROM true OR NEW.received_at>clock_timestamp() THEN RAISE EXCEPTION 'Existing consumed dispatch required' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER preserve_machine_dispatch_evidence BEFORE INSERT OR UPDATE OR DELETE ON execution_machine_dispatch_evidence FOR EACH ROW EXECUTE FUNCTION preserve_machine_dispatch_evidence();
REVOKE ALL ON execution_machine_model_pins,execution_machine_dispatch_evidence FROM PUBLIC;

-- The new status path reads metadata after domain completion/Stop. Its DPoP
-- and execute-token signatures still require current device/family/time.
CREATE OR REPLACE FUNCTION preserve_machine_text_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint; pending bigint; backing record;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Machine admission history retained' USING ERRCODE='23514'; END IF;
  PERFORM check_machine_text_device(TG_TABLE_SCHEMA,NEW.runtime_device_id,NEW.connection_id,NEW.family_id);
  IF TG_TABLE_NAME='execution_machine_challenges' THEN
    IF TG_OP='INSERT' THEN
      EXECUTE format('SELECT count(*),count(*) FILTER(WHERE consumed_at IS NULL AND expires_at>clock_timestamp()) FROM %I.execution_machine_challenges WHERE connection_id=$1',TG_TABLE_SCHEMA)
        INTO n,pending USING NEW.connection_id;
      IF n>=256 OR pending>=8 OR NEW.consumed_at IS NOT NULL OR NEW.issued_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp() THEN
        RAISE EXCEPTION 'Bounded fresh machine challenge required' USING ERRCODE='23514'; END IF;
    ELSIF (to_jsonb(NEW)-'consumed_at') IS DISTINCT FROM (to_jsonb(OLD)-'consumed_at') OR OLD.consumed_at IS NOT NULL
      OR NEW.consumed_at IS NULL OR NEW.consumed_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'Machine challenge is one-use' USING ERRCODE='23514'; END IF;
  ELSE
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Machine proof retained immutable' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT count(*) FROM %I.execution_machine_proofs WHERE connection_id=$1',TG_TABLE_SCHEMA) INTO n USING NEW.connection_id;
    IF n>=4096 OR NEW.accepted_at>clock_timestamp() OR NEW.valid_until<=clock_timestamp() THEN
      RAISE EXCEPTION 'Bounded current machine proof required' USING ERRCODE='23514'; END IF;
    IF NEW.authorization_id IS NOT NULL THEN
      EXECUTE format('SELECT * FROM %I.execution_machine_authorizations WHERE authorization_id=$1',TG_TABLE_SCHEMA) INTO backing USING NEW.authorization_id;
      IF NEW.operation IN ('status','evidence') THEN
        PERFORM check_machine_text_authorization(TG_TABLE_SCHEMA,NEW.authorization_id,true);
      ELSE
        -- Existing 117-only admission fixtures retain their strict domain check.
        EXECUTE format('SELECT count(*) FROM %I.execution_machine_model_pins WHERE authorization_id=$1',TG_TABLE_SCHEMA) INTO pending USING NEW.authorization_id;
        IF pending=1 THEN PERFORM check_machine_model_admission(TG_TABLE_SCHEMA,NEW.authorization_id);
        ELSE PERFORM check_machine_text_authorization(TG_TABLE_SCHEMA,NEW.authorization_id,false); END IF;
      END IF;
    ELSE
      EXECUTE format('SELECT * FROM %I.execution_machine_challenges WHERE challenge_id=$1',TG_TABLE_SCHEMA) INTO backing USING NEW.challenge_id;
      IF backing.challenge_id IS NULL OR backing.issued_at>NEW.accepted_at OR backing.expires_at<=clock_timestamp()
        OR (NEW.operation='challenge' AND backing.consumed_at IS NOT NULL)
        OR (NEW.operation='activate' AND backing.consumed_at IS NULL) THEN
        RAISE EXCEPTION 'Exact machine challenge proof required' USING ERRCODE='23514'; END IF;
    END IF;
    IF ROW(backing.runtime_device_id,backing.connection_id,backing.family_id)
      IS DISTINCT FROM ROW(NEW.runtime_device_id,NEW.connection_id,NEW.family_id) THEN
      RAISE EXCEPTION 'Exact machine proof binding required' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END; $$;

-- One-use main-issued machine broker command. Digests only: no access token,
-- DPoP, prompt, ciphertext or provider key. Consumed once by the broker.
CREATE TABLE execution_machine_broker_authorizations (
  authorization_id uuid PRIMARY KEY,
  machine_authorization_id uuid NOT NULL UNIQUE REFERENCES execution_machine_authorizations(authorization_id),
  owner_user_id uuid NOT NULL REFERENCES users(user_id),
  owner_principal_id uuid NOT NULL REFERENCES principals(principal_id),
  scope_id uuid NOT NULL REFERENCES resource_scopes(scope_id),
  environment text NOT NULL CHECK(environment IN ('local','staging-next','next')),
  client_id text NOT NULL CHECK(client_id='agent-kit'),
  runtime_device_id uuid NOT NULL REFERENCES runtime_registrations(runtime_device_id),
  connection_id uuid NOT NULL REFERENCES agent_connections(connection_id),
  family_id uuid NOT NULL REFERENCES bootstrap_refresh_families(family_id),
  grant_id uuid NOT NULL REFERENCES execution_grants(grant_id),
  approval_id uuid NOT NULL REFERENCES model_export_approvals(approval_id),
  step_id uuid NOT NULL UNIQUE REFERENCES model_text_steps(step_id),
  attempt_id uuid NOT NULL REFERENCES execution_attempts(attempt_id),
  credential_id uuid NOT NULL REFERENCES broker_model_credentials(credential_id),
  credential_generation bigint NOT NULL CHECK(credential_generation>0),
  model_connection_id uuid NOT NULL REFERENCES model_connections(model_connection_id),
  model_version bigint NOT NULL CHECK(model_version>0),
  recovery_generation bigint NOT NULL CHECK(recovery_generation>0),
  command_key text NOT NULL CHECK(command_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  command jsonb NOT NULL CHECK(jsonb_typeof(command)='object' AND octet_length(command::text)<=2048),
  command_digest text NOT NULL CHECK(command_digest ~ '^[0-9a-f]{64}$'),
  proof_digest text NOT NULL CHECK(proof_digest ~ '^[0-9a-f]{64}$'),
  access_token_digest text NOT NULL CHECK(access_token_digest ~ '^[0-9a-f]{64}$'),
  expected_version bigint NOT NULL CHECK(expected_version>0),
  nonce_hash text NOT NULL UNIQUE CHECK(nonce_hash ~ '^[0-9a-f]{64}$'),
  assertion jsonb NOT NULL CHECK(jsonb_typeof(assertion)='object' AND octet_length(assertion::text)<=4096),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK(proof_digest<>access_token_digest),
  CHECK(isfinite(issued_at) AND issued_at=date_trunc('milliseconds',issued_at)),
  CHECK(isfinite(expires_at) AND expires_at=date_trunc('milliseconds',expires_at)
    AND expires_at>issued_at AND expires_at<=issued_at+interval '60 seconds'),
  CHECK(consumed_at IS NULL OR (isfinite(consumed_at) AND consumed_at=date_trunc('milliseconds',consumed_at)
    AND consumed_at>=issued_at AND consumed_at<expires_at)),
  UNIQUE(owner_principal_id,scope_id,environment,client_id,command_key)
);
REVOKE ALL ON execution_machine_broker_authorizations FROM PUBLIC;

CREATE FUNCTION preserve_machine_broker_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record; s record; g record; pin record; credential record; expected_command jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Machine broker authorization history is retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'consumed_at') IS DISTINCT FROM (to_jsonb(OLD)-'consumed_at')
      OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL OR NEW.consumed_at>clock_timestamp()
      OR NEW.expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'Machine broker authorization is immutable and consumption one-use' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.issued_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp() OR NEW.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Current machine broker authorization required' USING ERRCODE='23514'; END IF;
  PERFORM check_machine_model_admission(TG_TABLE_SCHEMA,NEW.machine_authorization_id);
  EXECUTE format('SELECT * FROM %I.execution_machine_authorizations WHERE authorization_id=$1',TG_TABLE_SCHEMA) INTO a USING NEW.machine_authorization_id;
  EXECUTE format('SELECT * FROM %I.model_text_steps WHERE step_id=$1',TG_TABLE_SCHEMA) INTO s USING NEW.step_id;
  EXECUTE format('SELECT * FROM %I.execution_grants WHERE grant_id=$1',TG_TABLE_SCHEMA) INTO g USING NEW.grant_id;
  EXECUTE format('SELECT * FROM %I.execution_machine_model_pins WHERE authorization_id=$1',TG_TABLE_SCHEMA) INTO pin USING NEW.machine_authorization_id;
  EXECUTE format('SELECT * FROM %I.broker_model_credentials WHERE credential_id=$1',TG_TABLE_SCHEMA) INTO credential USING NEW.credential_id;
  IF a.authorization_id IS NULL OR s.step_id IS NULL OR g.grant_id IS NULL OR pin.authorization_id IS NULL OR credential.credential_id IS NULL
    OR s.state IS DISTINCT FROM 'reserved' OR s.aggregate_version IS DISTINCT FROM NEW.expected_version
    OR pin.credential_id IS NULL OR pin.credential_id IS DISTINCT FROM NEW.credential_id
    OR pin.credential_generation IS DISTINCT FROM NEW.credential_generation
    OR credential.state IS DISTINCT FROM 'active' OR credential.generation IS DISTINCT FROM NEW.credential_generation
    OR credential.recovery_generation IS DISTINCT FROM NEW.recovery_generation
    OR g.model_connection_id IS DISTINCT FROM NEW.model_connection_id OR g.model_version IS DISTINCT FROM NEW.model_version
    OR g.state IS DISTINCT FROM 'active'
    OR ROW(a.owner_user_id,a.owner_principal_id,a.scope_id,a.environment,a.client_id,a.runtime_device_id,a.connection_id,a.family_id,
        a.grant_id,a.approval_id,a.step_id,a.attempt_id,a.recovery_generation)
      IS DISTINCT FROM ROW(NEW.owner_user_id,NEW.owner_principal_id,NEW.scope_id,NEW.environment,NEW.client_id,NEW.runtime_device_id,NEW.connection_id,NEW.family_id,
        NEW.grant_id,NEW.approval_id,NEW.step_id,NEW.attempt_id,NEW.recovery_generation)
    THEN RAISE EXCEPTION 'Exact current machine broker pins required' USING ERRCODE='23514'; END IF;
  expected_command=jsonb_build_object('operation','execute','input',jsonb_build_object('key',NEW.command_key,'stepId',NEW.step_id::text,'expectedVersion',NEW.expected_version::text));
  IF NEW.command IS DISTINCT FROM expected_command THEN RAISE EXCEPTION 'Exact typed machine broker command required' USING ERRCODE='23514'; END IF;
  IF NEW.nonce_hash IS DISTINCT FROM encode(sha256(convert_to(NEW.assertion->>'nonce','UTF8')),'hex') THEN
    RAISE EXCEPTION 'Exact machine broker nonce hash required' USING ERRCODE='23514'; END IF;
  IF NEW.assertion-ARRAY['issuer','audience','nonce'] IS DISTINCT FROM jsonb_build_object(
    'profile','machine-model-broker.assertion/v1','purpose','machine-model-broker.execute','operation','execute',
    'environment',NEW.environment,'clientId',NEW.client_id,'authorizationRef',NEW.authorization_id::text,
    'commandDigest',NEW.command_digest,'recoveryGeneration',NEW.recovery_generation::text,
    'issuedAt',to_char(NEW.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt',to_char(NEW.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) THEN
    RAISE EXCEPTION 'Exact machine broker assertion binding required' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER preserve_machine_broker_authorization BEFORE INSERT OR UPDATE OR DELETE ON execution_machine_broker_authorizations
  FOR EACH ROW EXECUTE FUNCTION preserve_machine_broker_authorization();
