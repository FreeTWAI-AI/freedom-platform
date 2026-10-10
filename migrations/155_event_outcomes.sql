-- Authored event recaps reference current canonical sources; no source prose is copied.
CREATE TABLE community_event_outcomes (
 outcome_id uuid PRIMARY KEY,
 event_id uuid NOT NULL REFERENCES community_events,
 community_id uuid NOT NULL REFERENCES communities,
 author_user_id uuid NOT NULL REFERENCES users,
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 120),
 summary text NOT NULL CHECK(char_length(summary) BETWEEN 1 AND 4000),
 audience text NOT NULL CHECK(audience IN ('public','community','guild')),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','published','withdrawn')),
 aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0),
 consent_recorded_at timestamptz,
 published_at timestamptz,
 withdrawn_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(outcome_id,event_id,community_id,author_user_id),
 CHECK(state<>'published' OR (consent_recorded_at IS NOT NULL AND published_at IS NOT NULL)),
 FOREIGN KEY(event_id,community_id) REFERENCES community_events(event_id,community_id),
 FOREIGN KEY(author_user_id,community_id) REFERENCES users(user_id,community_id)
);
CREATE INDEX community_event_outcomes_event ON community_event_outcomes(event_id,created_at,outcome_id);
CREATE FUNCTION preserve_event_outcome_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.outcome_id,NEW.event_id,NEW.community_id,NEW.author_user_id,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.outcome_id,OLD.event_id,OLD.community_id,OLD.author_user_id,OLD.created_at) THEN
  RAISE EXCEPTION 'Event outcome source and author are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER preserve_event_outcome_source BEFORE UPDATE ON community_event_outcomes FOR EACH ROW EXECUTE FUNCTION preserve_event_outcome_source();
CREATE TABLE community_event_outcome_refs (
 outcome_id uuid NOT NULL REFERENCES community_event_outcomes ON DELETE CASCADE,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 7),
 source_kind text NOT NULL CHECK(source_kind IN ('work','skill_book','squad_outcome')),
 source_id text NOT NULL CHECK(char_length(source_id) BETWEEN 1 AND 100),
 PRIMARY KEY(outcome_id,ordinal), UNIQUE(outcome_id,source_kind,source_id)
);
CREATE INDEX community_event_outcome_refs_reverse ON community_event_outcome_refs(source_kind,source_id,outcome_id);
ALTER TABLE community_event_highlights ADD CONSTRAINT event_highlight_outcome_identity UNIQUE(media_id,event_id,community_id,uploader_user_id);
CREATE TABLE community_event_outcome_media (
 media_id uuid PRIMARY KEY,
 outcome_id uuid NOT NULL,
 event_id uuid NOT NULL,
 community_id uuid NOT NULL,
 author_user_id uuid NOT NULL,
 FOREIGN KEY(outcome_id,event_id,community_id,author_user_id) REFERENCES community_event_outcomes(outcome_id,event_id,community_id,author_user_id),
 FOREIGN KEY(media_id,event_id,community_id,author_user_id) REFERENCES community_event_highlights(media_id,event_id,community_id,uploader_user_id)
);
CREATE INDEX community_event_outcome_media_entry ON community_event_outcome_media(outcome_id);
-- A binding cannot be removed/reparented to make withdrawn/private bytes public again.
CREATE FUNCTION immutable_event_outcome_media() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Event outcome media bindings are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_event_outcome_media BEFORE UPDATE OR DELETE ON community_event_outcome_media FOR EACH ROW EXECUTE FUNCTION immutable_event_outcome_media();
