-- OpenRouter-only namespaced BYOK identifiers. Keep historical label metadata,
-- every existing custody fence and grants unchanged; no export policy is seeded.
DO $migration$
DECLARE selection_constraint text; count_constraints integer;
BEGIN
  SELECT min(c.conname), count(*) INTO selection_constraint, count_constraints
  FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname='selection'
  WHERE c.conrelid='model_connections'::regclass AND c.contype='c' AND c.conkey=ARRAY[a.attnum];
  IF count_constraints<>1 THEN RAISE EXCEPTION 'Expected one model selection CHECK'; END IF;
  EXECUTE format('ALTER TABLE model_connections DROP CONSTRAINT %I',selection_constraint);
END;
$migration$;
ALTER TABLE model_connections ADD CONSTRAINT model_connections_selection_v2 CHECK(COALESCE(jsonb_typeof(selection)='object' AND selection ?& ARRAY['providerRef','modelRef','processingLocation','artifactCustody','credentialCustody','engineLocation','billingSource']
    AND selection-ARRAY['providerRef','modelRef','processingLocation','artifactCustody','credentialCustody','engineLocation','billingSource']='{}'::jsonb
    AND jsonb_typeof(selection->'providerRef')='string' AND length(selection->>'providerRef') BETWEEN 1 AND 96 AND selection->>'providerRef' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    AND jsonb_typeof(selection->'modelRef')='string' AND length(selection->>'modelRef') BETWEEN 1 AND 96 AND (selection->>'modelRef' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
      OR (selection->>'providerRef'='openrouter' AND selection->>'modelRef' ~ '^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:-]*$'
        AND selection->>'credentialCustody' IN ('local_keychain','platform_vault')
        AND selection->>'billingSource'='user_byok' AND selection->>'processingLocation'='provider_remote'))
    AND jsonb_typeof(selection->'processingLocation')='string' AND length(selection->>'processingLocation') BETWEEN 1 AND 96 AND selection->>'processingLocation' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    AND selection->>'artifactCustody' IN ('runtime_local','platform_asset')
    AND ((selection->>'credentialCustody'='official_cli' AND selection->>'engineLocation'='runtime_local' AND selection->>'billingSource'='user_cli')
      OR (selection->>'credentialCustody'='local_keychain' AND selection->>'engineLocation'='runtime_local' AND selection->>'billingSource'='user_byok')
      OR (selection->>'credentialCustody'='platform_vault' AND selection->>'engineLocation'='platform' AND selection->>'billingSource'='user_byok')),false));

-- Same trigger/privileges and all prior predicates; only the explicit provider/model pair expands.
CREATE OR REPLACE FUNCTION preserve_broker_credential() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE model record; connection record; family record; runtime record; current_owner boolean; expected jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Broker credential history is retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['state','aggregate_version','terminal_at','replacement_credential_id'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','aggregate_version','terminal_at','replacement_credential_id'])
      OR OLD.state<>'active' OR NEW.state NOT IN ('rotated','revoked')
      OR NEW.aggregate_version::numeric<>OLD.aggregate_version::numeric+1 OR NEW.terminal_at>clock_timestamp() THEN
      RAISE EXCEPTION 'Credential identity is immutable and termination final' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL) FROM %I.users WHERE user_id=$1 FOR SHARE',TG_TABLE_SCHEMA)
    INTO current_owner USING NEW.owner_user_id;
  IF current_owner IS DISTINCT FROM true THEN RAISE EXCEPTION 'Current owner required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT true FROM %I.principals WHERE principal_id=$1 AND user_ref=$2 AND kind=''person'' AND status=''active'' FOR SHARE',TG_TABLE_SCHEMA)
    INTO current_owner USING NEW.owner_principal_id,NEW.owner_user_id;
  IF current_owner IS DISTINCT FROM true THEN RAISE EXCEPTION 'Current principal required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT true FROM %I.resource_scopes WHERE scope_id=$1 AND owner_principal_id=$2 AND kind=''personal'' AND status=''active'' FOR SHARE',TG_TABLE_SCHEMA)
    INTO current_owner USING NEW.scope_id,NEW.owner_principal_id;
  IF current_owner IS DISTINCT FROM true THEN RAISE EXCEPTION 'Current scope required' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('freedom.execution-prerequisites.owner/v1:'||NEW.owner_principal_id::text,0));
  EXECUTE format('SELECT * FROM %I.runtime_registrations WHERE runtime_device_id=$1 FOR SHARE',TG_TABLE_SCHEMA) INTO runtime USING NEW.runtime_device_id;
  EXECUTE format('SELECT * FROM %I.agent_connections WHERE connection_id=$1 FOR SHARE',TG_TABLE_SCHEMA) INTO connection USING NEW.connection_id;
  EXECUTE format('SELECT * FROM %I.bootstrap_refresh_families WHERE family_id=$1 FOR SHARE',TG_TABLE_SCHEMA) INTO family USING NEW.family_id;
  EXECUTE format('SELECT * FROM %I.model_connections WHERE model_connection_id=$1 FOR SHARE',TG_TABLE_SCHEMA) INTO model USING NEW.model_connection_id;
  IF model.model_connection_id IS NULL OR model.state<>'unverified' OR model.aggregate_version<>NEW.model_version
    OR model.selection IS DISTINCT FROM NEW.selection OR runtime.state IS DISTINCT FROM 'enrolled'
    OR connection.state IS DISTINCT FROM 'active' OR family.state IS DISTINCT FROM 'active'
    OR connection.issued_at>NEW.issued_at OR family.issued_at>NEW.issued_at OR model.created_at>NEW.issued_at
    OR runtime.enrolled_at>NEW.issued_at OR NEW.issued_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp()
    OR NEW.expires_at>connection.expires_at OR NEW.expires_at>family.expires_at
    OR NEW.selection->>'providerRef' NOT IN ('openai','anthropic','openrouter')
    OR (NEW.selection->>'providerRef'='openrouter' AND NEW.selection->>'modelRef' !~ '^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:-]*$')
    OR NEW.selection->>'credentialCustody'<>'platform_vault' OR NEW.selection->>'engineLocation'<>'platform'
    OR NEW.selection->>'billingSource'<>'user_byok' OR NEW.selection->>'processingLocation'<>'provider_remote'
    OR NEW.selection->>'artifactCustody'<>'platform_asset' THEN
    RAISE EXCEPTION 'Exact current broker custody binding required' USING ERRCODE='23514'; END IF;
  expected=jsonb_build_object('profile','model-credential.binding/v1','credentialId',NEW.credential_id::text,
    'generation',NEW.generation::text,'modelConnectionId',NEW.model_connection_id::text,'modelVersion',NEW.model_version::text,
    'ownerUserId',NEW.owner_user_id::text,'ownerPrincipalId',NEW.owner_principal_id::text,'scopeId',NEW.scope_id::text,
    'environment',NEW.environment,'clientId',NEW.client_id,'runtimeDeviceId',NEW.runtime_device_id::text,
    'connectionId',NEW.connection_id::text,'familyId',NEW.family_id::text,'selection',NEW.selection,
    'recoveryGeneration',NEW.recovery_generation::text,
    'issuedAt',to_char(NEW.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt',to_char(NEW.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  IF NEW.binding IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Exact credential AAD binding required' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;

-- Same trigger/privileges and all prior predicates; only the explicit provider/model pair expands.
CREATE OR REPLACE FUNCTION preserve_credential_ingest_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_owner boolean; model record; old_credential record; expected_command jsonb; expected_metadata jsonb; committed record; runtime record; connection record; family record; existing record; old_model record;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Credential ingest history is retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['bootstrap_claimed_at','setup_cookie_hash','setup_csrf_hash','setup_expires_at',
        'submission_claimed_at','write_expires_at','submitted_credential_id','submitted_binding','committed_at','committed_credential_id'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['bootstrap_claimed_at','setup_cookie_hash','setup_csrf_hash','setup_expires_at',
        'submission_claimed_at','write_expires_at','submitted_credential_id','submitted_binding','committed_at','committed_credential_id']) THEN
      RAISE EXCEPTION 'Credential ingest identity is immutable' USING ERRCODE='23514'; END IF;
    IF OLD.bootstrap_claimed_at IS NULL AND NEW.bootstrap_claimed_at IS NOT NULL THEN
      IF NEW.submission_claimed_at IS NOT NULL OR NEW.committed_at IS NOT NULL OR NEW.bootstrap_claimed_at>clock_timestamp()
        OR NEW.setup_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Fresh one-use setup claim required' USING ERRCODE='23514'; END IF;
    ELSIF OLD.submission_claimed_at IS NULL AND NEW.submission_claimed_at IS NOT NULL THEN
      IF ROW(NEW.bootstrap_claimed_at,NEW.setup_cookie_hash,NEW.setup_csrf_hash,NEW.setup_expires_at)
        IS DISTINCT FROM ROW(OLD.bootstrap_claimed_at,OLD.setup_cookie_hash,OLD.setup_csrf_hash,OLD.setup_expires_at)
        OR NEW.committed_at IS NOT NULL OR NEW.submission_claimed_at>clock_timestamp() OR NEW.write_expires_at<=clock_timestamp() THEN
        RAISE EXCEPTION 'Fresh one-use submission claim required' USING ERRCODE='23514'; END IF;
    ELSIF OLD.committed_at IS NULL AND NEW.committed_at IS NOT NULL THEN
      IF (to_jsonb(NEW)-ARRAY['committed_at','committed_credential_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['committed_at','committed_credential_id'])
        OR NEW.committed_at>clock_timestamp() OR NEW.write_expires_at<=clock_timestamp() THEN
        RAISE EXCEPTION 'Fresh exact ingest commit required' USING ERRCODE='23514'; END IF;
      EXECUTE format('SELECT c.* FROM %I.broker_model_credentials c JOIN %I.broker_credential_vault v USING(credential_id) WHERE c.credential_id=$1',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
        INTO committed USING NEW.committed_credential_id;
      IF committed.credential_id IS NULL OR committed.binding IS DISTINCT FROM NEW.submitted_binding OR committed.state<>'active' THEN
        RAISE EXCEPTION 'Exact committed credential required' USING ERRCODE='23514'; END IF;
    ELSE RAISE EXCEPTION 'Credential ingest claims are monotonic and one-use' USING ERRCODE='23514'; END IF;
  ELSE
    IF NEW.bootstrap_claimed_at IS NOT NULL OR NEW.submission_claimed_at IS NOT NULL OR NEW.committed_at IS NOT NULL THEN
      RAISE EXCEPTION 'New ingest starts unclaimed' USING ERRCODE='23514'; END IF;
  END IF;
  EXECUTE format('SELECT true FROM %I.users u JOIN %I.sessions s ON s.user_id=u.user_id JOIN %I.principals p ON p.user_ref=u.user_id JOIN %I.resource_scopes rs ON rs.owner_principal_id=p.principal_id WHERE u.user_id=$1 AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL) AND s.token_hash=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND p.principal_id=$3 AND p.kind=''person'' AND p.status=''active'' AND rs.scope_id=$4 AND rs.kind=''personal'' AND rs.status=''active''',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA,TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
    INTO current_owner USING NEW.owner_user_id,NEW.original_session_hash,NEW.owner_principal_id,NEW.scope_id;
  IF current_owner IS DISTINCT FROM true OR NEW.issued_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Current original member required for ingest' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT * FROM %I.model_connections WHERE model_connection_id=$1',TG_TABLE_SCHEMA) INTO model USING NEW.model_connection_id;
  IF model.model_connection_id IS NULL OR model.state<>'unverified' OR model.aggregate_version<>NEW.model_version
    OR ROW(model.owner_user_id,model.owner_principal_id,model.scope_id,model.environment,model.client_id)
      IS DISTINCT FROM ROW(NEW.owner_user_id,NEW.owner_principal_id,NEW.scope_id,NEW.environment,NEW.client_id) THEN
    RAISE EXCEPTION 'Exact current ingest model required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT * FROM %I.runtime_registrations WHERE runtime_device_id=$1',TG_TABLE_SCHEMA) INTO runtime USING model.runtime_device_id;
  EXECUTE format('SELECT * FROM %I.agent_connections WHERE connection_id=$1',TG_TABLE_SCHEMA) INTO connection USING model.connection_id;
  EXECUTE format('SELECT * FROM %I.bootstrap_refresh_families WHERE family_id=$1',TG_TABLE_SCHEMA) INTO family USING model.family_id;
  IF COALESCE(runtime.state='enrolled' AND runtime.enrolled_at<=clock_timestamp()
    AND connection.state='active' AND connection.issued_at<=clock_timestamp() AND connection.expires_at>=NEW.expires_at
    AND family.state='active' AND family.connection_id=model.connection_id AND family.issued_at<=clock_timestamp() AND family.expires_at>=NEW.expires_at
    AND model.created_at<=NEW.issued_at
    AND model.selection->>'providerRef' IN ('openai','anthropic','openrouter')
    AND (model.selection->>'providerRef'<>'openrouter' OR model.selection->>'modelRef' ~ '^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:-]*$') AND model.selection->>'credentialCustody'='platform_vault'
    AND model.selection->>'engineLocation'='platform' AND model.selection->>'billingSource'='user_byok'
    AND model.selection->>'processingLocation'='provider_remote' AND model.selection->>'artifactCustody'='platform_asset',false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Current exact ingest backing/custody required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT * FROM %I.broker_model_credentials WHERE model_connection_id=$1',TG_TABLE_SCHEMA) INTO existing USING model.model_connection_id;
  IF existing.credential_id IS NOT NULL AND (existing.credential_id IS DISTINCT FROM NEW.submitted_credential_id
    OR existing.binding IS DISTINCT FROM NEW.submitted_binding OR existing.state IS DISTINCT FROM 'active' OR existing.expires_at<=clock_timestamp()) THEN
    RAISE EXCEPTION 'Target model lifetime is already occupied' USING ERRCODE='23514'; END IF;
  expected_metadata=jsonb_build_object('modelConnectionId',model.model_connection_id::text,'connectionId',model.connection_id::text,
    'runtimeDeviceId',model.runtime_device_id::text,'familyId',model.family_id::text,'environment',model.environment,'clientId',model.client_id,
    'selection',model.selection,'state',model.state,'aggregateVersion',model.aggregate_version::text,
    'createdAt',to_char(model.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'operational_authority',false);
  IF NEW.model_metadata IS DISTINCT FROM expected_metadata THEN RAISE EXCEPTION 'Exact safe model metadata required' USING ERRCODE='23514'; END IF;
  IF NEW.operation='create' THEN
    expected_command=jsonb_build_object('operation','create','input',jsonb_build_object('key',NEW.command_key,
      'modelConnectionId',NEW.model_connection_id::text,'expectedModelVersion',NEW.model_version::text,'consent',true));
  ELSE
    EXECUTE format('SELECT * FROM %I.broker_model_credentials WHERE credential_id=$1',TG_TABLE_SCHEMA) INTO old_credential USING NEW.old_credential_id;
    IF old_credential.credential_id IS NULL OR old_credential.generation<>NEW.old_credential_generation
      OR old_credential.model_connection_id<>NEW.old_model_connection_id OR old_credential.model_version<>NEW.old_model_version
      OR ROW(old_credential.owner_user_id,old_credential.owner_principal_id,old_credential.scope_id,old_credential.environment,old_credential.client_id)
        IS DISTINCT FROM ROW(NEW.owner_user_id,NEW.owner_principal_id,NEW.scope_id,NEW.environment,NEW.client_id)
      OR (NEW.committed_at IS NULL AND (old_credential.state<>'active' OR old_credential.aggregate_version<>NEW.old_credential_version))
      OR (NEW.committed_at IS NOT NULL AND (old_credential.state<>'rotated' OR old_credential.aggregate_version<>NEW.old_credential_version+1
        OR old_credential.replacement_credential_id<>NEW.submitted_credential_id)) THEN
      RAISE EXCEPTION 'Exact original/replacement credential required' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT * FROM %I.model_connections WHERE model_connection_id=$1',TG_TABLE_SCHEMA) INTO old_model USING NEW.old_model_connection_id;
    EXECUTE format('SELECT * FROM %I.runtime_registrations WHERE runtime_device_id=$1',TG_TABLE_SCHEMA) INTO runtime USING old_credential.runtime_device_id;
    EXECUTE format('SELECT * FROM %I.agent_connections WHERE connection_id=$1',TG_TABLE_SCHEMA) INTO connection USING old_credential.connection_id;
    EXECUTE format('SELECT * FROM %I.bootstrap_refresh_families WHERE family_id=$1',TG_TABLE_SCHEMA) INTO family USING old_credential.family_id;
    IF COALESCE(old_credential.recovery_generation=NEW.recovery_generation AND old_credential.expires_at>=NEW.expires_at
      AND runtime.state='enrolled' AND runtime.enrolled_at<=clock_timestamp() AND connection.state='active'
      AND connection.issued_at<=clock_timestamp() AND connection.expires_at>=NEW.expires_at AND family.state='active'
      AND family.connection_id=old_credential.connection_id AND family.issued_at<=clock_timestamp() AND family.expires_at>=NEW.expires_at
      AND old_model.selection=old_credential.selection AND old_model.runtime_device_id=old_credential.runtime_device_id
      AND old_model.connection_id=old_credential.connection_id AND old_model.family_id=old_credential.family_id
      AND ((NEW.committed_at IS NULL AND old_model.state='unverified' AND old_model.aggregate_version=NEW.old_model_version)
        OR (NEW.committed_at IS NOT NULL AND old_model.state='revoked' AND old_model.aggregate_version=NEW.old_model_version+1)),false) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Exact current rotation backing required' USING ERRCODE='23514'; END IF;
    expected_command=jsonb_build_object('operation','rotate','input',jsonb_build_object('key',NEW.command_key,
      'credentialId',NEW.old_credential_id::text,'expectedVersion',NEW.old_credential_version::text,
      'replacementModelConnectionId',NEW.model_connection_id::text,'expectedReplacementModelVersion',NEW.model_version::text,'consent',true));
  END IF;
  IF NEW.command IS DISTINCT FROM expected_command OR NEW.nonce_hash IS DISTINCT FROM encode(sha256(convert_to(NEW.assertion->>'nonce','UTF8')),'hex') THEN
    RAISE EXCEPTION 'Exact typed command and nonce required' USING ERRCODE='23514'; END IF;
  IF NEW.assertion-ARRAY['issuer','audience','nonce','setupOrigin'] IS DISTINCT FROM jsonb_build_object('profile','credential-ingest.bootstrap/v1',
    'purpose','credential-broker.ingest-bootstrap','operation',NEW.operation,'environment',NEW.environment,'clientId',NEW.client_id,
    'authorizationRef',NEW.authorization_id::text,'commandDigest',NEW.command_digest,'recoveryGeneration',NEW.recovery_generation::text,
    'issuedAt',to_char(NEW.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt',to_char(NEW.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) THEN
    RAISE EXCEPTION 'Exact bootstrap assertion required' USING ERRCODE='23514'; END IF;
  IF NEW.submission_claimed_at IS NOT NULL THEN
    IF NEW.submitted_binding-ARRAY['issuedAt','expiresAt'] IS DISTINCT FROM jsonb_build_object(
      'profile','model-credential.binding/v1','credentialId',NEW.submitted_credential_id::text,
      'generation',(CASE WHEN NEW.operation='create' THEN 1 ELSE NEW.old_credential_generation+1 END)::text,
      'modelConnectionId',NEW.model_connection_id::text,'modelVersion',NEW.model_version::text,
      'ownerUserId',NEW.owner_user_id::text,'ownerPrincipalId',NEW.owner_principal_id::text,'scopeId',NEW.scope_id::text,
      'environment',NEW.environment,'clientId',NEW.client_id,'runtimeDeviceId',model.runtime_device_id::text,
      'connectionId',model.connection_id::text,'familyId',model.family_id::text,'selection',model.selection,
      'recoveryGeneration',NEW.recovery_generation::text)
      OR jsonb_typeof(NEW.submitted_binding->'issuedAt') IS DISTINCT FROM 'string'
      OR jsonb_typeof(NEW.submitted_binding->'expiresAt') IS DISTINCT FROM 'string'
      OR COALESCE((NEW.submitted_binding->>'issuedAt')::timestamptz<=NEW.submission_claimed_at
        AND NEW.write_expires_at<=(NEW.submitted_binding->>'issuedAt')::timestamptz+interval '30 seconds'
        AND NEW.write_expires_at<=(NEW.submitted_binding->>'expiresAt')::timestamptz,false) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Exact submitted intent binding required' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

