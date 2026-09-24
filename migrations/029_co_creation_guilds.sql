-- Discovery categories, independent of membership and repository permissions.
CREATE TABLE co_creation_project_guilds (
  project_id uuid NOT NULL REFERENCES co_creation_projects ON DELETE CASCADE,
  guild_key text NOT NULL REFERENCES positioning_guild_catalog,
  PRIMARY KEY(project_id, guild_key)
);
CREATE INDEX co_creation_projects_by_guild ON co_creation_project_guilds(guild_key, project_id);
