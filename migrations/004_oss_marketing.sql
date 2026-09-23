-- Independent open-source registry. Code and releases remain authoritative on GitHub.
-- Importing public metadata never grants repository ownership or official status.
CREATE TABLE oss_projects (
  project_id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities,
  owner_ref uuid NOT NULL REFERENCES users,
  title text NOT NULL,
  description text NOT NULL,
  use_notes text NOT NULL,
  demo_url text,
  repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]*$'),
  repository_full_name text NOT NULL,
  repository_url text NOT NULL,
  relationship text NOT NULL CHECK (relationship IN ('author','maintainer','contributor','curator')),
  relationship_verification text NOT NULL DEFAULT 'self_declared' CHECK (relationship_verification='self_declared'),
  status text NOT NULL DEFAULT 'candidate' CHECK (status='candidate'),
  official boolean NOT NULL DEFAULT false CHECK (NOT official),
  commercial_ready boolean NOT NULL DEFAULT false CHECK (NOT commercial_ready),
  current_version_id uuid,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (community_id,owner_ref,repository_id)
);
CREATE TABLE oss_project_versions (
  version_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES oss_projects,
  repository_id text NOT NULL,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  default_branch text NOT NULL,
  repository_full_name text NOT NULL,
  repository_url text NOT NULL,
  readme_url text NOT NULL,
  license_spdx text NOT NULL,
  license_evidence_url text,
  is_fork boolean NOT NULL,
  archived boolean NOT NULL,
  source_snapshot jsonb NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  facts_sha256 text NOT NULL CHECK (facts_sha256 ~ '^[a-f0-9]{64}$'),
  inspected_at timestamptz NOT NULL,
  -- A repository can be archived/renamed without changing its code commit.
  -- Retain each changed observation while deduplicating unchanged metadata.
  UNIQUE (project_id,facts_sha256),
  UNIQUE (project_id,version_id)
);
ALTER TABLE oss_projects ADD CONSTRAINT oss_current_version
  FOREIGN KEY (project_id,current_version_id) REFERENCES oss_project_versions(project_id,version_id);
CREATE INDEX oss_projects_community ON oss_projects(community_id,created_at);

-- Private campaign drafts only; no simulated publication, conversion or money movement.
CREATE TABLE marketing_campaign_drafts (
  campaign_id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities,
  owner_ref uuid NOT NULL REFERENCES users,
  title text NOT NULL,
  audience text NOT NULL,
  goal text NOT NULL,
  draft_text text NOT NULL,
  source_project_id uuid REFERENCES oss_projects,
  source_version_id uuid REFERENCES oss_project_versions,
  source_supplier_product_id uuid REFERENCES catalog_products,
  source_supplier_offer_id uuid REFERENCES supplier_offer_versions,
  source_snapshot jsonb NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'draft' CHECK (state='draft'),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source_project_id IS NULL) = (source_version_id IS NULL)),
  CHECK ((source_supplier_product_id IS NULL) = (source_supplier_offer_id IS NULL)),
  CHECK (source_project_id IS NULL OR source_supplier_product_id IS NULL)
);
CREATE TABLE marketing_share_records (
  share_id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES marketing_campaign_drafts,
  channel text NOT NULL,
  share_url text NOT NULL,
  note text NOT NULL,
  content_snapshot jsonb NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  verification_status text NOT NULL DEFAULT 'self_reported' CHECK (verification_status='self_reported'),
  recorded_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX marketing_owner ON marketing_campaign_drafts(community_id,owner_ref,created_at);
CREATE INDEX marketing_shares_campaign ON marketing_share_records(campaign_id,created_at);
