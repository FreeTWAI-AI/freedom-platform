-- Machine text execution is separate from bootstrap.status.read and member
-- sessions. These records contain hashes/metadata only, never bearer tokens,
-- private context, model credentials or generated text. Existing Work, Grant,
-- Run, Attempt, model step and Result tables remain the domain authority.
CREATE TABLE execution_machine_challenges (
  challenge_id uuid PRIMARY KEY,
  runtime_device_id uuid NOT NULL REFERENCES runtime_registrations(runtime_device_id),
  connection_id uuid NOT NULL REFERENCES agent_connections(connection_id),
  family_id uuid NOT NULL REFERENCES bootstrap_refresh_families(family_id),
  nonce_hash text NOT NULL UNIQUE CHECK(nonce_hash ~ '^[0-9a-f]{64}$'),
  request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK(isfinite(issued_at) AND issued_at=date_trunc('milliseconds',issued_at)),
  CHECK(isfinite(expires_at) AND expires_at=date_trunc('milliseconds',expires_at)
    AND expires_at>issued_at AND expires_at<=issued_at+interval '60 seconds'),
  CHECK(consumed_at IS NULL OR (isfinite(consumed_at) AND consumed_at=date_trunc('milliseconds',consumed_at)
    AND consumed_at>=issued_at AND consumed_at<expires_at)),
  UNIQUE(challenge_id,runtime_device_id,connection_id,family_id)
);
CREATE INDEX execution_machine_challenge_capacity ON execution_machine_challenges(connection_id);

CREATE TABLE execution_machine_authorizations (
  authorization_id uuid PRIMARY KEY,
  challenge_id uuid NOT NULL UNIQUE,
  step_id uuid NOT NULL UNIQUE REFERENCES model_text_steps(step_id),
  attempt_id uuid NOT NULL UNIQUE REFERENCES execution_attempts(attempt_id),
  run_id uuid NOT NULL REFERENCES execution_runs(run_id),
  grant_id uuid NOT NULL REFERENCES execution_grants(grant_id),
  approval_id uuid NOT NULL REFERENCES model_export_approvals(approval_id),
  owner_user_id uuid NOT NULL REFERENCES users(user_id),
  owner_principal_id uuid NOT NULL REFERENCES principals(principal_id),
  scope_id uuid NOT NULL REFERENCES resource_scopes(scope_id),
  environment text NOT NULL CHECK(environment IN ('local','staging-next','next')),
  client_id text NOT NULL CHECK(client_id='agent-kit'),
  runtime_device_id uuid NOT NULL REFERENCES runtime_registrations(runtime_device_id),
  runtime_version bigint NOT NULL CHECK(runtime_version>0),
  connection_id uuid NOT NULL REFERENCES agent_connections(connection_id),
  connection_version bigint NOT NULL CHECK(connection_version>0),
  family_id uuid NOT NULL REFERENCES bootstrap_refresh_families(family_id),
  key_thumbprint text NOT NULL CHECK(key_thumbprint ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  grant_version bigint NOT NULL CHECK(grant_version>0),
  approval_version bigint NOT NULL CHECK(approval_version>0),
  -- SHA256 of PostgreSQL's JSONB text encoding of the immutable v1 step
  -- binding; this is an explicitly local digest profile, not JCS.
  binding_sha256 text NOT NULL CHECK(binding_sha256 ~ '^[0-9a-f]{64}$'),
  recovery_generation bigint NOT NULL CHECK(recovery_generation>0),
  execute_jti text NOT NULL UNIQUE CHECK(execute_jti ~ '^[A-Za-z0-9_-]{16,128}$'),
  evidence_jti text NOT NULL UNIQUE CHECK(evidence_jti ~ '^[A-Za-z0-9_-]{16,128}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  evidence_expires_at timestamptz NOT NULL,
  CHECK(execute_jti<>evidence_jti),
  CHECK(isfinite(issued_at) AND issued_at=date_trunc('milliseconds',issued_at)),
  CHECK(isfinite(expires_at) AND expires_at=date_trunc('milliseconds',expires_at)
    AND expires_at>issued_at AND expires_at<=issued_at+interval '90 seconds'),
  CHECK(isfinite(evidence_expires_at) AND evidence_expires_at=date_trunc('milliseconds',evidence_expires_at)
    AND evidence_expires_at>=expires_at AND evidence_expires_at<=issued_at+interval '5 minutes'),
  FOREIGN KEY(challenge_id,runtime_device_id,connection_id,family_id)
    REFERENCES execution_machine_challenges(challenge_id,runtime_device_id,connection_id,family_id),
  UNIQUE(authorization_id,attempt_id,grant_id,runtime_device_id,connection_id,owner_principal_id,scope_id)
);

CREATE TABLE execution_machine_proofs (
  runtime_device_id uuid NOT NULL REFERENCES runtime_registrations(runtime_device_id),
  connection_id uuid NOT NULL REFERENCES agent_connections(connection_id),
  family_id uuid NOT NULL REFERENCES bootstrap_refresh_families(family_id),
  proof_jti text NOT NULL CHECK(proof_jti ~ '^[A-Za-z0-9_-]{16,128}$'),
  operation text NOT NULL CHECK(operation IN ('challenge','activate','execute','status','evidence')),
  challenge_id uuid REFERENCES execution_machine_challenges(challenge_id),
  authorization_id uuid REFERENCES execution_machine_authorizations(authorization_id),
  request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
  accepted_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  PRIMARY KEY(runtime_device_id,proof_jti),
  CHECK((operation IN ('challenge','activate') AND challenge_id IS NOT NULL AND authorization_id IS NULL)
    OR (operation IN ('execute','status','evidence') AND challenge_id IS NULL AND authorization_id IS NOT NULL)),
  CHECK(isfinite(accepted_at) AND accepted_at=date_trunc('milliseconds',accepted_at)),
  CHECK(isfinite(valid_until) AND valid_until=date_trunc('milliseconds',valid_until)
    AND valid_until>accepted_at AND valid_until<=accepted_at+interval '66 seconds')
);
CREATE INDEX execution_machine_proof_capacity ON execution_machine_proofs(connection_id);

-- Current parent checks are independent of Grant/model/policy health so the
-- narrowly bounded evidence path remains possible after Stop or Grant expiry.
-- This is NOT cryptographic authentication; server code verifies signed DPoP
-- before inserting a proof and checks it again after blocking SQL operations.
CREATE FUNCTION check_machine_text_device(target_schema text,device_id uuid,connection_ref uuid,family_ref uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE d record; c record; f record; current_owner boolean;
BEGIN
  EXECUTE format('SELECT * FROM %I.runtime_registrations WHERE runtime_device_id=$1',target_schema) INTO d USING device_id;
  EXECUTE format('SELECT * FROM %I.agent_connections WHERE connection_id=$1',target_schema) INTO c USING connection_ref;
  EXECUTE format('SELECT * FROM %I.bootstrap_refresh_families WHERE family_id=$1',target_schema) INTO f USING family_ref;
  IF d.runtime_device_id IS NULL OR c.connection_id IS NULL OR f.family_id IS NULL
    OR d.state IS DISTINCT FROM 'enrolled' OR c.state IS DISTINCT FROM 'active' OR f.state IS DISTINCT FROM 'active'
    OR c.runtime_device_id IS DISTINCT FROM d.runtime_device_id OR f.connection_id IS DISTINCT FROM c.connection_id
    OR ROW(c.owner_user_id,c.owner_principal_id,c.scope_id,c.environment)
      IS DISTINCT FROM ROW(d.owner_user_id,d.owner_principal_id,d.scope_id,d.environment)
    OR c.client_id IS DISTINCT FROM 'agent-kit' OR c.issued_at>clock_timestamp() OR c.expires_at<=clock_timestamp()
    OR f.issued_at>clock_timestamp() OR f.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Current exact machine device required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT true FROM %I.users u JOIN %I.principals p ON p.user_ref=u.user_id JOIN %I.resource_scopes s ON s.owner_principal_id=p.principal_id WHERE u.user_id=$1 AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL) AND p.principal_id=$2 AND p.kind=''person'' AND p.status=''active'' AND s.scope_id=$3 AND s.kind=''personal'' AND s.status=''active''',target_schema,target_schema,target_schema)
    INTO current_owner USING c.owner_user_id,c.owner_principal_id,c.scope_id;
  IF current_owner IS DISTINCT FROM true THEN RAISE EXCEPTION 'Current machine owner required' USING ERRCODE='23514'; END IF;
END; $$;

CREATE FUNCTION check_machine_text_authorization(target_schema text,authorization_ref uuid,evidence_only boolean)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE a record; s record; d record; c record; f record;
BEGIN
  EXECUTE format('SELECT * FROM %I.execution_machine_authorizations WHERE authorization_id=$1',target_schema) INTO a USING authorization_ref;
  IF a.authorization_id IS NULL THEN RAISE EXCEPTION 'Machine authorization required' USING ERRCODE='23514'; END IF;
  PERFORM check_machine_text_device(target_schema,a.runtime_device_id,a.connection_id,a.family_id);
  EXECUTE format('SELECT * FROM %I.runtime_registrations WHERE runtime_device_id=$1',target_schema) INTO d USING a.runtime_device_id;
  EXECUTE format('SELECT * FROM %I.agent_connections WHERE connection_id=$1',target_schema) INTO c USING a.connection_id;
  EXECUTE format('SELECT * FROM %I.bootstrap_refresh_families WHERE family_id=$1',target_schema) INTO f USING a.family_id;
  IF d.aggregate_version IS DISTINCT FROM a.runtime_version OR d.key_thumbprint IS DISTINCT FROM a.key_thumbprint
    OR c.aggregate_version IS DISTINCT FROM a.connection_version
    OR ROW(c.owner_user_id,c.owner_principal_id,c.scope_id,c.environment,c.client_id)
      IS DISTINCT FROM ROW(a.owner_user_id,a.owner_principal_id,a.scope_id,a.environment,a.client_id)
    OR a.issued_at>clock_timestamp() OR (CASE WHEN evidence_only THEN a.evidence_expires_at ELSE a.expires_at END)<=clock_timestamp() THEN
    RAISE EXCEPTION 'Current machine authorization required' USING ERRCODE='23514'; END IF;
  IF NOT evidence_only THEN
    EXECUTE format('SELECT * FROM %I.model_text_steps WHERE step_id=$1',target_schema) INTO s USING a.step_id;
    PERFORM check_model_text_step_current(target_schema,to_jsonb(s));
  END IF;
END; $$;

CREATE FUNCTION preserve_machine_text_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record; d record; c record; f record; challenge record;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Machine authorization retained immutable' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT * FROM %I.model_text_steps WHERE step_id=$1',TG_TABLE_SCHEMA) INTO s USING NEW.step_id;
  EXECUTE format('SELECT * FROM %I.runtime_registrations WHERE runtime_device_id=$1',TG_TABLE_SCHEMA) INTO d USING NEW.runtime_device_id;
  EXECUTE format('SELECT * FROM %I.agent_connections WHERE connection_id=$1',TG_TABLE_SCHEMA) INTO c USING NEW.connection_id;
  EXECUTE format('SELECT * FROM %I.bootstrap_refresh_families WHERE family_id=$1',TG_TABLE_SCHEMA) INTO f USING NEW.family_id;
  EXECUTE format('SELECT * FROM %I.execution_machine_challenges WHERE challenge_id=$1',TG_TABLE_SCHEMA) INTO challenge USING NEW.challenge_id;
  PERFORM check_machine_text_device(TG_TABLE_SCHEMA,NEW.runtime_device_id,NEW.connection_id,NEW.family_id);
  PERFORM check_model_text_step_current(TG_TABLE_SCHEMA,to_jsonb(s));
  IF s.step_id IS NULL OR s.state IS DISTINCT FROM 'reserved' OR s.aggregate_version IS DISTINCT FROM 1::bigint
    OR ROW(s.attempt_id,s.run_id,s.approval_id,s.owner_user_id,s.owner_principal_id,s.scope_id,s.environment,s.client_id)
      IS DISTINCT FROM ROW(NEW.attempt_id,NEW.run_id,NEW.approval_id,NEW.owner_user_id,NEW.owner_principal_id,NEW.scope_id,NEW.environment,NEW.client_id)
    OR ROW(s.binding->>'grantId',s.binding->>'grantVersion',s.binding->>'approvalVersion',s.binding->>'runtimeDeviceId',s.binding->>'runtimeVersion',s.binding->>'connectionId',s.binding->>'connectionVersion',s.binding->>'familyId')
      IS DISTINCT FROM ROW(NEW.grant_id::text,NEW.grant_version::text,NEW.approval_version::text,NEW.runtime_device_id::text,NEW.runtime_version::text,NEW.connection_id::text,NEW.connection_version::text,NEW.family_id::text)
    OR NEW.binding_sha256 IS DISTINCT FROM encode(sha256(convert_to(s.binding::text,'UTF8')),'hex')
    OR NEW.recovery_generation::text IS DISTINCT FROM s.verified_binding->>'recoveryGeneration'
    OR NEW.key_thumbprint IS DISTINCT FROM d.key_thumbprint OR NEW.runtime_version IS DISTINCT FROM d.aggregate_version
    OR NEW.connection_version IS DISTINCT FROM c.aggregate_version
    OR challenge.consumed_at IS NULL OR challenge.consumed_at>NEW.issued_at
    OR NEW.issued_at<challenge.issued_at OR NEW.issued_at>=challenge.expires_at OR NEW.issued_at<s.created_at
    OR NEW.issued_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp() OR NEW.expires_at>s.lease_expires_at
    OR NEW.evidence_expires_at>c.expires_at OR NEW.evidence_expires_at>f.expires_at THEN
    RAISE EXCEPTION 'Exact genuine machine step binding required' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER preserve_machine_text_authorization BEFORE INSERT OR UPDATE OR DELETE ON execution_machine_authorizations
  FOR EACH ROW EXECUTE FUNCTION preserve_machine_text_authorization();

CREATE FUNCTION preserve_machine_text_admission() RETURNS trigger LANGUAGE plpgsql AS $$
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
      PERFORM check_machine_text_authorization(TG_TABLE_SCHEMA,NEW.authorization_id,NEW.operation='evidence');
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
CREATE TRIGGER preserve_machine_text_challenge BEFORE INSERT OR UPDATE OR DELETE ON execution_machine_challenges FOR EACH ROW EXECUTE FUNCTION preserve_machine_text_admission();
CREATE TRIGGER preserve_machine_text_proof BEFORE INSERT OR UPDATE OR DELETE ON execution_machine_proofs FOR EACH ROW EXECUTE FUNCTION preserve_machine_text_admission();

-- A closed additional authentication branch, never authn_kind-as-permission.
-- Existing member facts retain their original identity/digest/namespace and
-- MUST have every execution-specific reference NULL. A2's service extension
-- follows this migration rather than replacing these constraints in parallel.
ALTER TABLE scoped_command_receipts DROP CONSTRAINT scoped_command_receipts_authn_kind_check;
ALTER TABLE scoped_transition_journal DROP CONSTRAINT scoped_transition_journal_authn_kind_check;
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['scoped_command_receipts','scoped_transition_journal'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN execution_authorization_id uuid, ADD COLUMN execution_attempt_id uuid, ADD COLUMN execution_grant_id uuid, ADD COLUMN execution_runtime_device_id uuid, ADD COLUMN execution_connection_id uuid',relation);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((authn_kind=''member_session'' AND execution_authorization_id IS NULL AND execution_attempt_id IS NULL AND execution_grant_id IS NULL AND execution_runtime_device_id IS NULL AND execution_connection_id IS NULL) OR (authn_kind=''execution_token'' AND principal_kind=''person'' AND scope_kind=''personal'' AND execution_authorization_id IS NOT NULL AND execution_attempt_id IS NOT NULL AND execution_grant_id IS NOT NULL AND execution_runtime_device_id IS NOT NULL AND execution_connection_id IS NOT NULL))',relation,relation||'_authn_binding');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY(execution_authorization_id,execution_attempt_id,execution_grant_id,execution_runtime_device_id,execution_connection_id,principal_id,scope_id) REFERENCES execution_machine_authorizations(authorization_id,attempt_id,grant_id,runtime_device_id,connection_id,owner_principal_id,scope_id)',relation,relation||'_execution_binding');
  END LOOP;
END; $$;

REVOKE ALL ON execution_machine_challenges,execution_machine_authorizations,execution_machine_proofs FROM PUBLIC;
