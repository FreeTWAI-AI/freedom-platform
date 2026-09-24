-- Agent-assisted skill drafts. A member's persistent upload key can only create
-- a private draft; each draft receives a one-time upload grant. Publication is a
-- separate browser action by the owner that imports the real public GitHub
-- repository. Raw keys and grants are never stored, only SHA-256 digests.
CREATE TABLE skill_upload_keys (
  key_id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities,
  user_id uuid NOT NULL REFERENCES users,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  scope text NOT NULL DEFAULT 'skill:submit' CHECK (scope='skill:submit'),
  token_hash text UNIQUE NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '90 days 1 minute')
);
CREATE INDEX skill_upload_keys_owner ON skill_upload_keys(community_id,user_id,created_at DESC);

CREATE TABLE skill_submissions (
  submission_id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities,
  owner_ref uuid NOT NULL REFERENCES users,
  status text NOT NULL DEFAULT 'awaiting_upload' CHECK (status IN ('awaiting_upload','ready_for_review','published','revoked')),
  -- Draft created by an agent key; NULL when issued from the browser.
  origin_key_id uuid REFERENCES skill_upload_keys,
  -- Current one-time grant. grant_key_id ties it to the key that minted it, so
  -- revoking or expiring that key also invalidates the grant.
  grant_hash text UNIQUE CHECK (grant_hash ~ '^[a-f0-9]{64}$'),
  grant_key_id uuid REFERENCES skill_upload_keys,
  grant_expires_at timestamptz,
  grant_consumed_at timestamptz,
  grant_revoked_at timestamptz,
  payload jsonb,
  payload_sha256 text CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  image_bytes bytea CHECK (image_bytes IS NULL OR octet_length(image_bytes) BETWEEN 1 AND 524288),
  consent_to_share boolean NOT NULL DEFAULT false,
  project_id uuid REFERENCES oss_projects,
  project_version_id uuid REFERENCES oss_project_versions,
  published_at timestamptz,
  revoked_at timestamptz,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((payload IS NULL) = (payload_sha256 IS NULL)),
  CHECK ((grant_hash IS NULL) = (grant_expires_at IS NULL)),
  CHECK (grant_key_id IS NULL OR grant_hash IS NOT NULL),
  CHECK (status<>'awaiting_upload' OR (payload IS NULL AND grant_consumed_at IS NULL)),
  CHECK (status NOT IN ('ready_for_review','published') OR (payload IS NOT NULL AND grant_consumed_at IS NOT NULL)),
  CHECK ((status='published') = (project_id IS NOT NULL AND project_version_id IS NOT NULL AND published_at IS NOT NULL AND consent_to_share)),
  CHECK ((status='revoked') = (revoked_at IS NOT NULL)),
  CHECK (image_bytes IS NULL OR payload IS NOT NULL)
);
CREATE INDEX skill_submissions_owner ON skill_submissions(community_id,owner_ref,created_at DESC);
CREATE INDEX skill_submissions_published ON skill_submissions(published_at DESC) WHERE status='published';

-- Idempotency receipts for agent draft creation. Only public metadata is kept:
-- the one-time grant secret is returned once and never cached here.
CREATE TABLE skill_agent_receipts (
  key_id uuid NOT NULL REFERENCES skill_upload_keys,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_id,operation,idempotency_key)
);
