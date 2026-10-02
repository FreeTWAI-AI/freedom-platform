-- Additive, default-legacy routing. This switch is NOT persistence/retention
-- permission, a storage binding, a backfill, or authorization to run cutover.
CREATE TABLE avatar_storage_policy (
  profile text PRIMARY KEY DEFAULT 'member.avatar' CHECK(profile='member.avatar'),
  mode text NOT NULL DEFAULT 'legacy' CHECK(mode IN ('legacy','bridge','r2_only'))
);
INSERT INTO avatar_storage_policy DEFAULT VALUES;
ALTER TABLE member_avatars ADD COLUMN storage_source text NOT NULL DEFAULT 'legacy'
  CHECK(storage_source IN ('legacy','asset'));

CREATE FUNCTION preserve_avatar_storage_floor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.profile IS DISTINCT FROM OLD.profile
    OR (OLD.mode<>'legacy' AND NEW.mode='legacy') THEN
    RAISE EXCEPTION 'Avatar rollback requires an asset-aware bridge' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_avatar_storage_floor BEFORE UPDATE OR DELETE ON avatar_storage_policy
  FOR EACH ROW EXECUTE FUNCTION preserve_avatar_storage_floor();

CREATE FUNCTION fence_legacy_avatar_writer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_mode text;
BEGIN
  SELECT mode INTO STRICT current_mode FROM avatar_storage_policy WHERE profile='member.avatar' FOR SHARE;
  IF TG_OP='INSERT' THEN
    IF NEW.image_bytes IS NOT NULL AND (current_mode='r2_only' OR NEW.storage_source='asset') THEN
      RAISE EXCEPTION 'Legacy avatar writes are disabled' USING ERRCODE='23514';
    END IF;
  ELSE
    IF OLD.storage_source='asset' AND NEW.storage_source<>'asset' THEN
      RAISE EXCEPTION 'Asset avatars cannot fall back to legacy bytes' USING ERRCODE='23514';
    END IF;
    IF NEW.image_bytes IS DISTINCT FROM OLD.image_bytes AND NEW.image_bytes IS NOT NULL
      AND (current_mode='r2_only' OR OLD.storage_source='asset' OR NEW.storage_source='asset') THEN
      RAISE EXCEPTION 'Legacy avatar writes are disabled' USING ERRCODE='23514';
    END IF;
    IF NEW.storage_source IS DISTINCT FROM OLD.storage_source AND NEW.aggregate_version<=OLD.aggregate_version THEN
      RAISE EXCEPTION 'Source activation requires the real avatar version advance' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.storage_source='asset' AND current_mode='legacy' THEN
    RAISE EXCEPTION 'Asset avatar routing is not enabled' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fence_legacy_avatar_writer BEFORE INSERT OR UPDATE ON member_avatars
  FOR EACH ROW EXECUTE FUNCTION fence_legacy_avatar_writer();

-- Even a same-byte UPDATE from an old writer is forbidden at the cutover
-- floor. Metadata-only updates do not name image_bytes and remain legal.
CREATE FUNCTION fence_avatar_byte_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_mode text;
BEGIN
  SELECT mode INTO STRICT current_mode FROM avatar_storage_policy WHERE profile='member.avatar' FOR SHARE;
  IF NEW.image_bytes IS NOT NULL AND (current_mode='r2_only' OR OLD.storage_source='asset' OR NEW.storage_source='asset') THEN
    RAISE EXCEPTION 'Legacy avatar byte updates are disabled' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fence_avatar_byte_update BEFORE UPDATE OF image_bytes ON member_avatars
  FOR EACH ROW EXECUTE FUNCTION fence_avatar_byte_update();

-- Deferred because finalize advances the REAL avatar version before attaching
-- its typed pointer. Old workers cannot clear/replace bytes while keeping a
-- pointer to a different version, even with full table-level UPDATE permission.
CREATE FUNCTION require_current_avatar_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE avatar member_avatars%ROWTYPE; pointer member_avatar_asset_targets%ROWTYPE;
BEGIN
  SELECT * INTO avatar FROM member_avatars WHERE user_id=NEW.user_id;
  IF avatar.storage_source='asset' THEN
    SELECT * INTO pointer FROM member_avatar_asset_targets WHERE user_id=NEW.user_id;
    IF pointer.user_id IS NULL OR (pointer.asset_id IS NOT NULL AND pointer.linked_at_version<>avatar.aggregate_version)
      OR (pointer.asset_id IS NULL AND avatar.image_bytes IS NOT NULL) THEN
      RAISE EXCEPTION 'Asset avatar requires a current pointer or explicit removal' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER require_current_avatar_pointer AFTER INSERT OR UPDATE ON member_avatars
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_current_avatar_pointer();
CREATE CONSTRAINT TRIGGER require_current_avatar_pointer AFTER INSERT OR UPDATE ON member_avatar_asset_targets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_current_avatar_pointer();

-- Metadata-only presence. Asset rows NEVER consult retained legacy bytes.
CREATE VIEW member_avatar_presence AS
SELECT a.user_id,a.community_id,a.aggregate_version,a.storage_source,
  CASE WHEN a.storage_source='legacy' THEN a.image_bytes IS NOT NULL ELSE
    t.asset_id IS NOT NULL AND t.linked_at_version=a.aggregate_version
    AND asset.state='ready' AND o.asset_id IS NOT NULL AND p.status='active' AND s.status='active'
  END AS present
FROM member_avatars a
LEFT JOIN member_avatar_asset_targets t ON t.user_id=a.user_id
LEFT JOIN assets asset ON asset.asset_id=t.asset_id
LEFT JOIN asset_objects o ON o.asset_id=t.asset_id
LEFT JOIN principals p ON p.principal_id=t.owner_principal_id
LEFT JOIN resource_scopes s ON s.scope_id=t.scope_id;
