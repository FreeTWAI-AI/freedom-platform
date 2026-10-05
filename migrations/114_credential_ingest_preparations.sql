-- Replica-independent, one-use preparation deadline. No secret or serialized
-- capability is retained; submission creates a fresh genuine store intent.
CREATE TABLE credential_ingest_preparations (
  authorization_id uuid PRIMARY KEY REFERENCES credential_ingest_authorizations(authorization_id),
  prepared_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (isfinite(prepared_at) AND prepared_at=date_trunc('milliseconds',prepared_at)),
  CHECK (isfinite(expires_at) AND expires_at=date_trunc('milliseconds',expires_at)
    AND expires_at>prepared_at AND expires_at<=prepared_at+interval '30 seconds')
);
REVOKE ALL ON credential_ingest_preparations FROM PUBLIC;
CREATE FUNCTION preserve_credential_ingest_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE claim_row record;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Ingest preparation is retained and one-use' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT * FROM %I.credential_ingest_authorizations WHERE authorization_id=$1 FOR UPDATE',TG_TABLE_SCHEMA)
    INTO claim_row USING NEW.authorization_id;
  IF claim_row.bootstrap_claimed_at IS NULL OR claim_row.submission_claimed_at IS NOT NULL
    OR NEW.prepared_at<claim_row.bootstrap_claimed_at OR NEW.prepared_at>clock_timestamp()
    OR NEW.expires_at<=clock_timestamp() OR NEW.expires_at>claim_row.setup_expires_at THEN
    RAISE EXCEPTION 'Fresh claimed ingest setup required' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_credential_ingest_preparation BEFORE INSERT OR UPDATE OR DELETE ON credential_ingest_preparations
  FOR EACH ROW EXECUTE FUNCTION preserve_credential_ingest_preparation();
CREATE FUNCTION require_credential_ingest_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE deadline timestamptz;
BEGIN
  IF OLD.submission_claimed_at IS NULL AND NEW.submission_claimed_at IS NOT NULL THEN
    EXECUTE format('SELECT expires_at FROM %I.credential_ingest_preparations WHERE authorization_id=$1',TG_TABLE_SCHEMA)
      INTO deadline USING NEW.authorization_id;
    IF deadline IS NULL OR deadline<=clock_timestamp() OR NEW.write_expires_at>deadline THEN
      RAISE EXCEPTION 'Current one-use preparation deadline required' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER require_credential_ingest_preparation BEFORE UPDATE ON credential_ingest_authorizations
  FOR EACH ROW EXECUTE FUNCTION require_credential_ingest_preparation();

CREATE INDEX credential_ingest_setup_cookie_lookup ON credential_ingest_authorizations(setup_cookie_hash)
  WHERE setup_cookie_hash IS NOT NULL;
