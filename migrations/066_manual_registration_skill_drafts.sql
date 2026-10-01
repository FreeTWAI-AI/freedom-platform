-- A manual registration (手動登錄作品) seeds one private skill draft with the member's own registration text.
ALTER TABLE skill_submissions
  ADD COLUMN source_project_id uuid REFERENCES oss_projects,
  ADD COLUMN seed jsonb,
  ADD CONSTRAINT skill_submissions_seed_pair CHECK ((seed IS NULL) = (source_project_id IS NULL));
CREATE UNIQUE INDEX skill_submissions_one_open_seed ON skill_submissions(source_project_id)
  WHERE source_project_id IS NOT NULL AND status IN ('awaiting_upload','ready_for_review');
