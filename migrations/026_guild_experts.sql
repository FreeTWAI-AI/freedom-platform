-- A guild may appoint several experts independently of its one guild master.
-- Expertise is a display role, not platform, council or repository authority.
-- Rows survive revocation so a stale version cannot re-enable an old role.
CREATE TABLE positioning_guild_experts (
 community_id uuid NOT NULL REFERENCES communities,
 guild_key text NOT NULL REFERENCES positioning_guild_catalog,
 user_id uuid NOT NULL REFERENCES users,
 active boolean NOT NULL DEFAULT true,
 aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0),
 appointed_by uuid NOT NULL REFERENCES platform_admins,
 appointed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(community_id,guild_key,user_id)
);
CREATE INDEX positioning_guild_experts_member ON positioning_guild_experts(community_id,user_id) WHERE active;

CREATE FUNCTION deactivate_departed_guild_expert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state<>'active' THEN
  UPDATE positioning_guild_experts SET active=false,aggregate_version=aggregate_version+1
   WHERE community_id=NEW.community_id AND guild_key=NEW.guild_key
    AND user_id=NEW.user_id AND active;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER deactivate_departed_guild_expert AFTER UPDATE OF state ON positioning_profession_memberships
 FOR EACH ROW EXECUTE FUNCTION deactivate_departed_guild_expert();
