-- Closed member-approved public-key enrollment. No credential or execution authority.
CREATE TABLE runtime_registration_challenges (
  challenge_id uuid PRIMARY KEY,
  runtime_device_id uuid NOT NULL UNIQUE,
  owner_user_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  scope_kind text GENERATED ALWAYS AS ('personal'::text) STORED,
  environment text NOT NULL CHECK(environment IN ('local','staging-next','next')),
  begin_key text NOT NULL CHECK(begin_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  public_jwk jsonb NOT NULL CHECK(COALESCE(jsonb_typeof(public_jwk)='object' AND public_jwk->>'kty'='EC' AND public_jwk->>'crv'='P-256'
    AND jsonb_typeof(public_jwk->'x')='string' AND jsonb_typeof(public_jwk->'y')='string'
    AND public_jwk->>'x' ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$' AND public_jwk->>'y' ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
    AND public_jwk ?& ARRAY['kty','crv','x','y'] AND public_jwk - ARRAY['kty','crv','x','y'] = '{}'::jsonb,false)),
  key_thumbprint text NOT NULL CHECK(key_thumbprint ~ '^[A-Za-z0-9_-]{43}$'),
  nonce text NOT NULL CHECK(nonce ~ '^[A-Za-z0-9_-]{43}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at=issued_at+interval '300 seconds'),
  consumed_at timestamptz,
  CHECK(consumed_at IS NULL OR (consumed_at>=issued_at AND consumed_at<expires_at)),
  UNIQUE(owner_principal_id,environment,begin_key),
  FOREIGN KEY(owner_principal_id,owner_user_id) REFERENCES principals(principal_id,user_ref),
  FOREIGN KEY(scope_id,scope_kind,owner_principal_id) REFERENCES resource_scopes(scope_id,kind,owner_principal_id)
);
CREATE INDEX runtime_challenges_owner ON runtime_registration_challenges(owner_principal_id,environment,issued_at);

CREATE TABLE runtime_registrations (
  runtime_device_id uuid PRIMARY KEY,
  challenge_id uuid NOT NULL UNIQUE REFERENCES runtime_registration_challenges(challenge_id),
  owner_user_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  scope_kind text GENERATED ALWAYS AS ('personal'::text) STORED,
  environment text NOT NULL CHECK(environment IN ('local','staging-next','next')),
  public_jwk jsonb NOT NULL,
  key_thumbprint text NOT NULL CHECK(key_thumbprint ~ '^[A-Za-z0-9_-]{43}$'),
  state text NOT NULL DEFAULT 'enrolled' CHECK(state IN ('enrolled','revoked')),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0),
  enrolled_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK((state='enrolled' AND revoked_at IS NULL) OR (state='revoked' AND revoked_at>=enrolled_at)),
  UNIQUE(environment,key_thumbprint),
  FOREIGN KEY(owner_principal_id,owner_user_id) REFERENCES principals(principal_id,user_ref),
  FOREIGN KEY(scope_id,scope_kind,owner_principal_id) REFERENCES resource_scopes(scope_id,kind,owner_principal_id)
);
CREATE INDEX runtime_registrations_owner ON runtime_registrations(owner_principal_id,environment,runtime_device_id);

CREATE FUNCTION preserve_runtime_challenge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Enrollment history cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.consumed_at IS NOT NULL OR NEW.issued_at<>date_trunc('milliseconds',NEW.issued_at) THEN
      RAISE EXCEPTION 'Challenge must start unconsumed with millisecond time' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['consumed_at','scope_kind']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['consumed_at','scope_kind'])
    OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
    OR NEW.consumed_at>clock_timestamp() OR clock_timestamp()>=OLD.expires_at THEN
    RAISE EXCEPTION 'Challenge identity is immutable and consume is one-time before expiry' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_runtime_challenge BEFORE INSERT OR UPDATE OR DELETE ON runtime_registration_challenges
  FOR EACH ROW EXECUTE FUNCTION preserve_runtime_challenge();

CREATE FUNCTION preserve_runtime_registration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE challenge record;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Registration tombstones cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    -- Always use the physical schema, never a caller's TEMP/search_path shadow.
    EXECUTE format('SELECT * FROM %I.runtime_registration_challenges WHERE challenge_id=$1 FOR SHARE',TG_TABLE_SCHEMA)
      INTO challenge USING NEW.challenge_id;
    IF challenge.challenge_id IS NULL OR challenge.consumed_at IS NULL
      OR ROW(NEW.runtime_device_id,NEW.owner_user_id,NEW.owner_principal_id,NEW.scope_id,NEW.environment,NEW.public_jwk,NEW.key_thumbprint,NEW.enrolled_at)
      IS DISTINCT FROM ROW(challenge.runtime_device_id,challenge.owner_user_id,challenge.owner_principal_id,challenge.scope_id,challenge.environment,challenge.public_jwk,challenge.key_thumbprint,challenge.consumed_at)
      OR NEW.state<>'enrolled' OR NEW.aggregate_version<>1 OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'Registration requires its consumed immutable challenge' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['state','aggregate_version','revoked_at','scope_kind']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','aggregate_version','revoked_at','scope_kind'])
    OR OLD.state<>'enrolled' OR NEW.state<>'revoked' OR NEW.aggregate_version::numeric<>OLD.aggregate_version::numeric+1
    OR NEW.revoked_at IS NULL OR NEW.revoked_at>clock_timestamp() THEN
    RAISE EXCEPTION 'Registration identity is immutable and revocation is terminal' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_runtime_registration BEFORE INSERT OR UPDATE OR DELETE ON runtime_registrations
  FOR EACH ROW EXECUTE FUNCTION preserve_runtime_registration();
