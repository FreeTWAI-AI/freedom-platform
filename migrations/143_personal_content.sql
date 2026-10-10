-- Existing showcases retain their original community publication semantics.
ALTER TABLE showcases ADD COLUMN status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','withdrawn'));
ALTER TABLE showcases ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE showcases ALTER COLUMN consent_recorded_at DROP NOT NULL;
ALTER TABLE showcases DROP CONSTRAINT showcases_visibility_check;
ALTER TABLE showcases ADD CONSTRAINT showcases_visibility_check CHECK (visibility IN ('private','community'));
ALTER TABLE showcases ADD CONSTRAINT showcases_publication_check CHECK (
  (status='published' AND visibility='community' AND consent_recorded_at IS NOT NULL)
  OR (status IN ('draft','withdrawn') AND visibility='private')
);
CREATE INDEX showcases_owner_content ON showcases(community_id,owner_ref,created_at DESC,showcase_id);

-- Existing cooperation facts must not read later edits of a private draft.
ALTER TABLE opportunities ADD COLUMN showcase_title text;
UPDATE opportunities o SET showcase_title=s.title FROM showcases s WHERE s.showcase_id=o.showcase_id;
ALTER TABLE opportunities ALTER COLUMN showcase_title SET NOT NULL;
