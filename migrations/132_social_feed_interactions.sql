-- Extend the existing member-only feed; likes are not XP or promotion clicks.
ALTER TABLE community_social_posts ADD COLUMN kind text NOT NULL DEFAULT 'link'
  CHECK (kind IN ('link','note'));
ALTER TABLE community_social_posts ALTER COLUMN url DROP NOT NULL;
ALTER TABLE community_social_posts DROP CONSTRAINT community_social_posts_note_check;
ALTER TABLE community_social_posts ADD CONSTRAINT social_post_content CHECK (
  (kind='link' AND url IS NOT NULL AND (note IS NULL OR char_length(note) BETWEEN 1 AND 500)) OR
  (kind='note' AND url IS NULL AND platform='other' AND note IS NOT NULL AND char_length(btrim(note)) BETWEEN 1 AND 2000)
);
ALTER TABLE community_social_posts ADD CONSTRAINT social_post_community UNIQUE (post_id,community_id);

CREATE TABLE community_social_likes (
  post_id uuid NOT NULL,
  community_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(post_id,user_id),
  FOREIGN KEY(post_id,community_id) REFERENCES community_social_posts(post_id,community_id) ON DELETE CASCADE
);
CREATE TABLE community_social_comments (
  comment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL,
  community_id uuid NOT NULL,
  author_user_id uuid NOT NULL REFERENCES users(user_id),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 1000),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','deleted','hidden')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(post_id,community_id) REFERENCES community_social_posts(post_id,community_id) ON DELETE CASCADE
);
CREATE INDEX social_comments_page ON community_social_comments(post_id,created_at,comment_id) WHERE state='active';
CREATE INDEX social_comments_author_day ON community_social_comments(author_user_id,created_at);
