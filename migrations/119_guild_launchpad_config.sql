-- Guild launchpad config revisions, the published pointer, and leader delegations.
-- Revisions stay immutable except the status transition. Rows are not removed.

CREATE TABLE guild_launchpad_config_revisions (
  config_id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(community_id),
  guild_key text NOT NULL REFERENCES positioning_guild_catalog(guild_key),
  revision bigint NOT NULL CHECK (revision > 0),
  schema_version text NOT NULL,
  body jsonb NOT NULL,
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('draft','published','superseded')),
  source text NOT NULL CHECK (source IN ('platform_default','guild_editor')),
  created_by_principal_id uuid NOT NULL REFERENCES principals(principal_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revert_reason text,
  reverted_from_revision bigint,
  UNIQUE (community_id, guild_key, revision),
  UNIQUE (config_id, community_id, guild_key),
  CHECK ((revert_reason IS NULL) = (reverted_from_revision IS NULL)),
  CHECK (revert_reason IS NULL OR char_length(revert_reason) BETWEEN 1 AND 1000)
);
CREATE UNIQUE INDEX guild_launchpad_one_published
  ON guild_launchpad_config_revisions (community_id, guild_key) WHERE status = 'published';

CREATE TABLE guild_launchpad_config_pointers (
  community_id uuid NOT NULL REFERENCES communities(community_id),
  guild_key text NOT NULL REFERENCES positioning_guild_catalog(guild_key),
  config_id uuid NOT NULL,
  pointer_version bigint NOT NULL CHECK (pointer_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, guild_key),
  FOREIGN KEY (config_id, community_id, guild_key)
    REFERENCES guild_launchpad_config_revisions (config_id, community_id, guild_key)
);

CREATE TABLE guild_launchpad_delegations (
  delegation_id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(community_id),
  guild_key text NOT NULL REFERENCES positioning_guild_catalog(guild_key),
  principal_id uuid NOT NULL REFERENCES principals(principal_id),
  capabilities text[] NOT NULL,
  granted_by_principal_id uuid NOT NULL REFERENCES principals(principal_id),
  expires_at timestamptz NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('active','revoked','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoke_reason text,
  CHECK (cardinality(capabilities) BETWEEN 1 AND 3),
  CHECK (capabilities <@ ARRAY['guild.content.edit','guild.config.preview','guild.config.publish']::text[]),
  CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (status = 'expired' AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL
        AND char_length(revoke_reason) BETWEEN 3 AND 1000)
  )
);
CREATE UNIQUE INDEX guild_launchpad_delegations_one_active
  ON guild_launchpad_delegations (community_id, guild_key, principal_id)
  WHERE status = 'active';

-- Distinct capabilities cannot be expressed with a subquery in CHECK, so the
-- row guard below rejects duplicates. Containment and the 1..3 bound stay in CHECK.
CREATE FUNCTION guild_launchpad_revisions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'launchpad config revisions cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.config_id, NEW.community_id, NEW.guild_key, NEW.revision, NEW.schema_version, NEW.body, NEW.body_sha256, NEW.source, NEW.created_by_principal_id, NEW.created_at, NEW.revert_reason, NEW.reverted_from_revision)
     IS DISTINCT FROM
     ROW(OLD.config_id, OLD.community_id, OLD.guild_key, OLD.revision, OLD.schema_version, OLD.body, OLD.body_sha256, OLD.source, OLD.created_by_principal_id, OLD.created_at, OLD.revert_reason, OLD.reverted_from_revision) THEN
    RAISE EXCEPTION 'launchpad config revisions are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'launchpad config revision status is unchanged' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.status = 'draft' AND NEW.status = 'published') OR (OLD.status = 'published' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'launchpad config revision status transition is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guild_launchpad_revisions_immutable
  BEFORE UPDATE OR DELETE ON guild_launchpad_config_revisions
  FOR EACH ROW EXECUTE FUNCTION guild_launchpad_revisions_immutable();

CREATE FUNCTION guild_launchpad_pointers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'launchpad config pointers cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.community_id IS DISTINCT FROM OLD.community_id OR NEW.guild_key IS DISTINCT FROM OLD.guild_key THEN
    RAISE EXCEPTION 'launchpad config pointer identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.pointer_version <= OLD.pointer_version THEN
    RAISE EXCEPTION 'launchpad config pointer version must increase' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guild_launchpad_pointers_guard
  BEFORE UPDATE OR DELETE ON guild_launchpad_config_pointers
  FOR EACH ROW EXECUTE FUNCTION guild_launchpad_pointers_guard();

CREATE FUNCTION guild_launchpad_delegations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed text[] := ARRAY['guild.content.edit','guild.config.preview','guild.config.publish'];
  item text;
  seen text[] := ARRAY[]::text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'launchpad delegations cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF cardinality(NEW.capabilities) < 1 OR cardinality(NEW.capabilities) > 3 THEN
    RAISE EXCEPTION 'launchpad delegation capabilities must be a non-empty subset' USING ERRCODE = '23514';
  END IF;
  FOREACH item IN ARRAY NEW.capabilities LOOP
    IF NOT (item = ANY (allowed)) OR item = ANY (seen) THEN
      RAISE EXCEPTION 'launchpad delegation capabilities must be a distinct allowed subset' USING ERRCODE = '23514';
    END IF;
    seen := array_append(seen, item);
  END LOOP;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.delegation_id, NEW.community_id, NEW.guild_key, NEW.principal_id, NEW.capabilities, NEW.granted_by_principal_id, NEW.expires_at, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.delegation_id, OLD.community_id, OLD.guild_key, OLD.principal_id, OLD.capabilities, OLD.granted_by_principal_id, OLD.expires_at, OLD.created_at) THEN
      RAISE EXCEPTION 'launchpad delegation identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF NOT ((OLD.status = 'active' AND NEW.status = 'revoked')
      OR (OLD.status = 'active' AND NEW.status = 'expired' AND OLD.expires_at <= clock_timestamp())) THEN
      RAISE EXCEPTION 'launchpad delegation status transition is not allowed' USING ERRCODE = '23514';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'launchpad delegation version must increase by one' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guild_launchpad_delegations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON guild_launchpad_delegations
  FOR EACH ROW EXECUTE FUNCTION guild_launchpad_delegations_guard();
