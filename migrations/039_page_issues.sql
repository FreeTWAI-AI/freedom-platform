-- One member-authorized GitHub issue submission per operation key. A pending
-- result is never retried automatically: GitHub may have accepted the request
-- even if its response did not reach us.
CREATE TABLE github_page_issue_submissions (
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  operation_key text NOT NULL CHECK (char_length(operation_key) BETWEEN 8 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  page_id text NOT NULL CHECK (page_id ~ '^[a-z0-9-]{1,64}$'),
  state text NOT NULL CHECK (state IN ('pending','confirmed','denied')),
  issue_number integer CHECK (issue_number > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id,operation_key),
  CHECK ((state='confirmed') = (issue_number IS NOT NULL))
);
CREATE INDEX github_page_issue_recent ON github_page_issue_submissions(user_id,request_hash,created_at DESC);
