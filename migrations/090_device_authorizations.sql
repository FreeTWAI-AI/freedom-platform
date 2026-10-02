-- Closed fresh-device pairing. Hashes and public proof bindings, never tokens.
CREATE TABLE device_authorizations (
  authorization_id uuid PRIMARY KEY,
  environment text NOT NULL CHECK(environment IN ('local','staging-next','next')),
  client_id text NOT NULL CHECK(client_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  client_display_name text NOT NULL CHECK(length(client_display_name) BETWEEN 1 AND 128 AND client_display_name !~ '[[:cntrl:]]'),
  runtime_kind text NOT NULL CHECK(runtime_kind IN ('agent-kit','extension','neo')),
  public_jwk jsonb NOT NULL,
  key_thumbprint text NOT NULL CHECK(key_thumbprint ~ '^[A-Za-z0-9_-]{43}$'),
  begin_jti text NOT NULL CHECK(begin_jti ~ '^[A-Za-z0-9_-]{16,128}$'),
  device_code_hash text NOT NULL UNIQUE CHECK(device_code_hash ~ '^[0-9a-f]{64}$'),
  device_code_wire_hash text NOT NULL CHECK(device_code_wire_hash ~ '^[A-Za-z0-9_-]{43}$'),
  user_code_hash text NOT NULL UNIQUE CHECK(user_code_hash ~ '^[0-9a-f]{64}$'),
  nonce text NOT NULL CHECK(nonce ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  request_digest text NOT NULL CHECK(request_digest ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at=issued_at+interval '300 seconds'),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','denied','consumed')),
  owner_user_id uuid,
  owner_principal_id uuid,
  scope_id uuid,
  scope_kind text GENERATED ALWAYS AS ('personal'::text) STORED,
  challenge_id uuid UNIQUE REFERENCES runtime_registration_challenges(challenge_id),
  decided_at timestamptz,
  consumed_at timestamptz,
  connection_id uuid UNIQUE REFERENCES agent_connections(connection_id),
  bootstrap_nonce_id uuid UNIQUE REFERENCES bootstrap_nonces(nonce_id),
  token_jti text CHECK(token_jti ~ '^[A-Za-z0-9_-]{16,128}$'),
  poll_interval integer NOT NULL DEFAULT 5 CHECK(poll_interval BETWEEN 5 AND 325 AND poll_interval%5=0),
  last_poll_at timestamptz,
  UNIQUE(environment,key_thumbprint,begin_jti),
  FOREIGN KEY(owner_principal_id,owner_user_id) REFERENCES principals(principal_id,user_ref),
  FOREIGN KEY(scope_id,scope_kind,owner_principal_id) REFERENCES resource_scopes(scope_id,kind,owner_principal_id),
  CHECK((state='pending' AND owner_user_id IS NULL AND owner_principal_id IS NULL AND scope_id IS NULL AND decided_at IS NULL AND challenge_id IS NULL)
    OR (state IN ('approved','denied','consumed') AND owner_user_id IS NOT NULL AND owner_principal_id IS NOT NULL AND scope_id IS NOT NULL
      AND decided_at>=issued_at AND decided_at<expires_at AND ((state='denied' AND challenge_id IS NULL) OR (state<>'denied' AND challenge_id IS NOT NULL)))),
  CHECK((state='consumed' AND consumed_at>=decided_at AND consumed_at<expires_at AND connection_id IS NOT NULL AND bootstrap_nonce_id IS NOT NULL AND token_jti IS NOT NULL)
    OR (state<>'consumed' AND consumed_at IS NULL AND connection_id IS NULL AND bootstrap_nonce_id IS NULL AND token_jti IS NULL))
);
CREATE INDEX device_authorizations_capacity ON device_authorizations(environment,key_thumbprint,expires_at);

CREATE TABLE device_poll_proofs (
  authorization_id uuid NOT NULL REFERENCES device_authorizations(authorization_id),
  proof_jti text NOT NULL CHECK(proof_jti ~ '^[A-Za-z0-9_-]{16,128}$'),
  accepted_at timestamptz NOT NULL,
  exchange_challenge_id uuid UNIQUE REFERENCES runtime_registration_challenges(challenge_id),
  PRIMARY KEY(authorization_id,proof_jti)
);
CREATE TABLE device_review_buckets (
  owner_principal_id uuid NOT NULL REFERENCES principals(principal_id),
  environment text NOT NULL CHECK(environment IN ('local','staging-next','next')),
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK(attempts BETWEEN 1 AND 10),
  PRIMARY KEY(owner_principal_id,environment)
);

CREATE FUNCTION preserve_device_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE challenge record; connection record; nonce record;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Device authorization history is retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'pending' OR NEW.last_poll_at IS NOT NULL OR NEW.poll_interval<>5
      OR NOT isfinite(NEW.issued_at) OR NEW.issued_at<>date_trunc('milliseconds',NEW.issued_at)
      OR NEW.issued_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp()
      OR NOT COALESCE(jsonb_typeof(NEW.public_jwk)='object' AND NEW.public_jwk->>'kty'='EC' AND NEW.public_jwk->>'crv'='P-256'
        AND jsonb_typeof(NEW.public_jwk->'x')='string' AND jsonb_typeof(NEW.public_jwk->'y')='string'
        AND NEW.public_jwk->>'x' ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$' AND NEW.public_jwk->>'y' ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
        AND NEW.public_jwk ?& ARRAY['kty','crv','x','y'] AND NEW.public_jwk-ARRAY['kty','crv','x','y']='{}'::jsonb,false) THEN
      RAISE EXCEPTION 'Invalid initial device authorization' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['state','owner_user_id','owner_principal_id','scope_id','scope_kind','challenge_id','decided_at','consumed_at','connection_id','bootstrap_nonce_id','token_jti','poll_interval','last_poll_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','owner_user_id','owner_principal_id','scope_id','scope_kind','challenge_id','decided_at','consumed_at','connection_id','bootstrap_nonce_id','token_jti','poll_interval','last_poll_at'])
    OR (OLD.state<>'pending' AND ROW(NEW.owner_user_id,NEW.owner_principal_id,NEW.scope_id,NEW.challenge_id,NEW.decided_at)
      IS DISTINCT FROM ROW(OLD.owner_user_id,OLD.owner_principal_id,OLD.scope_id,OLD.challenge_id,OLD.decided_at))
    OR NOT (NEW.state=OLD.state OR (OLD.state='pending' AND NEW.state IN ('approved','denied')) OR (OLD.state='approved' AND NEW.state='consumed'))
    OR (OLD.state='consumed' AND ROW(NEW.consumed_at,NEW.connection_id,NEW.bootstrap_nonce_id,NEW.token_jti)
      IS DISTINCT FROM ROW(OLD.consumed_at,OLD.connection_id,OLD.bootstrap_nonce_id,OLD.token_jti))
    OR NEW.poll_interval<OLD.poll_interval OR NEW.poll_interval>OLD.poll_interval+5
    OR (NEW.last_poll_at IS DISTINCT FROM OLD.last_poll_at AND (NEW.last_poll_at IS NULL OR NOT isfinite(NEW.last_poll_at)
      OR NEW.last_poll_at<>date_trunc('milliseconds',NEW.last_poll_at) OR NEW.last_poll_at<NEW.issued_at
      OR NEW.last_poll_at>clock_timestamp() OR NEW.last_poll_at<OLD.last_poll_at)) THEN
    RAISE EXCEPTION 'Device binding is immutable and transitions are terminal' USING ERRCODE='23514';
  END IF;
  IF OLD.state<>NEW.state THEN
    IF clock_timestamp()>=NEW.expires_at OR NEW.decided_at>clock_timestamp() THEN
      RAISE EXCEPTION 'Device decision expired' USING ERRCODE='23514';
    END IF;
    IF NEW.state IN ('approved','consumed') THEN
      EXECUTE format('SELECT * FROM %I.runtime_registration_challenges WHERE challenge_id=$1 FOR SHARE',TG_TABLE_SCHEMA)
        INTO challenge USING NEW.challenge_id;
      IF challenge.challenge_id IS NULL OR ROW(NEW.owner_user_id,NEW.owner_principal_id,NEW.scope_id,NEW.environment,NEW.public_jwk,NEW.key_thumbprint)
        IS DISTINCT FROM ROW(challenge.owner_user_id,challenge.owner_principal_id,challenge.scope_id,challenge.environment,challenge.public_jwk,challenge.key_thumbprint)
        OR (NEW.state='approved' AND challenge.consumed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Device approval requires actual bound enrollment challenge' USING ERRCODE='23514';
      END IF;
    END IF;
    IF NEW.state='consumed' THEN
      EXECUTE format('SELECT * FROM %I.agent_connections WHERE connection_id=$1 FOR SHARE',TG_TABLE_SCHEMA) INTO connection USING NEW.connection_id;
      EXECUTE format('SELECT * FROM %I.bootstrap_nonces WHERE nonce_id=$1 FOR SHARE',TG_TABLE_SCHEMA) INTO nonce USING NEW.bootstrap_nonce_id;
      IF connection.connection_id IS NULL OR nonce.nonce_id IS NULL OR challenge.consumed_at IS NULL
        OR connection.runtime_device_id IS DISTINCT FROM challenge.runtime_device_id
        OR ROW(NEW.owner_user_id,NEW.owner_principal_id,NEW.scope_id,NEW.environment,NEW.client_id)
          IS DISTINCT FROM ROW(connection.owner_user_id,connection.owner_principal_id,connection.scope_id,connection.environment,connection.client_id)
        OR nonce.connection_id IS DISTINCT FROM NEW.connection_id OR connection.state<>'active'
        OR NEW.consumed_at>clock_timestamp() OR NEW.consumed_at<>date_trunc('milliseconds',NEW.consumed_at) THEN
        RAISE EXCEPTION 'Device exchange requires actual bound connection and nonce' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_device_authorization BEFORE INSERT OR UPDATE OR DELETE ON device_authorizations
  FOR EACH ROW EXECUTE FUNCTION preserve_device_authorization();

CREATE FUNCTION check_device_authorization_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP='INSERT' OR NEW.state IS DISTINCT FROM OLD.state) AND NEW.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Device authorization expired during storage' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER check_device_authorization_clock AFTER INSERT OR UPDATE ON device_authorizations
  FOR EACH ROW EXECUTE FUNCTION check_device_authorization_clock();

CREATE FUNCTION preserve_device_poll_proof() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' OR NOT isfinite(NEW.accepted_at) OR NEW.accepted_at<>date_trunc('milliseconds',NEW.accepted_at)
    OR NEW.accepted_at>clock_timestamp() THEN
    RAISE EXCEPTION 'Device poll proof ledger is append-only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_device_poll_proof BEFORE INSERT OR UPDATE OR DELETE ON device_poll_proofs
  FOR EACH ROW EXECUTE FUNCTION preserve_device_poll_proof();

-- A linked enrollment challenge belongs to this exchange, not the older member
-- confirm entry point. No GUC/caller assertion authorizes consuming it. The
-- marker is an actual verified-poll fact and cannot commit without the exchange.
CREATE FUNCTION guard_device_enrollment_consume() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE auth_row record; marked boolean;
BEGIN
  IF OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL THEN
    EXECUTE format('SELECT * FROM %I.device_authorizations WHERE challenge_id=$1 FOR SHARE',TG_TABLE_SCHEMA)
      INTO auth_row USING NEW.challenge_id;
    IF auth_row.authorization_id IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.device_poll_proofs WHERE authorization_id=$1 AND exchange_challenge_id=$2)',TG_TABLE_SCHEMA)
        INTO marked USING auth_row.authorization_id,NEW.challenge_id;
      IF auth_row.state<>'approved' OR auth_row.expires_at<=clock_timestamp() OR NOT marked THEN
        RAISE EXCEPTION 'Linked enrollment requires its live device exchange' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_device_enrollment_consume BEFORE UPDATE ON runtime_registration_challenges
  FOR EACH ROW EXECUTE FUNCTION guard_device_enrollment_consume();

CREATE FUNCTION require_completed_device_exchange() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE auth_row record; challenge record;
BEGIN
  IF NEW.exchange_challenge_id IS NOT NULL THEN
    EXECUTE format('SELECT * FROM %I.device_authorizations WHERE authorization_id=$1',TG_TABLE_SCHEMA)
      INTO auth_row USING NEW.authorization_id;
    EXECUTE format('SELECT * FROM %I.runtime_registration_challenges WHERE challenge_id=$1',TG_TABLE_SCHEMA)
      INTO challenge USING NEW.exchange_challenge_id;
    IF auth_row.authorization_id IS NULL OR auth_row.state<>'consumed'
      OR auth_row.challenge_id IS DISTINCT FROM NEW.exchange_challenge_id OR challenge.consumed_at IS NULL THEN
      RAISE EXCEPTION 'Exchange proof cannot commit without complete exchange' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER require_completed_device_exchange AFTER INSERT ON device_poll_proofs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_completed_device_exchange();

CREATE FUNCTION preserve_device_review_bucket() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Review buckets are retained' USING ERRCODE='23514'; END IF;
  IF NOT isfinite(NEW.window_start) OR NEW.window_start<>date_trunc('milliseconds',NEW.window_start) OR NEW.window_start>clock_timestamp()
    OR (TG_OP='INSERT' AND NEW.attempts<>1) THEN
    RAISE EXCEPTION 'Invalid review bucket' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (ROW(NEW.owner_principal_id,NEW.environment) IS DISTINCT FROM ROW(OLD.owner_principal_id,OLD.environment)
    OR NOT ((NEW.window_start=OLD.window_start AND NEW.attempts=OLD.attempts+1)
      OR (NEW.window_start>=OLD.window_start+interval '60 seconds' AND NEW.attempts=1))) THEN
    RAISE EXCEPTION 'Review bucket cannot reset early or change owner' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_device_review_bucket BEFORE INSERT OR UPDATE OR DELETE ON device_review_buckets
  FOR EACH ROW EXECUTE FUNCTION preserve_device_review_bucket();
