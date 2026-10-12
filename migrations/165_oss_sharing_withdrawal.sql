-- Publication visibility belongs to the existing project aggregate. Retain
-- source versions and private author records when the member withdraws sharing.
ALTER TABLE oss_projects ADD COLUMN sharing_withdrawn_at timestamptz;
