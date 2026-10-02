-- Additive member identity mapping only. No backfill, credentials, provider I/O,
-- legacy FK rewrite or implicit runtime authorization is performed here.
CREATE TABLE principals (
  principal_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'person' CHECK (kind = 'person'),
  user_ref uuid NOT NULL UNIQUE REFERENCES users(user_id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (principal_id,kind)
);

-- service/site branches stay closed until real backing records and their FKs
-- arrive in a separate migration. There is no placeholder service identity.
CREATE TABLE resource_scopes (
  scope_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('community','personal')),
  owner_principal_id uuid UNIQUE,
  owner_principal_kind text GENERATED ALWAYS AS (CASE WHEN kind='personal' THEN 'person' END) STORED,
  community_ref uuid UNIQUE REFERENCES communities(community_id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind='community' AND community_ref IS NOT NULL AND owner_principal_id IS NULL)
      OR (kind='personal' AND community_ref IS NULL AND owner_principal_id IS NOT NULL)),
  FOREIGN KEY (owner_principal_id,owner_principal_kind) REFERENCES principals(principal_id,kind),
  UNIQUE (scope_id,kind)
);

-- Changing a mapping would transfer every future private resource attached to
-- its opaque ID. Status may change; identity/backing references may not.
CREATE FUNCTION preserve_principal_mapping() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Disable principal mappings instead of deleting them' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.principal_id,NEW.kind,NEW.user_ref,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.principal_id,OLD.kind,OLD.user_ref,OLD.created_at) THEN
    RAISE EXCEPTION 'Principal identity mapping is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_principal_mapping BEFORE UPDATE OR DELETE ON principals
  FOR EACH ROW EXECUTE FUNCTION preserve_principal_mapping();

CREATE FUNCTION preserve_resource_scope_mapping() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Disable resource scope mappings instead of deleting them' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.scope_id,NEW.kind,NEW.owner_principal_id,NEW.community_ref,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.scope_id,OLD.kind,OLD.owner_principal_id,OLD.community_ref,OLD.created_at) THEN
    RAISE EXCEPTION 'Resource scope identity mapping is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_resource_scope_mapping BEFORE UPDATE OR DELETE ON resource_scopes
  FOR EACH ROW EXECUTE FUNCTION preserve_resource_scope_mapping();
