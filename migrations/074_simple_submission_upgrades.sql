-- A published simple submission (簡易投稿) can be upgraded into a full skill book through one private draft seeded from it.
ALTER TABLE skill_submissions
  ADD COLUMN upgrades_submission_id uuid REFERENCES skill_submissions,
  ADD COLUMN seed jsonb,
  ADD CONSTRAINT skill_submissions_seed_pair CHECK ((seed IS NULL) = (upgrades_submission_id IS NULL));
CREATE UNIQUE INDEX skill_submissions_one_open_upgrade ON skill_submissions(upgrades_submission_id)
  WHERE upgrades_submission_id IS NOT NULL AND status IN ('awaiting_upload','ready_for_review');
CREATE UNIQUE INDEX skill_submissions_one_published_upgrade ON skill_submissions(upgrades_submission_id)
  WHERE upgrades_submission_id IS NOT NULL AND status = 'published';
