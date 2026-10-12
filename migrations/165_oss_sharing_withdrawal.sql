-- Publication visibility belongs to the existing project aggregate. Retain
-- source versions and private author records when the member withdraws sharing.
ALTER TABLE oss_projects ADD COLUMN sharing_withdrawn_at timestamptz;

-- A prepared publication is an explicit snapshot of the author's project.
-- Keep this binding separate from the published project/version foreign keys.
ALTER TABLE skill_submissions
  ADD COLUMN prepared_project_id uuid REFERENCES oss_projects,
  ADD COLUMN prepared_project_version bigint,
  ADD CONSTRAINT skill_submission_prepared_project_binding CHECK (
    (prepared_project_id IS NULL) = (prepared_project_version IS NULL)
    AND (prepared_project_version IS NULL OR prepared_project_version > 0)
  );
