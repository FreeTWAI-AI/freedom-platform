-- The owner explicitly designated launch day as the joining date for existing
-- members. Keep this provenance distinct from subsequently observed signups.
ALTER TABLE users ADD COLUMN created_at timestamptz;
ALTER TABLE users ADD COLUMN created_at_source text;
UPDATE users SET created_at=TIMESTAMPTZ '2026-09-23 00:00:00+08',created_at_source='launch_day';
ALTER TABLE users ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE users ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE users ALTER COLUMN created_at_source SET DEFAULT 'registered';
ALTER TABLE users ALTER COLUMN created_at_source SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_created_at_source CHECK(created_at_source IN ('launch_day','registered'));
CREATE INDEX member_directory_joined ON users(community_id,created_at,user_id)
 WHERE active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL);
