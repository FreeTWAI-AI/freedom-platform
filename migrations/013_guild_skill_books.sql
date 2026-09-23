-- Administrator-reviewed bindings select existing canonical book IDs; URLs and
-- executable content never come from a guild application or this table.
CREATE TABLE guild_skill_book_bindings (
  community_id uuid NOT NULL REFERENCES communities,
  guild_key text NOT NULL REFERENCES positioning_guild_catalog,
  book_id text NOT NULL CHECK(length(book_id) BETWEEN 1 AND 100),
  PRIMARY KEY(community_id,guild_key,book_id)
);
