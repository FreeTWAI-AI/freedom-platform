-- Authored outcomes are independent of private Results and attendance/XP.
ALTER TABLE member_squads ADD CONSTRAINT squad_outcome_community_identity UNIQUE(squad_id,community_id);
CREATE TABLE member_squad_outcomes (
 outcome_id uuid PRIMARY KEY,
 squad_id uuid NOT NULL,
 community_id uuid NOT NULL REFERENCES communities,
 author_ref uuid NOT NULL,
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 120 AND title !~ '[[:cntrl:]]'),
 summary text NOT NULL CHECK(length(btrim(summary)) BETWEEN 1 AND 4000),
 artifact_url text CHECK(artifact_url IS NULL OR (length(artifact_url) BETWEEN 1 AND 2000 AND artifact_url LIKE 'https://%')),
 audience text NOT NULL DEFAULT 'squad' CHECK(audience IN ('squad','community','public')),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','published','withdrawn')),
 consent_recorded_at timestamptz,
 published_at timestamptz,
 withdrawn_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 aggregate_version integer NOT NULL DEFAULT 1 CHECK(aggregate_version>0),
 FOREIGN KEY(squad_id,community_id) REFERENCES member_squads(squad_id,community_id),
 FOREIGN KEY(author_ref,community_id) REFERENCES users(user_id,community_id),
 CHECK(state<>'published' OR (consent_recorded_at IS NOT NULL AND published_at IS NOT NULL AND withdrawn_at IS NULL)),
 CHECK(state<>'withdrawn' OR withdrawn_at IS NOT NULL)
);
CREATE INDEX squad_outcomes_listing ON member_squad_outcomes(squad_id,created_at DESC,outcome_id);
CREATE INDEX squad_outcomes_authored ON member_squad_outcomes(community_id,author_ref,created_at DESC,outcome_id);
CREATE FUNCTION preserve_squad_outcome_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.outcome_id,NEW.squad_id,NEW.community_id,NEW.author_ref,NEW.created_at) IS DISTINCT FROM ROW(OLD.outcome_id,OLD.squad_id,OLD.community_id,OLD.author_ref,OLD.created_at) THEN
  RAISE EXCEPTION 'Squad outcome author/source cannot be rebound' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER preserve_squad_outcome_source BEFORE UPDATE ON member_squad_outcomes FOR EACH ROW EXECUTE FUNCTION preserve_squad_outcome_source();
