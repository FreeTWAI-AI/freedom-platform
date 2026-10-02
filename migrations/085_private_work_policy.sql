-- Closed, operator-configured persistence policy. No rows are seeded and no
-- scope is implicitly enabled. Deployment runtime roles receive SELECT only;
-- this schema-owner migration does not authenticate an operator or configure
-- production quota/retention. No private GC or backup copying is enabled.
CREATE TABLE private_work_persistence_policy (
  scope_id uuid NOT NULL,
  purpose text NOT NULL CHECK(purpose='work.private-draft'),
  owner_principal_id uuid NOT NULL,
  scope_kind text GENERATED ALWAYS AS ('personal'::text) STORED,
  revision bigint NOT NULL CHECK(revision>0),
  persistence_allowed boolean NOT NULL DEFAULT false,
  retained_byte_limit bigint CHECK(retained_byte_limit IS NULL OR retained_byte_limit>=262144),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,purpose),
  FOREIGN KEY(scope_id,scope_kind,owner_principal_id)
    REFERENCES resource_scopes(scope_id,kind,owner_principal_id),
  CHECK(NOT persistence_allowed OR retained_byte_limit IS NOT NULL)
);

CREATE FUNCTION preserve_private_work_policy_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Disable private persistence policy with a new revision' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision IS DISTINCT FROM 1::bigint THEN
      RAISE EXCEPTION 'Private persistence policy must start at revision one' USING ERRCODE='23514';
    END IF;
    NEW.created_at:=clock_timestamp(); NEW.updated_at:=NEW.created_at;
    RETURN NEW;
  END IF;
  IF ROW(NEW.scope_id,NEW.purpose,NEW.owner_principal_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.scope_id,OLD.purpose,OLD.owner_principal_id,OLD.created_at) THEN
    RAISE EXCEPTION 'Private persistence policy identity is immutable' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.revision,NEW.persistence_allowed,NEW.retained_byte_limit,NEW.updated_at)
    IS NOT DISTINCT FROM ROW(OLD.revision,OLD.persistence_allowed,OLD.retained_byte_limit,OLD.updated_at) THEN RETURN NEW; END IF;
  IF OLD.revision=9223372036854775807 THEN
    RAISE EXCEPTION 'Private persistence policy revision exhausted' USING ERRCODE='23514';
  END IF;
  IF NEW.revision IS DISTINCT FROM OLD.revision+1 THEN
    RAISE EXCEPTION 'Private persistence policy changes require the next revision' USING ERRCODE='23514';
  END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_private_work_policy_revision
  BEFORE INSERT OR UPDATE OR DELETE ON private_work_persistence_policy
  FOR EACH ROW EXECUTE FUNCTION preserve_private_work_policy_revision();
