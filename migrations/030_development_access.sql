-- Platform proposal authority only; never GitHub collaborator/team permissions.
CREATE TABLE development_consents (
  community_id uuid NOT NULL REFERENCES communities,
  user_id uuid NOT NULL REFERENCES users,
  capability text NOT NULL CHECK(capability IN ('skill','platform')),
  policy_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  PRIMARY KEY(community_id,user_id,capability)
);
CREATE TABLE development_grants (
  grant_id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities,
  user_id uuid NOT NULL REFERENCES users,
  capability text NOT NULL CHECK(capability IN ('skill','platform')),
  target_key text NOT NULL,
  target_repository text NOT NULL,
  target_repository_id text NOT NULL,
  working_repository text NOT NULL,
  working_repository_id text NOT NULL,
  github_user_id text NOT NULL,
  installation_id text NOT NULL,
  app_id text NOT NULL,
  guild_sources text[] NOT NULL,
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
  revoked_at timestamptz,
  revoke_reason text
);
CREATE UNIQUE INDEX development_active_target ON development_grants(community_id,user_id,capability,target_key) WHERE revoked_at IS NULL;
CREATE TABLE development_keys (
  key_id uuid PRIMARY KEY,
  source_grant_id uuid NOT NULL REFERENCES development_grants,
  secret_hash text UNIQUE NOT NULL,
  scope text NOT NULL DEFAULT 'development:propose' CHECK(scope='development:propose'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '60 minutes',
  revoked_at timestamptz
);
CREATE TABLE development_proposals (
  proposal_id uuid PRIMARY KEY,
  source_grant_id uuid NOT NULL REFERENCES development_grants,
  community_id uuid NOT NULL REFERENCES communities,
  user_id uuid NOT NULL REFERENCES users,
  capability text NOT NULL,
  target_key text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  pr_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Every membership path (onboarding, self-service, appointment) shares this
-- transaction boundary. Losing one OR source must not remove another source.
CREATE FUNCTION revoke_ineligible_development() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE person uuid; community uuid;
BEGIN
  person := COALESCE(NEW.user_id,OLD.user_id);
  community := COALESCE(NEW.community_id,OLD.community_id);
  UPDATE development_grants g SET revoked_at=now(),revoke_reason='guild_eligibility_lost'
    WHERE g.user_id=person AND g.community_id=community AND g.revoked_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM positioning_profession_memberships m
      WHERE m.user_id=person AND m.community_id=community AND m.state='active'
      AND ((g.capability='skill' AND m.guild_key IN ('guild_ai_vibe','guild_ai_field'))
        OR (g.capability='platform' AND m.guild_key='guild_platform_engineering')));
  RETURN NULL;
END $$;
CREATE TRIGGER development_membership_revoke AFTER INSERT OR UPDATE OR DELETE ON positioning_profession_memberships FOR EACH ROW EXECUTE FUNCTION revoke_ineligible_development();

CREATE FUNCTION cascade_development_key_revoke() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL THEN
    UPDATE development_keys SET revoked_at=COALESCE(revoked_at,NEW.revoked_at) WHERE source_grant_id=NEW.grant_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER development_key_revoke AFTER UPDATE OF revoked_at ON development_grants FOR EACH ROW EXECUTE FUNCTION cascade_development_key_revoke();

CREATE FUNCTION revoke_disconnected_development() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.github_user_id IS DISTINCT FROM OLD.github_user_id OR NEW.connected_at IS DISTINCT FROM OLD.connected_at THEN
    UPDATE development_grants SET revoked_at=now(),revoke_reason='github_connection_changed' WHERE user_id=OLD.user_id AND community_id=OLD.community_id AND revoked_at IS NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER development_github_revoke AFTER UPDATE OR DELETE ON github_social_connections FOR EACH ROW EXECUTE FUNCTION revoke_disconnected_development();

CREATE FUNCTION revoke_disabled_development() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.active OR (NEW.onboarding_required AND NEW.onboarding_completed_at IS NULL) THEN
    UPDATE development_grants SET revoked_at=now(),revoke_reason='member_unavailable' WHERE user_id=NEW.user_id AND revoked_at IS NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER development_member_revoke AFTER UPDATE OF active,onboarding_required,onboarding_completed_at ON users FOR EACH ROW EXECUTE FUNCTION revoke_disabled_development();
