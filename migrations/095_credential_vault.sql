-- Temporary numeric ID: the current migration scanner still requires NNN_.
-- Ciphertext is broker-only. Ordinary roles receive metadata SELECT at most.
-- A structural row is not sealed provenance, model readiness or execution authority.
CREATE TABLE broker_model_credentials (
  credential_id uuid PRIMARY KEY,
  model_connection_id uuid NOT NULL UNIQUE,
  model_version bigint NOT NULL CHECK(model_version>0),
  generation bigint NOT NULL CHECK(generation>0),
  owner_user_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  runtime_device_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  family_id uuid NOT NULL,
  environment text NOT NULL,
  client_id text NOT NULL,
  selection jsonb NOT NULL,
  recovery_generation bigint NOT NULL CHECK(recovery_generation>0),
  binding jsonb NOT NULL CHECK(jsonb_typeof(binding)='object' AND octet_length(binding::text)<=8192),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','rotated','revoked')),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0),
  terminal_at timestamptz,
  replacement_credential_id uuid REFERENCES broker_model_credentials(credential_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK(isfinite(issued_at) AND issued_at=date_trunc('milliseconds',issued_at)),
  CHECK(isfinite(expires_at) AND expires_at=date_trunc('milliseconds',expires_at)
    AND expires_at>issued_at AND expires_at<=issued_at+interval '1 hour'),
  CHECK((state='active' AND terminal_at IS NULL AND replacement_credential_id IS NULL AND aggregate_version=1)
    OR (state IN ('rotated','revoked') AND terminal_at IS NOT NULL AND isfinite(terminal_at)
      AND terminal_at=date_trunc('milliseconds',terminal_at) AND terminal_at>=issued_at AND aggregate_version=2
      AND ((state='rotated' AND replacement_credential_id IS NOT NULL AND replacement_credential_id<>credential_id)
        OR (state='revoked' AND replacement_credential_id IS NULL)))),
  FOREIGN KEY(model_connection_id,runtime_device_id,connection_id,family_id,owner_user_id,owner_principal_id,scope_id,environment,client_id)
    REFERENCES model_connections(model_connection_id,runtime_device_id,connection_id,family_id,owner_user_id,owner_principal_id,scope_id,environment,client_id)
);
CREATE INDEX broker_model_credentials_owner ON broker_model_credentials(owner_principal_id,environment,credential_id);

CREATE TABLE broker_credential_vault (
  credential_id uuid PRIMARY KEY REFERENCES broker_model_credentials(credential_id),
  envelope jsonb NOT NULL CHECK(COALESCE(jsonb_typeof(envelope)='object' AND octet_length(envelope::text)<=8192
    AND envelope ?& ARRAY['profile','keyId','nonce','wrapNonce','ciphertext','wrappedDek']
    AND envelope-ARRAY['profile','keyId','nonce','wrapNonce','ciphertext','wrappedDek']='{}'::jsonb
    AND jsonb_typeof(envelope->'profile')='string' AND envelope->>'profile'='broker-credential.envelope/v1'
    AND jsonb_typeof(envelope->'keyId')='string' AND length(envelope->>'keyId') BETWEEN 1 AND 96
    AND envelope->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    AND jsonb_typeof(envelope->'nonce')='string' AND envelope->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
    AND jsonb_typeof(envelope->'wrapNonce')='string' AND envelope->>'wrapNonce' ~ '^[A-Za-z0-9_-]{16}$'
    AND jsonb_typeof(envelope->'ciphertext')='string' AND length(envelope->>'ciphertext') BETWEEN 23 AND 5483
    AND envelope->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
    AND jsonb_typeof(envelope->'wrappedDek')='string' AND envelope->>'wrappedDek' ~ '^[A-Za-z0-9_-]{64}$',false))
);
REVOKE ALL ON broker_credential_vault,broker_model_credentials FROM PUBLIC;

CREATE FUNCTION preserve_broker_credential() RETURNS trigger LANGUAGE plpgsql AS $$
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
    OR NEW.selection->>'providerRef' NOT IN ('openai','anthropic')
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
CREATE TRIGGER preserve_broker_credential BEFORE INSERT OR UPDATE OR DELETE ON broker_model_credentials FOR EACH ROW EXECUTE FUNCTION preserve_broker_credential();

CREATE FUNCTION preserve_broker_ciphertext() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Broker ciphertext is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_broker_ciphertext BEFORE UPDATE OR DELETE ON broker_credential_vault FOR EACH ROW EXECUTE FUNCTION preserve_broker_ciphertext();

CREATE FUNCTION check_broker_credential_whole_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_row record; model record; replacement record; connection record; family record; sealed boolean;
BEGIN
  EXECUTE format('SELECT * FROM %I.broker_model_credentials WHERE credential_id=$1',TG_TABLE_SCHEMA) INTO current_row USING NEW.credential_id;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.broker_credential_vault WHERE credential_id=$1)',TG_TABLE_SCHEMA) INTO sealed USING NEW.credential_id;
  EXECUTE format('SELECT * FROM %I.model_connections WHERE model_connection_id=$1',TG_TABLE_SCHEMA) INTO model USING current_row.model_connection_id;
  IF sealed IS DISTINCT FROM true THEN RAISE EXCEPTION 'Credential requires sealed ciphertext' USING ERRCODE='23514'; END IF;
  IF current_row.state='active' THEN
    EXECUTE format('SELECT * FROM %I.agent_connections WHERE connection_id=$1',TG_TABLE_SCHEMA) INTO connection USING current_row.connection_id;
    EXECUTE format('SELECT * FROM %I.bootstrap_refresh_families WHERE family_id=$1',TG_TABLE_SCHEMA) INTO family USING current_row.family_id;
    IF model.state<>'unverified' OR model.aggregate_version<>current_row.model_version OR connection.state<>'active' OR family.state<>'active'
      OR current_row.expires_at<=clock_timestamp() OR connection.expires_at<=clock_timestamp() OR family.expires_at<=clock_timestamp()
      OR (TG_OP='INSERT' AND current_row.issued_at+interval '30 seconds'<=clock_timestamp()) THEN
      RAISE EXCEPTION 'Fresh current credential commit required' USING ERRCODE='23514'; END IF;
  END IF;
  IF current_row.state<>'active' THEN
    IF model.state<>'revoked' OR model.aggregate_version::numeric<>current_row.model_version::numeric+1 THEN
      RAISE EXCEPTION 'Credential termination must revoke original model binding' USING ERRCODE='23514'; END IF;
    IF current_row.state='rotated' THEN
      EXECUTE format('SELECT * FROM %I.broker_model_credentials WHERE credential_id=$1',TG_TABLE_SCHEMA) INTO replacement USING current_row.replacement_credential_id;
      IF replacement.credential_id IS NULL OR replacement.model_connection_id=current_row.model_connection_id
        OR replacement.generation::numeric<>current_row.generation::numeric+1
        OR ROW(replacement.owner_user_id,replacement.owner_principal_id,replacement.scope_id,replacement.environment,replacement.client_id)
          IS DISTINCT FROM ROW(current_row.owner_user_id,current_row.owner_principal_id,current_row.scope_id,current_row.environment,current_row.client_id) THEN
        RAISE EXCEPTION 'Rotation requires a distinct replacement owner binding' USING ERRCODE='23514'; END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_broker_credential_whole_state AFTER INSERT OR UPDATE ON broker_model_credentials DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_broker_credential_whole_state();
