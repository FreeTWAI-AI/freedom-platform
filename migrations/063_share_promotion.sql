-- Personal share links, credited clicks, and the social-post zone.
-- Click points are display-only. They are never XP, rewards, contributions or work records.
-- Raw IP addresses and User-Agent strings are not stored. Daily salts are short-lived.
-- Objects are owned by the migrator role. Default privileges grant the runtime role.

CREATE TABLE promotion_links (
  link_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(community_id),
  user_id uuid NOT NULL REFERENCES users(user_id),
  kind text NOT NULL CHECK (kind IN ('member_card','platform','skill_book','social_post','member_service','event')),
  target_key text NOT NULL CHECK (char_length(target_key) BETWEEN 1 AND 80),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9_-]{10}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX promotion_links_active_owner
  ON promotion_links(community_id, user_id, kind, target_key) WHERE revoked_at IS NULL;
CREATE INDEX promotion_links_owner_day ON promotion_links(user_id, created_at);

CREATE TABLE promotion_clicks (
  link_id uuid NOT NULL REFERENCES promotion_links(link_id),
  click_day date NOT NULL,
  visitor_key text NOT NULL CHECK (char_length(visitor_key) BETWEEN 1 AND 80),
  network_key text NOT NULL CHECK (network_key ~ '^[0-9a-f]{64}$'),
  community_id uuid NOT NULL,
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('member_card','platform','skill_book','social_post','member_service','event')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (link_id, click_day, visitor_key)
);
CREATE INDEX promotion_clicks_board ON promotion_clicks(community_id, kind, created_at);
CREATE INDEX promotion_clicks_visitor_day ON promotion_clicks(click_day, visitor_key);
CREATE INDEX promotion_clicks_network_day ON promotion_clicks(click_day, network_key);

CREATE TABLE promotion_click_salts (
  click_day date PRIMARY KEY,
  salt bytea NOT NULL CHECK (octet_length(salt) = 32),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE community_social_posts (
  post_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(community_id),
  author_user_id uuid NOT NULL REFERENCES users(user_id),
  url text NOT NULL CHECK (char_length(url) BETWEEN 12 AND 2048 AND url LIKE 'https://%'),
  platform text NOT NULL CHECK (platform IN ('youtube','instagram','facebook','threads','tiktok','x','other')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  state text NOT NULL CHECK (state IN ('active','hidden','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX community_social_posts_active_url
  ON community_social_posts(community_id, url) WHERE state = 'active';
CREATE INDEX community_social_posts_feed
  ON community_social_posts(community_id, created_at DESC, post_id DESC) WHERE state = 'active';
CREATE INDEX community_social_posts_author_day ON community_social_posts(author_user_id, created_at);

CREATE TABLE community_social_post_thumbnails (
  post_id uuid PRIMARY KEY REFERENCES community_social_posts(post_id) ON DELETE CASCADE,
  image_bytes bytea NOT NULL CHECK (octet_length(image_bytes) BETWEEN 1 AND 524288),
  source text NOT NULL CHECK (source IN ('youtube','page','upload')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
