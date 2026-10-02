-- Closed maintenance primitives. No retention defaults, scheduler or cloud I/O.
ALTER TABLE assets ADD COLUMN deletion_fence bigint NOT NULL DEFAULT 0 CHECK(deletion_fence IN (0,1));
CREATE TABLE asset_maintenance_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false,
  generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
  revision text,
  orphan_retention_seconds integer CHECK(orphan_retention_seconds>0),
  retired_retention_seconds integer CHECK(retired_retention_seconds>0),
  delete_lease_seconds integer CHECK(delete_lease_seconds BETWEEN 1 AND 3600),
  capture_seconds integer CHECK(capture_seconds BETWEEN 1 AND 3600),
  pin_seconds integer CHECK(pin_seconds BETWEEN 1 AND 86400),
  max_capture_objects integer CHECK(max_capture_objects BETWEEN 1 AND 10000),
  CHECK(NOT enabled OR (revision IS NOT NULL AND length(revision) BETWEEN 1 AND 64
    AND orphan_retention_seconds IS NOT NULL AND retired_retention_seconds IS NOT NULL
    AND delete_lease_seconds IS NOT NULL AND capture_seconds IS NOT NULL AND pin_seconds IS NOT NULL AND max_capture_objects IS NOT NULL))
);
INSERT INTO asset_maintenance_policy DEFAULT VALUES;
CREATE TABLE asset_backup_captures (
  capture_id uuid PRIMARY KEY,
  state text NOT NULL DEFAULT 'capturing' CHECK(state IN ('capturing','pinned','released','failed')),
  source_release text NOT NULL CHECK(source_release ~ '^[0-9a-f]{40}$'),
  source_schema text NOT NULL CHECK(length(source_schema) BETWEEN 1 AND 80),
  logical_store text NOT NULL DEFAULT 'MEDIA' CHECK(logical_store='MEDIA'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  capture_expires_at timestamptz NOT NULL,
  reference_snapshot text,
  pin_expires_at timestamptz,
  reference_count integer CHECK(reference_count>=0),
  CHECK(capture_expires_at>created_at),
  CHECK((state='capturing' AND reference_snapshot IS NULL AND pin_expires_at IS NULL AND reference_count IS NULL)
    OR (state='pinned' AND reference_snapshot IS NOT NULL AND pin_expires_at IS NOT NULL AND reference_count IS NOT NULL)
    OR state IN ('released','failed'))
);
CREATE TABLE asset_backup_pins (
  capture_id uuid NOT NULL REFERENCES asset_backup_captures(capture_id),
  asset_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  representation_id uuid NOT NULL,
  policy_revision text NOT NULL,
  byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 131072),
  content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY(capture_id,asset_id),
  FOREIGN KEY(asset_id,scope_id,representation_id,policy_revision) REFERENCES assets(asset_id,scope_id,representation_id,policy_revision)
);
CREATE TABLE asset_deletion_tombstones (
  asset_id uuid PRIMARY KEY REFERENCES assets(asset_id),
  policy_revision text NOT NULL,
  fenced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt bigint NOT NULL DEFAULT 1 CHECK(attempt>0),
  lease_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  observation text CHECK(observation IN ('missing','present','unknown')),
  observed_at timestamptz,
  CHECK((observation IS NULL)=(observed_at IS NULL))
);

-- A real asset tuple change makes old REPEATABLE READ snapshots fail rather
-- than miss a concurrently committed side-table tombstone after waiting.
CREATE FUNCTION enforce_asset_deletion_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.deletion_fence<>0 THEN RAISE EXCEPTION 'Assets start unfenced' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND NEW.deletion_fence IS DISTINCT FROM OLD.deletion_fence THEN
    IF OLD.deletion_fence<>0 OR NEW.deletion_fence<>1 OR NOT EXISTS(SELECT 1 FROM asset_deletion_tombstones WHERE asset_id=NEW.asset_id) THEN
      RAISE EXCEPTION 'Deletion fence is permanent' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.deletion_fence<>0 AND NEW.state='ready' THEN RAISE EXCEPTION 'Fenced asset cannot become ready' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER enforce_asset_deletion_fence BEFORE INSERT OR UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION enforce_asset_deletion_fence();

CREATE FUNCTION reject_fenced_asset_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fence bigint;
BEGIN
  IF NEW.asset_id IS NOT NULL THEN
    SELECT deletion_fence INTO STRICT fence FROM assets WHERE asset_id=NEW.asset_id FOR UPDATE;
    IF fence<>0 THEN RAISE EXCEPTION 'Asset is permanently fenced' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reject_fenced_asset_reference BEFORE INSERT OR UPDATE ON member_avatar_asset_targets FOR EACH ROW EXECUTE FUNCTION reject_fenced_asset_reference();
CREATE TRIGGER reject_fenced_asset_reference BEFORE INSERT OR UPDATE ON asset_upload_intents FOR EACH ROW EXECUTE FUNCTION reject_fenced_asset_reference();
CREATE TRIGGER reject_fenced_asset_reference BEFORE INSERT ON asset_objects FOR EACH ROW EXECUTE FUNCTION reject_fenced_asset_reference();

CREATE FUNCTION check_asset_deletion_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target assets%ROWTYPE; policy asset_maintenance_policy%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Deletion tombstones are permanent' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.asset_id,NEW.policy_revision,NEW.fenced_at) IS DISTINCT FROM ROW(OLD.asset_id,OLD.policy_revision,OLD.fenced_at) THEN
      RAISE EXCEPTION 'Deletion identity is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.attempt IS DISTINCT FROM OLD.attempt THEN
      IF NEW.attempt<>OLD.attempt+1 OR OLD.lease_expires_at>clock_timestamp() OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token
        OR NEW.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Invalid delete lease takeover' USING ERRCODE='23514'; END IF;
    ELSIF NEW.lease_token IS DISTINCT FROM OLD.lease_token OR NEW.lease_expires_at>OLD.lease_expires_at THEN
      RAISE EXCEPTION 'Delete lease extension requires new attempt' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO STRICT target FROM assets WHERE asset_id=NEW.asset_id;
  -- Same owner lock order as upload/finalize; never acquire gate before these.
  PERFORM 1 FROM member_avatars WHERE user_id=target.owner_user_id FOR UPDATE;
  PERFORM 1 FROM member_avatar_asset_targets WHERE user_id=target.owner_user_id FOR UPDATE;
  PERFORM 1 FROM asset_upload_intents WHERE asset_id=NEW.asset_id FOR UPDATE;
  SELECT * INTO STRICT target FROM assets WHERE asset_id=NEW.asset_id FOR UPDATE;
  SELECT * INTO STRICT policy FROM asset_maintenance_policy WHERE singleton FOR SHARE;
  IF NOT policy.enabled OR NEW.policy_revision<>policy.revision OR NEW.attempt<>1 OR NEW.lease_expires_at<=clock_timestamp()
    OR NEW.lease_expires_at>clock_timestamp()+make_interval(secs=>policy.delete_lease_seconds) THEN
    RAISE EXCEPTION 'Maintenance is not configured or lease invalid' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM member_avatar_asset_targets WHERE asset_id=NEW.asset_id)
    OR EXISTS(SELECT 1 FROM asset_upload_intents WHERE asset_id=NEW.asset_id AND state<>'finalized' AND expires_at>clock_timestamp())
    OR EXISTS(SELECT 1 FROM asset_backup_captures WHERE state='capturing')
    OR EXISTS(SELECT 1 FROM asset_backup_pins p JOIN asset_backup_captures c USING(capture_id) WHERE p.asset_id=NEW.asset_id AND c.state='pinned') THEN
    RAISE EXCEPTION 'Asset references or backup protection remain' USING ERRCODE='23514';
  END IF;
  IF NOT ((target.state IN ('pending','rejected') AND target.created_at+make_interval(secs=>policy.orphan_retention_seconds)<=clock_timestamp())
    OR (target.state='retired' AND target.retired_at+make_interval(secs=>policy.retired_retention_seconds)<=clock_timestamp())) THEN
    RAISE EXCEPTION 'Asset retention has not elapsed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_asset_deletion_claim BEFORE INSERT OR UPDATE OR DELETE ON asset_deletion_tombstones FOR EACH ROW EXECUTE FUNCTION check_asset_deletion_claim();
CREATE FUNCTION apply_asset_deletion_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN UPDATE assets SET deletion_fence=1 WHERE asset_id=NEW.asset_id; RETURN NULL; END;
$$;
CREATE TRIGGER apply_asset_deletion_fence AFTER INSERT ON asset_deletion_tombstones FOR EACH ROW EXECUTE FUNCTION apply_asset_deletion_fence();

CREATE FUNCTION preserve_backup_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Capture history is retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'capturing' THEN RAISE EXCEPTION 'Captures start at barrier' USING ERRCODE='23514'; END IF;
  ELSE
    IF ROW(NEW.capture_id,NEW.source_release,NEW.source_schema,NEW.logical_store,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.capture_id,OLD.source_release,OLD.source_schema,OLD.logical_store,OLD.created_at)
      OR (OLD.reference_snapshot IS NOT NULL AND ROW(NEW.reference_snapshot,NEW.reference_count) IS DISTINCT FROM ROW(OLD.reference_snapshot,OLD.reference_count))
      OR OLD.state IN ('released','failed') AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Capture identity/history is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.state<>OLD.state AND NOT ((OLD.state='capturing' AND NEW.state IN ('pinned','failed')) OR (OLD.state='pinned' AND NEW.state IN ('released','failed'))) THEN
      RAISE EXCEPTION 'Invalid capture state transition' USING ERRCODE='23514';
    END IF;
    IF NEW.state='pinned' AND (OLD.state='capturing' AND OLD.capture_expires_at<=clock_timestamp()
      OR OLD.state='pinned' AND OLD.pin_expires_at<=clock_timestamp()) THEN
      RAISE EXCEPTION 'Expired protection cannot certify references' USING ERRCODE='23514';
    END IF;
    IF NEW.capture_expires_at>OLD.capture_expires_at AND (OLD.state<>'capturing' OR OLD.capture_expires_at<=clock_timestamp())
      OR NEW.pin_expires_at>OLD.pin_expires_at AND (OLD.state<>'pinned' OR OLD.pin_expires_at<=clock_timestamp()) THEN
      RAISE EXCEPTION 'Expired backup protection cannot be renewed' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_backup_capture BEFORE INSERT OR UPDATE OR DELETE ON asset_backup_captures FOR EACH ROW EXECUTE FUNCTION preserve_backup_capture();
-- Do not rely on a side-table EXISTS in an old RR snapshot. Every change to
-- barrier/pin protection physically updates the tuple GC must lock last.
CREATE FUNCTION advance_asset_maintenance_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN UPDATE asset_maintenance_policy SET generation=generation+1 WHERE singleton; RETURN NULL; END;
$$;
CREATE TRIGGER advance_asset_maintenance_generation AFTER INSERT OR UPDATE ON asset_backup_captures
  FOR EACH ROW EXECUTE FUNCTION advance_asset_maintenance_generation();
CREATE FUNCTION preserve_backup_pin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fence bigint;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Captured references are immutable' USING ERRCODE='23514'; END IF;
  SELECT deletion_fence INTO STRICT fence FROM assets WHERE asset_id=NEW.asset_id FOR SHARE;
  IF fence<>0 OR NOT EXISTS(SELECT 1 FROM asset_backup_captures WHERE capture_id=NEW.capture_id AND state='capturing' AND capture_expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'Cannot pin fenced asset or expired capture' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_backup_pin BEFORE INSERT OR UPDATE OR DELETE ON asset_backup_pins FOR EACH ROW EXECUTE FUNCTION preserve_backup_pin();
