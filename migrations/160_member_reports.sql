-- Private member reports are not public feedback or reported-member notifications.
ALTER TABLE community_social_comments DROP CONSTRAINT community_social_comments_state_check;
ALTER TABLE community_social_comments ADD CONSTRAINT community_social_comments_state_check CHECK (state IN ('active','hidden','deleted'));

CREATE TABLE member_reports (
  case_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  community_id uuid NOT NULL REFERENCES communities(community_id),
  reporter_user_id uuid NOT NULL REFERENCES users(user_id),
  target_kind text NOT NULL CHECK (target_kind IN ('post','comment','direct_message','channel_message','member')),
  target_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('harassment','spam','fraud','other')),
  note text CHECK (char_length(note)<=2000),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object'),
  state text NOT NULL DEFAULT 'received' CHECK (state IN ('received','in_progress','closed')),
  aggregate_version integer NOT NULL DEFAULT 1 CHECK (aggregate_version>0),
  handler_user_id uuid REFERENCES users(user_id),
  processing_reason text CHECK (char_length(processing_reason) BETWEEN 1 AND 2000),
  action text NOT NULL DEFAULT 'none' CHECK (action IN ('none','hide','restore')),
  summary text CHECK (char_length(summary)<=2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(reporter_user_id,target_kind,target_id)
);
CREATE INDEX member_reports_reporter_time ON member_reports(reporter_user_id,created_at DESC);
CREATE INDEX member_reports_admin_queue ON member_reports(community_id,state,case_number DESC);
CREATE INDEX member_reports_admin_page ON member_reports(community_id,case_number DESC);
CREATE INDEX member_reports_reporter_page ON member_reports(reporter_user_id,case_number DESC);

-- Preserve the captured evidence and reporter even if live content is edited.
CREATE FUNCTION preserve_member_report_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.community_id,NEW.reporter_user_id,NEW.target_kind,NEW.target_id,NEW.reason,NEW.note,NEW.evidence,NEW.created_at,NEW.case_number,NEW.case_id)
    IS DISTINCT FROM (OLD.community_id,OLD.reporter_user_id,OLD.target_kind,OLD.target_id,OLD.reason,OLD.note,OLD.evidence,OLD.created_at,OLD.case_number,OLD.case_id) THEN
    RAISE EXCEPTION 'member report evidence is immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER member_report_evidence_immutable BEFORE UPDATE ON member_reports FOR EACH ROW EXECUTE FUNCTION preserve_member_report_evidence();
