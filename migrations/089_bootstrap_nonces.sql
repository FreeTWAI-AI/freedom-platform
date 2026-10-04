-- Single-use bootstrap status admission, never an execution authorization.
CREATE TABLE bootstrap_nonces (
  nonce_id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES agent_connections(connection_id),
  runtime_device_id uuid NOT NULL REFERENCES runtime_registrations(runtime_device_id),
  owner_user_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  scope_kind text GENERATED ALWAYS AS ('personal'::text) STORED,
  environment text NOT NULL CHECK(environment IN ('local','staging-next','next')),
  client_id text NOT NULL CHECK(length(client_id) BETWEEN 1 AND 64 AND client_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
  connection_version bigint NOT NULL CHECK(connection_version>0),
  challenge_key text NOT NULL CHECK(challenge_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  nonce text NOT NULL CHECK(nonce ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '60 seconds'),
  consumed_at timestamptz,
  proof_jti text CHECK(length(proof_jti) BETWEEN 16 AND 128 AND proof_jti ~ '^[A-Za-z0-9_-]+$'),
  token_jti text CHECK(length(token_jti) BETWEEN 16 AND 128 AND token_jti ~ '^[A-Za-z0-9_-]+$'),
  CHECK((consumed_at IS NULL AND proof_jti IS NULL AND token_jti IS NULL)
    OR (consumed_at IS NOT NULL AND proof_jti IS NOT NULL AND token_jti IS NOT NULL
      AND consumed_at>=issued_at AND consumed_at<expires_at)),
  UNIQUE(connection_id,challenge_key),
  UNIQUE(runtime_device_id,proof_jti),
  FOREIGN KEY(owner_principal_id,owner_user_id) REFERENCES principals(principal_id,user_ref),
  FOREIGN KEY(scope_id,scope_kind,owner_principal_id) REFERENCES resource_scopes(scope_id,kind,owner_principal_id)
);
CREATE INDEX bootstrap_nonce_capacity ON bootstrap_nonces(connection_id,expires_at) WHERE consumed_at IS NULL;

CREATE FUNCTION preserve_bootstrap_nonce() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE runtime record; connection record;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Bootstrap admission history cannot be deleted' USING ERRCODE='23514';
  END IF;
  -- Physical schema, invoker privileges. Never trust TEMP backing tables.
  EXECUTE format('SELECT * FROM %I.runtime_registrations WHERE runtime_device_id=$1 FOR SHARE',TG_TABLE_SCHEMA)
    INTO runtime USING NEW.runtime_device_id;
  EXECUTE format('SELECT * FROM %I.agent_connections WHERE connection_id=$1 FOR SHARE',TG_TABLE_SCHEMA)
    INTO connection USING NEW.connection_id;
  IF runtime.runtime_device_id IS NULL OR connection.connection_id IS NULL
    OR runtime.state<>'enrolled' OR connection.state<>'active'
    OR ROW(NEW.runtime_device_id,NEW.owner_user_id,NEW.owner_principal_id,NEW.scope_id,NEW.environment)
      IS DISTINCT FROM ROW(runtime.runtime_device_id,runtime.owner_user_id,runtime.owner_principal_id,runtime.scope_id,runtime.environment)
    OR ROW(NEW.runtime_device_id,NEW.owner_user_id,NEW.owner_principal_id,NEW.scope_id,NEW.environment,NEW.client_id,NEW.connection_version)
      IS DISTINCT FROM ROW(connection.runtime_device_id,connection.owner_user_id,connection.owner_principal_id,connection.scope_id,connection.environment,connection.client_id,connection.aggregate_version)
    OR NEW.issued_at<connection.issued_at OR NEW.expires_at>connection.expires_at
    OR NOT isfinite(NEW.issued_at) OR NEW.issued_at<>date_trunc('milliseconds',NEW.issued_at)
    OR NEW.expires_at<>date_trunc('milliseconds',NEW.expires_at)
    OR NEW.issued_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Bootstrap nonce requires its current connection and runtime' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.consumed_at IS NOT NULL OR NEW.proof_jti IS NOT NULL OR NEW.token_jti IS NOT NULL THEN
      RAISE EXCEPTION 'Bootstrap nonce must start pending' USING ERRCODE='23514';
    END IF;
  ELSIF (to_jsonb(NEW)-ARRAY['consumed_at','proof_jti','token_jti','scope_kind'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['consumed_at','proof_jti','token_jti','scope_kind'])
    OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
    OR NEW.proof_jti IS NULL OR NEW.token_jti IS NULL
    OR NEW.consumed_at<>date_trunc('milliseconds',NEW.consumed_at) OR NEW.consumed_at>clock_timestamp() THEN
    RAISE EXCEPTION 'Bootstrap nonce identity is immutable and consumption is one-time' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_bootstrap_nonce BEFORE INSERT OR UPDATE OR DELETE ON bootstrap_nonces
  FOR EACH ROW EXECUTE FUNCTION preserve_bootstrap_nonce();

CREATE FUNCTION check_bootstrap_nonce_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- BEFORE runs before a possible unique-index wait; final success must be fresh.
  IF NEW.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Bootstrap nonce expired before storage completed' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER check_bootstrap_nonce_clock AFTER INSERT OR UPDATE ON bootstrap_nonces
  FOR EACH ROW EXECUTE FUNCTION check_bootstrap_nonce_clock();
