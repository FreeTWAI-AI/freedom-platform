-- Closed member-avatar prototype: no live reader/writer cutover or GC.
CREATE TABLE assets (
  asset_id uuid PRIMARY KEY,
  scope_id uuid NOT NULL,
  scope_kind text GENERATED ALWAYS AS ('personal'::text) STORED,
  owner_principal_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(user_id),
  purpose text NOT NULL DEFAULT 'member.avatar' CHECK(purpose='member.avatar'),
  policy_revision text NOT NULL CHECK(length(policy_revision) BETWEEN 1 AND 64 AND policy_revision ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
  representation_id uuid NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','retired','rejected')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ready_at timestamptz,
  retired_at timestamptz,
  FOREIGN KEY(scope_id,scope_kind,owner_principal_id) REFERENCES resource_scopes(scope_id,kind,owner_principal_id),
  FOREIGN KEY(owner_principal_id,owner_user_id) REFERENCES principals(principal_id,user_ref),
  UNIQUE(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,policy_revision,representation_id),
  UNIQUE(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,state),
  UNIQUE(asset_id,scope_id,representation_id,policy_revision),
  CHECK((state IN ('pending','rejected') AND ready_at IS NULL AND retired_at IS NULL)
    OR (state='ready' AND ready_at IS NOT NULL AND retired_at IS NULL)
    OR (state='retired' AND ready_at IS NOT NULL AND retired_at IS NOT NULL))
);
CREATE TABLE asset_objects (
  asset_id uuid PRIMARY KEY,
  scope_id uuid NOT NULL,
  representation_id uuid NOT NULL UNIQUE,
  variant text NOT NULL DEFAULT 'avatar' CHECK(variant='avatar'),
  logical_store text NOT NULL DEFAULT 'MEDIA' CHECK(logical_store='MEDIA'),
  object_key text GENERATED ALWAYS AS ('v1/'||scope_id::text||'/'||asset_id::text||'/'||representation_id::text) STORED UNIQUE,
  content_type text NOT NULL CHECK(content_type='image/webp'),
  byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 131072),
  content_sha256 text NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 ~ '^[0-9a-f]+$'),
  transform_version text NOT NULL CHECK(transform_version='avatar.webp.v1'),
  policy_revision text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(asset_id,scope_id,representation_id,policy_revision) REFERENCES assets(asset_id,scope_id,representation_id,policy_revision)
);
CREATE TABLE member_avatar_asset_targets (
  user_id uuid PRIMARY KEY REFERENCES member_avatars(user_id),
  scope_id uuid NOT NULL,
  scope_kind text GENERATED ALWAYS AS ('personal'::text) STORED,
  owner_principal_id uuid NOT NULL,
  asset_id uuid,
  -- Snapshot of the real avatar version at attach, never an independent clock.
  linked_at_version bigint CHECK(linked_at_version>0),
  purpose text GENERATED ALWAYS AS ('member.avatar'::text) STORED,
  asset_state text GENERATED ALWAYS AS ('ready'::text) STORED,
  FOREIGN KEY(scope_id,scope_kind,owner_principal_id) REFERENCES resource_scopes(scope_id,kind,owner_principal_id),
  FOREIGN KEY(owner_principal_id,user_id) REFERENCES principals(principal_id,user_ref),
  FOREIGN KEY(asset_id,scope_id,owner_principal_id,user_id,purpose,asset_state)
    REFERENCES assets(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,state),
  UNIQUE(user_id,scope_id,owner_principal_id),
  CHECK((asset_id IS NULL)=(linked_at_version IS NULL))
);
CREATE TABLE asset_upload_intents (
  intent_id uuid PRIMARY KEY,
  asset_id uuid NOT NULL UNIQUE,
  representation_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL,
  target_user_id uuid NOT NULL,
  purpose text NOT NULL DEFAULT 'member.avatar' CHECK(purpose='member.avatar'),
  policy_revision text NOT NULL,
  prepare_key text NOT NULL CHECK(length(prepare_key) BETWEEN 8 AND 128 AND prepare_key ~ '^[A-Za-z0-9_-]+$'),
  request_digest text NOT NULL CHECK(length(request_digest)=64 AND request_digest ~ '^[0-9a-f]+$'),
  source_content_type text NOT NULL CHECK(source_content_type IN ('image/png','image/jpeg','image/webp')),
  source_byte_size integer NOT NULL CHECK(source_byte_size BETWEEN 1 AND 2097152),
  source_sha256 text NOT NULL CHECK(length(source_sha256)=64 AND source_sha256 ~ '^[0-9a-f]+$'),
  expected_version bigint NOT NULL CHECK(expected_version>0),
  reserved_bytes integer NOT NULL DEFAULT 131072 CHECK(reserved_bytes=131072),
  state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','processing','stored','finalized')),
  fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0),
  lease_token uuid,
  lease_expires_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finalized_at timestamptz,
  UNIQUE(owner_principal_id,scope_id,prepare_key),
  FOREIGN KEY(target_user_id,scope_id,owner_principal_id) REFERENCES member_avatar_asset_targets(user_id,scope_id,owner_principal_id),
  FOREIGN KEY(asset_id,scope_id,owner_principal_id,target_user_id,purpose,policy_revision,representation_id)
    REFERENCES assets(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,policy_revision,representation_id),
  CHECK((state='prepared' AND fence=0 AND lease_token IS NULL AND lease_expires_at IS NULL)
    OR (state<>'prepared' AND fence>0 AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK((state='finalized')=(finalized_at IS NOT NULL)),
  CHECK(expires_at>created_at),
  CHECK(lease_expires_at IS NULL OR lease_expires_at<=expires_at)
);
CREATE INDEX asset_upload_pending_by_owner ON asset_upload_intents(owner_principal_id,scope_id,expires_at)
  WHERE state<>'finalized';

CREATE FUNCTION preserve_asset_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Asset deletion is not enabled' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'pending' THEN RAISE EXCEPTION 'Assets must start pending' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.asset_id,NEW.scope_id,NEW.owner_principal_id,NEW.owner_user_id,NEW.purpose,NEW.policy_revision,NEW.representation_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.asset_id,OLD.scope_id,OLD.owner_principal_id,OLD.owner_user_id,OLD.purpose,OLD.policy_revision,OLD.representation_id,OLD.created_at) THEN
    RAISE EXCEPTION 'Asset identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT ((OLD.state='pending' AND NEW.state IN ('ready','rejected')) OR (OLD.state='ready' AND NEW.state='retired')) THEN
    RAISE EXCEPTION 'Invalid asset transition' USING ERRCODE='23514';
  END IF;
  IF (OLD.ready_at IS NOT NULL AND NEW.ready_at IS DISTINCT FROM OLD.ready_at)
    OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN
    RAISE EXCEPTION 'Asset evidence timestamps are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.state='ready' AND NOT EXISTS(SELECT 1 FROM asset_objects WHERE asset_id=NEW.asset_id) THEN
    RAISE EXCEPTION 'Verified avatar representation required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_asset_identity BEFORE INSERT OR UPDATE OR DELETE ON assets FOR EACH ROW EXECUTE FUNCTION preserve_asset_identity();

CREATE FUNCTION preserve_asset_object() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Asset representations are immutable; deletion is not enabled' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER preserve_asset_object BEFORE UPDATE OR DELETE ON asset_objects FOR EACH ROW EXECUTE FUNCTION preserve_asset_object();

CREATE FUNCTION preserve_avatar_asset_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR ROW(NEW.user_id,NEW.scope_id,NEW.owner_principal_id) IS DISTINCT FROM ROW(OLD.user_id,OLD.scope_id,OLD.owner_principal_id) THEN
    RAISE EXCEPTION 'Avatar asset target cannot be rebound' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_avatar_asset_target BEFORE UPDATE OR DELETE ON member_avatar_asset_targets FOR EACH ROW EXECUTE FUNCTION preserve_avatar_asset_target();

CREATE FUNCTION preserve_upload_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Intent deletion is not enabled' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'prepared' OR NEW.fence<>0 OR NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL OR NEW.finalized_at IS NOT NULL THEN
      RAISE EXCEPTION 'Intents must start prepared without a lease' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.intent_id,NEW.asset_id,NEW.representation_id,NEW.scope_id,NEW.owner_principal_id,NEW.target_user_id,NEW.purpose,
    NEW.policy_revision,NEW.prepare_key,NEW.request_digest,NEW.source_content_type,NEW.source_byte_size,NEW.source_sha256,
    NEW.expected_version,NEW.reserved_bytes,NEW.expires_at,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.intent_id,OLD.asset_id,OLD.representation_id,OLD.scope_id,OLD.owner_principal_id,OLD.target_user_id,OLD.purpose,
    OLD.policy_revision,OLD.prepare_key,OLD.request_digest,OLD.source_content_type,OLD.source_byte_size,OLD.source_sha256,
    OLD.expected_version,OLD.reserved_bytes,OLD.expires_at,OLD.created_at) THEN
    RAISE EXCEPTION 'Upload intent identity is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.state='finalized' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Finalized intent is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.fence<>OLD.fence THEN
    IF NEW.fence<>OLD.fence+1 OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token OR NEW.lease_expires_at<=clock_timestamp()
      OR NEW.state NOT IN ('processing','stored') OR (OLD.lease_expires_at IS NOT NULL AND OLD.lease_expires_at>clock_timestamp()) THEN
      RAISE EXCEPTION 'Invalid upload lease takeover' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.lease_token IS DISTINCT FROM OLD.lease_token OR NEW.lease_expires_at>OLD.lease_expires_at THEN
    RAISE EXCEPTION 'Lease extension requires a new fence' USING ERRCODE='23514';
  END IF;
  IF OLD.state='prepared' AND NEW.state='processing' AND NEW.fence<>OLD.fence+1 THEN
    RAISE EXCEPTION 'Processing requires a new fence' USING ERRCODE='23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT ((OLD.state='prepared' AND NEW.state='processing')
    OR (OLD.state='processing' AND NEW.state='stored') OR (OLD.state='stored' AND NEW.state='finalized')) THEN
    RAISE EXCEPTION 'Invalid upload state transition' USING ERRCODE='23514';
  END IF;
  IF NEW.state IN ('stored','finalized') AND NOT EXISTS(SELECT 1 FROM asset_objects WHERE asset_id=NEW.asset_id) THEN
    RAISE EXCEPTION 'Stored representation required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_upload_intent BEFORE INSERT OR UPDATE OR DELETE ON asset_upload_intents FOR EACH ROW EXECUTE FUNCTION preserve_upload_intent();
