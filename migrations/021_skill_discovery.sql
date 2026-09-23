-- Rankings count member-directed, GitHub-confirmed Stars, not visits or self-entered handles.
CREATE TABLE skill_star_support (
  github_user_id text NOT NULL CHECK (github_user_id ~ '^[0-9]+$'),
  repository_key text NOT NULL,
  first_confirmed_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL,
  last_confirmed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (github_user_id, repository_key)
);
CREATE INDEX skill_star_support_window ON skill_star_support(first_confirmed_at) WHERE active;

-- Unknown historical publication dates remain unknown. These three books are
-- actually being introduced with this release; timestamps are not reset on read.
CREATE TABLE skill_publications (
  book_id text PRIMARY KEY,
  published_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO skill_publications(book_id) VALUES
  ('event-space'), ('projection-mapping'), ('human-design');
