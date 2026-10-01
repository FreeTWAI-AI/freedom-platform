-- Quick entry records a member's explicit guild choice, not an assessment result.
ALTER TABLE users ADD COLUMN onboarding_entry_mode text NOT NULL DEFAULT 'assessment'
  CHECK (onboarding_entry_mode IN ('assessment','quick'));

-- Anonymous sharing is separate and opt-in. Platform-public contacts still mean
-- authenticated members only and are never included in this card.
CREATE TABLE member_card_shares (
  user_id uuid PRIMARY KEY REFERENCES users,
  community_id uuid NOT NULL REFERENCES communities,
  share_token text NOT NULL UNIQUE CHECK (share_token ~ '^[A-Za-z0-9_-]{43}$'),
  enabled boolean NOT NULL DEFAULT false,
  include_avatar boolean NOT NULL DEFAULT true,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Public catalog evidence only; no member identities or assessment answers.
CREATE TABLE guild_discovery_reports (
  community_id uuid PRIMARY KEY REFERENCES communities,
  generated_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_id uuid,
  source_sha256 text,
  report jsonb
);
