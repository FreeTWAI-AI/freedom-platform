-- Guild announcements and council are community-private. Skill editorial is a
-- deliberately public catalog document, governed by one explicit owning community.
CREATE TABLE guild_announcements (
 announcement_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities,
 guild_key text NOT NULL REFERENCES positioning_guild_catalog, author_user_id uuid NOT NULL REFERENCES users,
 title text NOT NULL, body text NOT NULL, state text NOT NULL CHECK(state IN ('draft','published','archived')),
 aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guild_announcements_scope ON guild_announcements(community_id,guild_key,created_at DESC);
CREATE TABLE skill_editorial_ownership (
 book_id text PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities,
 UNIQUE(book_id,community_id)
);
CREATE TABLE skill_book_maintainers (
 book_id text NOT NULL, community_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES users,
 appointed_by uuid NOT NULL REFERENCES platform_admins, active boolean NOT NULL,
 aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0), appointed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(book_id,user_id), FOREIGN KEY(book_id,community_id) REFERENCES skill_editorial_ownership(book_id,community_id)
);
CREATE TABLE skill_book_editorial (
 book_id text PRIMARY KEY, community_id uuid NOT NULL,
 summary text NOT NULL, collaboration_intro text NOT NULL,
 milestones jsonb NOT NULL CHECK(jsonb_typeof(milestones)='array'), tasks jsonb NOT NULL CHECK(jsonb_typeof(tasks)='array'),
 updated_by uuid NOT NULL REFERENCES users, aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(book_id,community_id) REFERENCES skill_editorial_ownership(book_id,community_id)
);
CREATE TABLE guild_council_threads (
 thread_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities,
 author_user_id uuid REFERENCES users, author_admin_id uuid REFERENCES platform_admins,
 title text NOT NULL, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((author_user_id IS NOT NULL) <> (author_admin_id IS NOT NULL))
);
CREATE INDEX guild_council_threads_scope ON guild_council_threads(community_id,created_at DESC);
CREATE TABLE guild_council_replies (
 reply_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities,
 thread_id uuid NOT NULL REFERENCES guild_council_threads, author_user_id uuid REFERENCES users, author_admin_id uuid REFERENCES platform_admins,
 body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((author_user_id IS NOT NULL) <> (author_admin_id IS NOT NULL))
);
CREATE INDEX guild_council_replies_scope ON guild_council_replies(community_id,thread_id,created_at);
