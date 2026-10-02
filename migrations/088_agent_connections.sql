-- Closed member-managed backing records, not tokens or machine authority.
CREATE TABLE agent_connections (
  connection_id uuid PRIMARY KEY,
  runtime_device_id uuid NOT NULL REFERENCES runtime_registrations(runtime_device_id),
  owner_user_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  scope_kind text GENERATED ALWAYS AS ('personal'::text) STORED,
  environment text NOT NULL CHECK(environment IN ('local','staging-next','next')),
  client_id text NOT NULL CHECK(length(client_id) BETWEEN 1 AND 64 AND client_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at=issued_at+interval '720 hours'),
  revoked_at timestamptz,
  CHECK((state='active' AND revoked_at IS NULL) OR (state='revoked' AND revoked_at>=issued_at)),
  UNIQUE(runtime_device_id,client_id),
  FOREIGN KEY(owner_principal_id,owner_user_id) REFERENCES principals(principal_id,user_ref),
  FOREIGN KEY(scope_id,scope_kind,owner_principal_id) REFERENCES resource_scopes(scope_id,kind,owner_principal_id)
);
CREATE INDEX agent_connections_owner ON agent_connections(owner_principal_id,environment,connection_id);

CREATE FUNCTION preserve_agent_connection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE runtime record;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Connection tombstones cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    -- Invoker privileges; only the physical backing row, never a TEMP shadow.
    EXECUTE format('SELECT * FROM %I.runtime_registrations WHERE runtime_device_id=$1 FOR SHARE',TG_TABLE_SCHEMA)
      INTO runtime USING NEW.runtime_device_id;
    IF runtime.runtime_device_id IS NULL OR runtime.state<>'enrolled'
      OR ROW(NEW.owner_user_id,NEW.owner_principal_id,NEW.scope_id,NEW.environment)
        IS DISTINCT FROM ROW(runtime.owner_user_id,runtime.owner_principal_id,runtime.scope_id,runtime.environment)
      OR NEW.state<>'active' OR NEW.aggregate_version<>1 OR NEW.revoked_at IS NOT NULL
      OR NOT isfinite(NEW.issued_at) OR NEW.issued_at<>date_trunc('milliseconds',NEW.issued_at)
      OR NEW.issued_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'Connection requires current enrolled runtime and immutable owner binding' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['state','aggregate_version','revoked_at','scope_kind'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','aggregate_version','revoked_at','scope_kind'])
    OR OLD.state<>'active' OR NEW.state<>'revoked'
    OR NEW.aggregate_version::numeric<>OLD.aggregate_version::numeric+1
    OR NEW.revoked_at IS NULL OR NOT isfinite(NEW.revoked_at) OR NEW.revoked_at>clock_timestamp() THEN
    RAISE EXCEPTION 'Connection identity is immutable and revocation is terminal' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_agent_connection BEFORE INSERT OR UPDATE OR DELETE ON agent_connections
  FOR EACH ROW EXECUTE FUNCTION preserve_agent_connection();

-- BEFORE can precede a unique-index wait; validate the final successful insert.
CREATE FUNCTION check_agent_connection_insert_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Connection expired before insert completed' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER check_agent_connection_insert_clock AFTER INSERT ON agent_connections
  FOR EACH ROW EXECUTE FUNCTION check_agent_connection_insert_clock();
