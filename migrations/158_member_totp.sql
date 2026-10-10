-- Member MFA secrets are AES-256-GCM ciphertext; recovery codes are hashes only.
CREATE TABLE member_totp (
  user_id uuid PRIMARY KEY REFERENCES users(user_id),
  secret_ciphertext text,
  enabled boolean NOT NULL DEFAULT false,
  last_counter bigint NOT NULL DEFAULT -1 CHECK (last_counter >= -1),
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  window_start timestamptz NOT NULL DEFAULT now(),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  CHECK (enabled = (secret_ciphertext IS NOT NULL))
);
CREATE TABLE member_totp_backup_codes (
  user_id uuid NOT NULL REFERENCES member_totp(user_id),
  code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (user_id, code_hash)
);
