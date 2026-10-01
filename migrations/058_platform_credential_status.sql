-- Platform credential expiry and Cloudflare renewal requests.
-- GitHub expiry is copied from an authenticated response header.
-- The Worker never holds a Cloudflare token. A local executor renews it
-- and writes the result with the statements documented below.
-- Objects are owned by the migrator role. Default privileges grant the runtime role.
--
-- Executor contract (same role as the Worker):
--   UPDATE platform_credential_renewal_requests
--     SET state='processing'
--     WHERE state='pending' AND credential_key='cloudflare_deploy_token'
--     RETURNING request_id;
--   UPDATE platform_credential_renewal_requests
--     SET state=$2, processed_at=now(), result_expires_at=$3, error_code=$4
--     WHERE request_id=$1;
--   INSERT INTO platform_credential_status(credential_key,status,expires_at,checked_at,source,note)
--     VALUES('cloudflare_deploy_token',$1,$2,now(),'local_executor',$3)
--     ON CONFLICT (credential_key) DO UPDATE SET
--       status=EXCLUDED.status, expires_at=EXCLUDED.expires_at,
--       checked_at=EXCLUDED.checked_at, source=EXCLUDED.source, note=EXCLUDED.note;
CREATE TABLE platform_credential_status (
  credential_key text PRIMARY KEY CHECK (credential_key IN ('github_metrics_token', 'cloudflare_deploy_token')),
  status text NOT NULL CHECK (status IN ('ok', 'rejected', 'unknown')),
  expires_at timestamptz,
  checked_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('github_response', 'local_executor')),
  note text CHECK (char_length(note) <= 200)
);

CREATE TABLE platform_credential_renewal_requests (
  request_id uuid PRIMARY KEY,
  credential_key text NOT NULL CHECK (credential_key = 'cloudflare_deploy_token'),
  requested_by uuid NOT NULL REFERENCES users (user_id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'done', 'failed')),
  processed_at timestamptz,
  result_expires_at timestamptz,
  error_code text CHECK (error_code ~ '^[a-z0-9_]{1,64}$')
);

-- At most one open request per credential. done and failed rows stay as history.
CREATE UNIQUE INDEX platform_credential_renewal_one_open
  ON platform_credential_renewal_requests (credential_key)
  WHERE state IN ('pending', 'processing');
