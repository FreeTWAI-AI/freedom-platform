-- Coordination metadata only. GitHub Issues and PRs remain the task and review records.
CREATE TABLE co_creation_projects (
  project_id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities,
  source_project_id uuid UNIQUE NOT NULL REFERENCES oss_projects,
  coordinator_ref uuid NOT NULL REFERENCES users,
  title text NOT NULL,
  goal text NOT NULL,
  help_wanted jsonb NOT NULL,
  contribution_notes text NOT NULL,
  aggregate_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX co_creation_by_community ON co_creation_projects(community_id,created_at);
