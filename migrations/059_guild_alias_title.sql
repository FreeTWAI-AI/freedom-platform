-- Optional display alias, and a profession title for approved custom guilds.
-- Built-in titles stay in guildTitles (modules/positioning/assessment.ts). That
-- map is part of ASSESSMENT_SHA256, so a built-in row cannot store a title here.
-- catalog_version remains the optimistic version: profile edits and a merge that
-- writes an alias increment it. Rows already in the catalog keep version 1.
-- New columns inherit the table privileges already granted to the runtime role.
-- No column GRANT: default privileges cover columns added to an existing table.
-- PostgreSQL text cannot store NUL. The line check rejects the other C0 controls
-- and DEL, matching the API single-line rule (\x00-\x1f and \x7f).

CREATE FUNCTION guild_catalog_line_ok(value text, max_len integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT value IS NOT NULL
    AND char_length(value) <= max_len
    AND value = btrim(value)
    AND value !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || ']');
$$;

ALTER TABLE positioning_guild_catalog
  ADD COLUMN alias text NOT NULL DEFAULT '',
  ADD COLUMN profession_title text NOT NULL DEFAULT '',
  ADD CONSTRAINT positioning_guild_catalog_alias_ok CHECK (guild_catalog_line_ok(alias, 100)),
  ADD CONSTRAINT positioning_guild_catalog_profession_title_ok CHECK (guild_catalog_line_ok(profession_title, 40)),
  ADD CONSTRAINT positioning_guild_catalog_profession_title_custom_only CHECK (
    profession_title = '' OR guild_key LIKE 'guild_custom\_%'
  );
