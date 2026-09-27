-- Preserve the submitted title while GitHub's public issue list catches up.
ALTER TABLE github_page_issue_submissions ADD COLUMN issue_title text CHECK (char_length(issue_title) BETWEEN 1 AND 1000);

-- A claim is recorded before the external write. An uncertain result must not
-- be retried automatically because GitHub may already have posted the comment.
CREATE TABLE github_design_claim_submissions (
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  operation_key text NOT NULL CHECK (char_length(operation_key) BETWEEN 8 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  page_id text NOT NULL CHECK (page_id ~ '^[a-z0-9-]{1,64}$'),
  issue_number integer NOT NULL CHECK (issue_number > 0),
  state text NOT NULL CHECK (state IN ('pending','confirmed','denied')),
  comment_id bigint CHECK (comment_id > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id,operation_key),
  CHECK ((state='confirmed') = (comment_id IS NOT NULL))
);
CREATE INDEX github_design_claim_by_issue ON github_design_claim_submissions(user_id,issue_number,created_at DESC);
