-- Repeatable member-owned links. Platform is a category, never a uniqueness or
-- provider-verification claim. Privacy remains per entry and private by default.
CREATE TABLE member_social_links (
 link_id uuid PRIMARY KEY,
 community_id uuid NOT NULL REFERENCES communities,
 user_id uuid NOT NULL REFERENCES users,
 platform text NOT NULL CHECK(platform IN ('facebook','instagram','youtube','threads','tiktok','linkedin','x','website','other')),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
 url text NOT NULL CHECK(length(url) BETWEEN 1 AND 2048),
 audiences text[] NOT NULL DEFAULT '{}' CHECK(audiences <@ ARRAY['public','friends','squad','guild']::text[] AND cardinality(audiences)<=4),
 aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE INDEX member_social_links_owner ON member_social_links(community_id,user_id,created_at,link_id) WHERE deleted_at IS NULL;
