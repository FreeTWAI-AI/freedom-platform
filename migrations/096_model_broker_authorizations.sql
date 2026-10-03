-- Temporary numeric ID. Original session/nonce are server-only authority data;
-- ordinary metadata APIs must never serialize this table.
CREATE TABLE model_broker_authorizations (
  authorization_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(user_id),
  owner_principal_id uuid NOT NULL REFERENCES principals(principal_id),
  scope_id uuid NOT NULL REFERENCES resource_scopes(scope_id),
  original_session_hash text NOT NULL REFERENCES sessions(token_hash),
  environment text NOT NULL CHECK(environment IN ('local','staging-next','next')),
  client_id text NOT NULL,
  operation text NOT NULL CHECK(operation IN ('activate','execute')),
  command_key text NOT NULL CHECK(command_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  command jsonb NOT NULL CHECK(jsonb_typeof(command)='object' AND octet_length(command::text)<=2048),
  command_digest text NOT NULL CHECK(command_digest ~ '^[0-9a-f]{64}$'),
  nonce_hash text NOT NULL UNIQUE CHECK(nonce_hash ~ '^[0-9a-f]{64}$'),
  assertion jsonb NOT NULL CHECK(jsonb_typeof(assertion)='object' AND octet_length(assertion::text)<=4096),
  approval_id uuid NOT NULL REFERENCES model_export_approvals(approval_id),
  step_id uuid REFERENCES model_text_steps(step_id),
  expected_primary_version bigint NOT NULL CHECK(expected_primary_version>0),
  expected_run_version bigint CHECK(expected_run_version>0),
  run_id uuid NOT NULL REFERENCES execution_runs(run_id),
  work_item_id uuid NOT NULL REFERENCES work_items(work_item_id),
  grant_id uuid NOT NULL REFERENCES execution_grants(grant_id),
  credential_id uuid NOT NULL REFERENCES broker_model_credentials(credential_id),
  credential_generation bigint NOT NULL CHECK(credential_generation>0),
  model_connection_id uuid NOT NULL REFERENCES model_connections(model_connection_id),
  model_version bigint NOT NULL CHECK(model_version>0),
  recovery_generation bigint NOT NULL CHECK(recovery_generation>0),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  CHECK((operation='activate' AND step_id IS NULL AND expected_run_version IS NOT NULL)
    OR (operation='execute' AND step_id IS NOT NULL AND expected_run_version IS NULL)),
  CHECK(isfinite(issued_at) AND issued_at=date_trunc('milliseconds',issued_at)),
  CHECK(isfinite(expires_at) AND expires_at=date_trunc('milliseconds',expires_at)
    AND expires_at>issued_at AND expires_at<=issued_at+interval '60 seconds'),
  CHECK(accepted_at IS NULL OR (isfinite(accepted_at) AND accepted_at=date_trunc('milliseconds',accepted_at)
    AND accepted_at>=issued_at AND accepted_at<expires_at)),
  UNIQUE(owner_principal_id,scope_id,environment,client_id,operation,command_key)
);
REVOKE ALL ON model_broker_authorizations FROM PUBLIC;

CREATE FUNCTION preserve_model_broker_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_owner boolean; credential record; approval record; step record; grant_row record; run_row record; expected_command jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Broker authorization history is retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'accepted_at') IS DISTINCT FROM (to_jsonb(OLD)-'accepted_at')
      OR OLD.accepted_at IS NOT NULL OR NEW.accepted_at IS NULL OR NEW.accepted_at>clock_timestamp()
      OR NEW.expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'Broker authorization is immutable and acceptance one-use' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT true FROM %I.users u JOIN %I.sessions s ON s.user_id=u.user_id JOIN %I.principals p ON p.user_ref=u.user_id JOIN %I.resource_scopes rs ON rs.owner_principal_id=p.principal_id WHERE u.user_id=$1 AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL) AND s.token_hash=$2 AND s.revoked_at IS NULL AND s.expires_at>$5 AND p.principal_id=$3 AND p.kind=''person'' AND p.status=''active'' AND rs.scope_id=$4 AND rs.kind=''personal'' AND rs.status=''active''',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA,TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
    INTO current_owner USING NEW.owner_user_id,NEW.original_session_hash,NEW.owner_principal_id,NEW.scope_id,NEW.expires_at;
  IF current_owner IS DISTINCT FROM true OR NEW.issued_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp() OR NEW.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Current original member authorization required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT * FROM %I.broker_model_credentials WHERE credential_id=$1',TG_TABLE_SCHEMA) INTO credential USING NEW.credential_id;
  EXECUTE format('SELECT * FROM %I.model_export_approvals WHERE approval_id=$1',TG_TABLE_SCHEMA) INTO approval USING NEW.approval_id;
  IF credential.credential_id IS NULL OR credential.state<>'active' OR credential.generation<>NEW.credential_generation
    OR credential.model_connection_id<>NEW.model_connection_id OR credential.model_version<>NEW.model_version
    OR credential.recovery_generation<>NEW.recovery_generation OR credential.expires_at<NEW.expires_at
    OR ROW(credential.owner_user_id,credential.owner_principal_id,credential.scope_id,credential.environment,credential.client_id)
      IS DISTINCT FROM ROW(NEW.owner_user_id,NEW.owner_principal_id,NEW.scope_id,NEW.environment,NEW.client_id)
    OR approval.approval_id IS NULL OR approval.state<>'active' OR approval.expires_at<NEW.expires_at
    OR ROW(approval.owner_user_id,approval.owner_principal_id,approval.scope_id,approval.environment,approval.client_id,approval.run_id,approval.work_item_id,approval.grant_id)
      IS DISTINCT FROM ROW(NEW.owner_user_id,NEW.owner_principal_id,NEW.scope_id,NEW.environment,NEW.client_id,NEW.run_id,NEW.work_item_id,NEW.grant_id) THEN
    RAISE EXCEPTION 'Exact current broker target/pin required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT * FROM %I.execution_grants WHERE grant_id=$1',TG_TABLE_SCHEMA) INTO grant_row USING NEW.grant_id;
  EXECUTE format('SELECT * FROM %I.execution_runs WHERE run_id=$1',TG_TABLE_SCHEMA) INTO run_row USING NEW.run_id;
  IF grant_row.grant_id IS NULL OR grant_row.model_connection_id<>NEW.model_connection_id OR grant_row.model_version<>NEW.model_version
    OR grant_row.run_id<>NEW.run_id OR grant_row.work_item_id<>NEW.work_item_id OR grant_row.state<>'active'
    OR grant_row.aggregate_version<>approval.grant_version OR grant_row.expires_at<NEW.expires_at
    OR run_row.run_id IS NULL OR run_row.work_item_id<>NEW.work_item_id THEN
    RAISE EXCEPTION 'Exact original grant target required' USING ERRCODE='23514'; END IF;
  IF NEW.operation='activate' THEN
    IF run_row.state<>'created' OR run_row.aggregate_version<>NEW.expected_run_version THEN RAISE EXCEPTION 'Exact original Run CAS required' USING ERRCODE='23514'; END IF;
    IF approval.aggregate_version<>NEW.expected_primary_version THEN RAISE EXCEPTION 'Exact approval CAS required' USING ERRCODE='23514'; END IF;
    expected_command=jsonb_build_object('operation','activate','input',jsonb_build_object('key',NEW.command_key,'approvalId',NEW.approval_id::text,'expectedApprovalVersion',NEW.expected_primary_version::text,'expectedRunVersion',NEW.expected_run_version::text));
  ELSE
    EXECUTE format('SELECT * FROM %I.model_text_steps WHERE step_id=$1',TG_TABLE_SCHEMA) INTO step USING NEW.step_id;
    IF step.step_id IS NULL OR step.approval_id<>NEW.approval_id OR step.aggregate_version<>NEW.expected_primary_version
      OR step.state<>'reserved' OR step.binding->>'modelConnectionId'<>NEW.model_connection_id::text
      OR step.binding->>'modelVersion'<>NEW.model_version::text THEN RAISE EXCEPTION 'Exact step CAS required' USING ERRCODE='23514'; END IF;
    expected_command=jsonb_build_object('operation','execute','input',jsonb_build_object('key',NEW.command_key,'stepId',NEW.step_id::text,'expectedVersion',NEW.expected_primary_version::text));
  END IF;
  IF NEW.command IS DISTINCT FROM expected_command THEN RAISE EXCEPTION 'Exact typed broker command required' USING ERRCODE='23514'; END IF;
  IF NEW.nonce_hash IS DISTINCT FROM encode(sha256(convert_to(NEW.assertion->>'nonce','UTF8')),'hex') THEN
    RAISE EXCEPTION 'Exact nonce hash required' USING ERRCODE='23514'; END IF;
  IF NEW.assertion-ARRAY['issuer','audience','nonce'] IS DISTINCT FROM jsonb_build_object('profile','model-broker.assertion/v1','purpose','model-broker.'||NEW.operation,'operation',NEW.operation,'environment',NEW.environment,'clientId',NEW.client_id,'authorizationRef',NEW.authorization_id::text,'commandDigest',NEW.command_digest,'recoveryGeneration',NEW.recovery_generation::text,'issuedAt',to_char(NEW.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(NEW.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) THEN
    RAISE EXCEPTION 'Exact assertion binding required' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_model_broker_authorization BEFORE INSERT OR UPDATE OR DELETE ON model_broker_authorizations
  FOR EACH ROW EXECUTE FUNCTION preserve_model_broker_authorization();
