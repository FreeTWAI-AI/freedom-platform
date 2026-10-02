-- Additive member-session scoped receipts and private-safe event separation.
-- No old receipt/digest changes, backfill, machine auth, or community fanout.
-- Reuse 077's scope_person_identity composite unique constraint.
CREATE TABLE scoped_command_receipts (
  principal_id uuid NOT NULL,
  principal_kind text NOT NULL CHECK (principal_kind='person'),
  authn_kind text NOT NULL CHECK (authn_kind='member_session'),
  scope_id uuid NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('personal','community')),
  personal_owner_principal_id uuid GENERATED ALWAYS AS (CASE WHEN scope_kind='personal' THEN principal_id END) STORED,
  operation text NOT NULL CHECK (operation ~ '^[a-z][a-z0-9_.-]{0,159}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  target_kind text NOT NULL CHECK (target_kind ~ '^[a-z][a-z0-9_.-]{0,159}$'),
  target_id uuid NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL CHECK (octet_length(response::text)<=524288),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id,authn_kind,scope_id,operation,idempotency_key),
  FOREIGN KEY (principal_id,principal_kind) REFERENCES principals(principal_id,kind),
  FOREIGN KEY (scope_id,scope_kind) REFERENCES resource_scopes(scope_id,kind),
  FOREIGN KEY (scope_id,scope_kind,personal_owner_principal_id) REFERENCES resource_scopes(scope_id,kind,owner_principal_id)
);

CREATE TABLE scoped_transition_journal (
  transition_id uuid PRIMARY KEY,
  scope_id uuid NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('personal','community')),
  principal_id uuid NOT NULL,
  principal_kind text NOT NULL CHECK (principal_kind='person'),
  personal_owner_principal_id uuid GENERATED ALWAYS AS (CASE WHEN scope_kind='personal' THEN principal_id END) STORED,
  authn_kind text NOT NULL CHECK (authn_kind='member_session'),
  aggregate_type text NOT NULL CHECK (aggregate_type ~ '^[a-z][a-z0-9_.-]{0,159}$'),
  aggregate_id uuid NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version>0),
  operation text NOT NULL CHECK (operation ~ '^[a-z][a-z0-9_.-]{0,159}$'),
  data jsonb NOT NULL CHECK (jsonb_typeof(data)='object' AND octet_length(data::text)<=65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (principal_id,principal_kind) REFERENCES principals(principal_id,kind),
  FOREIGN KEY (scope_id,scope_kind) REFERENCES resource_scopes(scope_id,kind),
  FOREIGN KEY (scope_id,scope_kind,personal_owner_principal_id) REFERENCES resource_scopes(scope_id,kind,owner_principal_id),
  UNIQUE (scope_id,aggregate_type,aggregate_id,aggregate_version),
  UNIQUE (transition_id,scope_id,scope_kind)
);

CREATE TABLE scoped_outbox (
  event_id uuid PRIMARY KEY,
  transition_id uuid NOT NULL UNIQUE,
  scope_id uuid NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('personal','community')),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.-]{0,159}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=524288),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (transition_id,scope_id,scope_kind) REFERENCES scoped_transition_journal(transition_id,scope_id,scope_kind)
);
CREATE INDEX scoped_journal_by_scope ON scoped_transition_journal(scope_id,created_at,transition_id);
CREATE INDEX scoped_outbox_by_scope ON scoped_outbox(scope_id,created_at,event_id);

-- Append-only facts: DML cannot rewrite the request/response or rebind evidence,
-- nor delete a receipt to silently make an old key produce another effect.
-- Any future retention/erasure path needs a separately reviewed lifecycle.
CREATE FUNCTION preserve_scoped_command_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Scoped command facts are immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER preserve_scoped_receipt BEFORE UPDATE OR DELETE ON scoped_command_receipts
  FOR EACH ROW EXECUTE FUNCTION preserve_scoped_command_fact();
CREATE TRIGGER preserve_scoped_journal BEFORE UPDATE OR DELETE ON scoped_transition_journal
  FOR EACH ROW EXECUTE FUNCTION preserve_scoped_command_fact();
CREATE TRIGGER preserve_scoped_outbox BEFORE UPDATE OR DELETE ON scoped_outbox
  FOR EACH ROW EXECUTE FUNCTION preserve_scoped_command_fact();
