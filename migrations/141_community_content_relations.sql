-- Private references only: targets deliberately have no FK so withdrawn content stays removable.
CREATE TABLE community_content_bookmarks (
  relation_id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities,
  owner_user_id uuid NOT NULL,
  content_kind text NOT NULL CHECK(content_kind IN ('post','event','work','skill_book')),
  content_id text NOT NULL CHECK(length(content_id) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version > 0),
  FOREIGN KEY(owner_user_id,community_id) REFERENCES users(user_id,community_id),
  UNIQUE(community_id,owner_user_id,content_kind,content_id)
);
CREATE INDEX community_bookmarks_owner_page ON community_content_bookmarks(community_id,owner_user_id,created_at DESC,relation_id);
CREATE TABLE community_content_follows (
  relation_id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities,
  owner_user_id uuid NOT NULL,
  target_kind text NOT NULL CHECK(target_kind IN ('author','topic')),
  target_id text NOT NULL CHECK(length(target_id) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version > 0),
  FOREIGN KEY(owner_user_id,community_id) REFERENCES users(user_id,community_id),
  UNIQUE(community_id,owner_user_id,target_kind,target_id)
);
CREATE INDEX community_follows_owner ON community_content_follows(community_id,owner_user_id,created_at DESC,relation_id);
