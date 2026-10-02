-- Retained refresh chains and purpose-bound proof admission, never raw secrets.
CREATE TABLE bootstrap_refresh_families (
  family_id uuid PRIMARY KEY,
  connection_id uuid NOT NULL UNIQUE REFERENCES agent_connections(connection_id),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  current_generation bigint NOT NULL DEFAULT 1 CHECK(current_generation BETWEEN 1 AND 4096),
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
  revoked_at timestamptz,
  revocation_reason text,
  CHECK(isfinite(issued_at) AND issued_at=date_trunc('milliseconds',issued_at)),
  CHECK(isfinite(expires_at) AND expires_at=date_trunc('milliseconds',expires_at)
    AND expires_at>issued_at AND expires_at<=issued_at+interval '720 hours'),
  CHECK((state='active' AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR (state='revoked' AND revoked_at IS NOT NULL AND isfinite(revoked_at)
      AND revoked_at=date_trunc('milliseconds',revoked_at) AND revoked_at>=issued_at
      AND revocation_reason IS NOT NULL AND revocation_reason IN ('connection_revoked','refresh_reuse')))
);
CREATE TABLE bootstrap_refresh_generations (
  family_id uuid NOT NULL REFERENCES bootstrap_refresh_families(family_id),
  generation bigint NOT NULL CHECK(generation BETWEEN 1 AND 4096),
  parent_generation bigint,
  handle_hash text NOT NULL UNIQUE CHECK(handle_hash ~ '^[0-9a-f]{64}$'),
  handle_wire_hash text NOT NULL CHECK(handle_wire_hash ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  issued_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY(family_id,generation),
  FOREIGN KEY(family_id,parent_generation) REFERENCES bootstrap_refresh_generations(family_id,generation),
  CHECK((generation=1 AND parent_generation IS NULL) OR (generation>1 AND parent_generation IS NOT NULL AND parent_generation=generation-1)),
  CHECK(isfinite(issued_at) AND issued_at=date_trunc('milliseconds',issued_at)),
  CHECK(consumed_at IS NULL OR (isfinite(consumed_at) AND consumed_at=date_trunc('milliseconds',consumed_at) AND consumed_at>=issued_at))
);
CREATE UNIQUE INDEX bootstrap_refresh_one_head ON bootstrap_refresh_generations(family_id) WHERE consumed_at IS NULL;
CREATE TABLE bootstrap_session_proofs (
  connection_id uuid NOT NULL REFERENCES agent_connections(connection_id),
  runtime_device_id uuid NOT NULL REFERENCES runtime_registrations(runtime_device_id),
  operation text NOT NULL CHECK(operation IN ('refresh','nonce')),
  proof_jti text NOT NULL CHECK(proof_jti ~ '^[A-Za-z0-9_-]{16,128}$'),
  accepted_at timestamptz NOT NULL CHECK(isfinite(accepted_at) AND accepted_at=date_trunc('milliseconds',accepted_at)),
  PRIMARY KEY(runtime_device_id,proof_jti)
);
CREATE INDEX bootstrap_session_proof_capacity ON bootstrap_session_proofs(connection_id);

CREATE FUNCTION preserve_bootstrap_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE family record; connection record; parent record;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Session history is retained' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='bootstrap_refresh_families' THEN
    EXECUTE format('SELECT * FROM %I.agent_connections WHERE connection_id=$1',TG_TABLE_SCHEMA) INTO connection USING NEW.connection_id;
    IF connection.connection_id IS NULL OR NEW.issued_at<connection.issued_at OR NEW.expires_at>connection.expires_at THEN
      RAISE EXCEPTION 'Invalid family backing' USING ERRCODE='23514'; END IF;
    IF TG_OP='INSERT' THEN
      IF connection.state<>'active' OR NEW.state<>'active' OR NEW.current_generation<>1
        OR NEW.issued_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp() THEN
        RAISE EXCEPTION 'Invalid initial family' USING ERRCODE='23514'; END IF;
    ELSIF (to_jsonb(NEW)-ARRAY['current_generation','state','revoked_at','revocation_reason'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['current_generation','state','revoked_at','revocation_reason'])
      OR OLD.state<>'active'
      OR NOT ((NEW.state='active' AND NEW.current_generation=OLD.current_generation+1 AND connection.state='active')
        OR (NEW.state='revoked' AND NEW.current_generation=OLD.current_generation AND NEW.revoked_at IS NOT NULL AND NEW.revoked_at<=clock_timestamp())) THEN
      RAISE EXCEPTION 'Family changes must rotate or revoke' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='bootstrap_refresh_generations' THEN
    EXECUTE format('SELECT * FROM %I.bootstrap_refresh_families WHERE family_id=$1',TG_TABLE_SCHEMA) INTO family USING NEW.family_id;
    IF family.family_id IS NULL OR family.state<>'active' OR NEW.issued_at<family.issued_at
      OR NEW.issued_at>=family.expires_at OR NEW.issued_at>clock_timestamp() OR family.expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'Invalid generation family' USING ERRCODE='23514'; END IF;
    IF TG_OP='INSERT' THEN
      IF NEW.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'Generation starts unspent' USING ERRCODE='23514'; END IF;
      IF NEW.generation=1 THEN
        IF NEW.issued_at IS DISTINCT FROM family.issued_at OR family.current_generation<>1 THEN
          RAISE EXCEPTION 'Invalid initial generation' USING ERRCODE='23514'; END IF;
      ELSE
        EXECUTE format('SELECT * FROM %I.bootstrap_refresh_generations WHERE family_id=$1 AND generation=$2',TG_TABLE_SCHEMA)
          INTO parent USING NEW.family_id,NEW.parent_generation;
        IF parent.generation IS NULL OR parent.consumed_at IS NULL OR NEW.issued_at<parent.consumed_at
          OR NEW.generation<>family.current_generation+1 THEN
          RAISE EXCEPTION 'Generation must extend consumed head' USING ERRCODE='23514'; END IF;
      END IF;
    ELSIF (to_jsonb(NEW)-'consumed_at') IS DISTINCT FROM (to_jsonb(OLD)-'consumed_at')
      OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL OR NEW.consumed_at>clock_timestamp()
      OR NEW.consumed_at>=family.expires_at OR NEW.generation<>family.current_generation THEN
      RAISE EXCEPTION 'Generation consumption is terminal' USING ERRCODE='23514';
    END IF;
  ELSE
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Proof history is immutable' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT * FROM %I.agent_connections WHERE connection_id=$1',TG_TABLE_SCHEMA) INTO connection USING NEW.connection_id;
    IF connection.connection_id IS NULL OR connection.runtime_device_id IS DISTINCT FROM NEW.runtime_device_id
      OR connection.state<>'active' OR NEW.accepted_at<connection.issued_at OR NEW.accepted_at>clock_timestamp()
      OR NEW.accepted_at>=connection.expires_at OR connection.expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'Invalid session proof binding' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_bootstrap_refresh_family BEFORE INSERT OR UPDATE OR DELETE ON bootstrap_refresh_families FOR EACH ROW EXECUTE FUNCTION preserve_bootstrap_session();
CREATE TRIGGER preserve_bootstrap_refresh_generation BEFORE INSERT OR UPDATE OR DELETE ON bootstrap_refresh_generations FOR EACH ROW EXECUTE FUNCTION preserve_bootstrap_session();
CREATE TRIGGER preserve_bootstrap_session_proof BEFORE INSERT OR UPDATE OR DELETE ON bootstrap_session_proofs FOR EACH ROW EXECUTE FUNCTION preserve_bootstrap_session();

CREATE FUNCTION check_bootstrap_refresh_whole_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE family record; connection record; total bigint; heads bigint; maximum bigint; head bigint; broken bigint;
BEGIN
  EXECUTE format('SELECT * FROM %I.bootstrap_refresh_families WHERE family_id=$1',TG_TABLE_SCHEMA) INTO family USING NEW.family_id;
  EXECUTE format('SELECT * FROM %I.agent_connections WHERE connection_id=$1',TG_TABLE_SCHEMA) INTO connection USING family.connection_id;
  EXECUTE format('SELECT count(*),count(*) FILTER(WHERE consumed_at IS NULL),max(generation),max(generation) FILTER(WHERE consumed_at IS NULL),count(*) FILTER(WHERE generation<$2 AND consumed_at IS NULL) FROM %I.bootstrap_refresh_generations WHERE family_id=$1',TG_TABLE_SCHEMA)
    INTO total,heads,maximum,head,broken USING family.family_id,family.current_generation;
  IF family.family_id IS NULL OR connection.connection_id IS NULL OR total<>family.current_generation
    OR maximum IS DISTINCT FROM family.current_generation OR heads<>1 OR head IS DISTINCT FROM family.current_generation OR broken<>0
    OR (family.state='revoked') IS DISTINCT FROM (connection.state='revoked') THEN
    RAISE EXCEPTION 'Incomplete refresh chain or revocation' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_bootstrap_refresh_family AFTER INSERT OR UPDATE ON bootstrap_refresh_families DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_bootstrap_refresh_whole_state();
CREATE CONSTRAINT TRIGGER check_bootstrap_refresh_generation AFTER INSERT OR UPDATE ON bootstrap_refresh_generations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_bootstrap_refresh_whole_state();

CREATE FUNCTION revoke_bootstrap_connection_family() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='revoked' THEN
    EXECUTE format('UPDATE %I.bootstrap_refresh_families SET state=''revoked'',revoked_at=date_trunc(''milliseconds'',$2::timestamptz),revocation_reason=''connection_revoked'' WHERE connection_id=$1 AND state=''active''',TG_TABLE_SCHEMA)
      USING NEW.connection_id,NEW.revoked_at;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER revoke_bootstrap_connection_family AFTER UPDATE ON agent_connections FOR EACH ROW EXECUTE FUNCTION revoke_bootstrap_connection_family();

-- Fresh device exchanges after this migration must create the initial family.
CREATE FUNCTION check_device_refresh_family() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE present boolean;
BEGIN
  IF NEW.state='consumed' THEN
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.bootstrap_refresh_families WHERE connection_id=$1)',TG_TABLE_SCHEMA) INTO present USING NEW.connection_id;
    IF NOT present THEN RAISE EXCEPTION 'Device exchange requires refresh family' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_device_refresh_family AFTER INSERT OR UPDATE ON device_authorizations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_device_refresh_family();
