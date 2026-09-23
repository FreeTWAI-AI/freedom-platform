-- Nominees are provisioned privately. No personal addresses or automatic user-
-- email-to-admin grants belong in source. Access identity is verified separately.
CREATE TABLE platform_admins (
  admin_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities,
  email text UNIQUE NOT NULL CHECK(email=lower(email)), display_name text NOT NULL,
  role text NOT NULL DEFAULT 'super_admin' CHECK(role='super_admin'),
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_admin_audit (
  audit_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities,
  admin_id uuid NOT NULL REFERENCES platform_admins, verified_access_subject text NOT NULL,
  action text NOT NULL, target_type text NOT NULL, target_ref text NOT NULL,
  reason text NOT NULL, before_state jsonb NOT NULL, after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_admin_audit_community ON platform_admin_audit(community_id,created_at DESC);
CREATE TABLE platform_admin_receipts (
  admin_id uuid NOT NULL REFERENCES platform_admins, operation text NOT NULL,
  idempotency_key text NOT NULL, request_sha256 text NOT NULL, response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(admin_id,operation,idempotency_key)
);
ALTER TABLE users ADD COLUMN admin_status_version bigint NOT NULL DEFAULT 1 CHECK(admin_status_version>0);
ALTER TABLE guild_creation_applications ADD COLUMN reviewed_by uuid REFERENCES platform_admins;
ALTER TABLE guild_creation_applications ADD COLUMN reviewed_at timestamptz;
ALTER TABLE guild_creation_applications ADD COLUMN review_reason text;
ALTER TABLE guild_creation_applications ADD COLUMN approved_guild_key text REFERENCES positioning_guild_catalog;
-- Revisions survive removal/re-appointment: a stale If-Match must never match a
-- replacement officer. The global sequence is intentionally not reset on leave.
CREATE SEQUENCE positioning_guild_officer_revision START 2;
ALTER TABLE positioning_guild_officers ADD COLUMN aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0);
ALTER TABLE positioning_guild_officers ALTER COLUMN aggregate_version SET DEFAULT nextval('positioning_guild_officer_revision');

-- An officer must remain a guild member. Membership writes already run within
-- transactions; an explicit leave also ends the appointment atomically.
CREATE FUNCTION remove_departed_guild_officer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='left' THEN
    DELETE FROM positioning_guild_officers WHERE community_id=NEW.community_id
      AND guild_key=NEW.guild_key AND user_id=NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER remove_departed_guild_officer AFTER UPDATE OF state ON positioning_profession_memberships
  FOR EACH ROW EXECUTE FUNCTION remove_departed_guild_officer();
