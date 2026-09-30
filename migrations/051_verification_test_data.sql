-- Derived classification for verification accounts created by
-- scripts/verify-public.mjs and scripts/verify-cloud-candidate-members.ts.
-- Read-only: no UPDATE or DELETE of existing rows. Idempotent.
-- The email suffix lives only in is_verification_test_email.

CREATE OR REPLACE FUNCTION is_verification_test_email(email text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(lower(email) LIKE '%@example.invalid', false)
$$;

CREATE OR REPLACE VIEW member_account_classification AS
SELECT user_id, community_id, is_verification_test_email(email) AS is_test_account
FROM users;

CREATE OR REPLACE VIEW member_squad_classification AS
SELECT s.squad_id, s.community_id, COALESCE(a.is_test_account, false) AS is_test_data
FROM member_squads s
JOIN member_account_classification a ON a.user_id = s.owner_ref AND a.community_id = s.community_id;

CREATE OR REPLACE FUNCTION is_verification_test_account(subject uuid)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    (SELECT c.is_test_account FROM member_account_classification c WHERE c.user_id = subject),
    false)
$$;
