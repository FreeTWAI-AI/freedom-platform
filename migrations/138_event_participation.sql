-- Participation is opt-in. Existing event publication and review authority do not change.
ALTER TABLE community_events
  ADD COLUMN waitlist_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN response_window_minutes bigint,
  ADD COLUMN waitlist_reconciled_at timestamptz,
  ADD CHECK(response_window_minutes IS NULL OR response_window_minutes BETWEEN 1 AND 9007199254740991),
  ADD CHECK(NOT waitlist_enabled OR response_window_minutes IS NOT NULL);

ALTER TABLE community_event_rsvps ADD COLUMN confirmed_at timestamptz;
-- A withdrawal can exist without any prior RSVP; it is not proof of participation.
UPDATE community_event_rsvps r SET confirmed_at=COALESCE(
  (SELECT min(j.created_at) FROM transition_journal j WHERE j.community_id=e.community_id
    AND j.aggregate_type='community_event_rsvp' AND j.aggregate_id=r.rsvp_id
    AND j.actor_ref=r.user_id AND j.command='rsvp'),
  CASE WHEN r.state='going' THEN r.created_at END)
FROM community_events e WHERE e.event_id=r.event_id;
ALTER TABLE community_event_guest_rsvps
  ADD COLUMN state text NOT NULL DEFAULT 'going' CHECK(state IN ('pending','going','cancelled')),
  ADD COLUMN registration_attempt_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN confirmed_at timestamptz;
UPDATE community_event_guest_rsvps SET state='pending' WHERE email_sent_at IS NULL;

-- Raw capabilities are private server mail custody only. API lookup uses the hash;
-- none of these fields belong in DTOs, receipts, public links, analytics or logs.
CREATE TABLE community_event_guest_capabilities (
  event_id uuid NOT NULL REFERENCES community_events ON DELETE CASCADE,
  email text NOT NULL CHECK(email=lower(btrim(email)) AND length(email) BETWEEN 1 AND 200),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  referral_code text CHECK(referral_code ~ '^[A-Za-z0-9_-]{16,32}$'),
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  token_secret text NOT NULL CHECK(token_secret ~ '^[A-Za-z0-9_-]{43}$'),
  provider_status text NOT NULL DEFAULT 'pending' CHECK(provider_status IN ('pending','provider_accepted','failed')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(event_id,email)
);
CREATE TABLE community_event_waitlist (
  entry_id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES community_events ON DELETE CASCADE,
  member_ref uuid REFERENCES users,
  guest_email text,
  referral_code text CHECK(referral_code ~ '^[A-Za-z0-9_-]{16,32}$'),
  status text NOT NULL CHECK(status IN ('queued','invited','accepted','declined','left','expired','cancelled')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  invited_at timestamptz,
  expires_at timestamptz,
  invitation_id uuid,
  delivery_status text NOT NULL DEFAULT 'pending' CHECK(delivery_status IN ('pending','recorded','unknown','provider_accepted','failed')),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version BETWEEN 1 AND 9007199254740991),
  CHECK((member_ref IS NULL)<>(guest_email IS NULL)),
  CHECK(status<>'invited' OR (invited_at IS NOT NULL AND expires_at>invited_at AND invitation_id IS NOT NULL)),
  FOREIGN KEY(event_id,guest_email) REFERENCES community_event_guest_capabilities(event_id,email),
  UNIQUE(event_id,member_ref),
  UNIQUE(event_id,guest_email)
);
CREATE INDEX community_event_waitlist_fifo ON community_event_waitlist(event_id,joined_at,entry_id) WHERE status='queued';
CREATE INDEX community_event_waitlist_deadline ON community_event_waitlist(expires_at,event_id) WHERE status='invited';

-- Automatic expiry and provider handoffs have no human author. Preserve actual
-- row transitions rather than attributing scheduled work to the organizer.
CREATE TABLE community_event_waitlist_transitions (
  transition_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id uuid NOT NULL REFERENCES community_event_waitlist ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  entry_version bigint NOT NULL,
  invitation_id uuid,
  joined_at timestamptz NOT NULL,
  invited_at timestamptz,
  expires_at timestamptz,
  delivery_status text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX community_event_waitlist_transition_entry ON community_event_waitlist_transitions(entry_id,transition_id);
CREATE FUNCTION record_event_waitlist_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' OR (OLD.status,OLD.invitation_id,OLD.expires_at,OLD.delivery_status)
    IS DISTINCT FROM (NEW.status,NEW.invitation_id,NEW.expires_at,NEW.delivery_status) THEN
    INSERT INTO community_event_waitlist_transitions(entry_id,from_status,to_status,entry_version,invitation_id,joined_at,invited_at,expires_at,delivery_status)
    VALUES(NEW.entry_id,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.status END,NEW.status,NEW.aggregate_version,NEW.invitation_id,NEW.joined_at,NEW.invited_at,NEW.expires_at,NEW.delivery_status);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_waitlist_transition AFTER INSERT OR UPDATE ON community_event_waitlist
  FOR EACH ROW EXECUTE FUNCTION record_event_waitlist_transition();

CREATE TABLE community_event_guest_commands (
  event_id uuid NOT NULL,
  email text NOT NULL,
  command_id text NOT NULL CHECK(command_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  body_hash text NOT NULL CHECK(body_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
  PRIMARY KEY(event_id,email,command_id),
  FOREIGN KEY(event_id,email) REFERENCES community_event_guest_capabilities(event_id,email) ON DELETE CASCADE
);
CREATE TABLE community_event_participation_notices (
  notice_id uuid PRIMARY KEY,
  event_id uuid NOT NULL,
  guest_email text NOT NULL,
  event_version bigint NOT NULL CHECK(event_version BETWEEN 1 AND 9007199254740991),
  kind text NOT NULL CHECK(kind IN ('event_schedule_changed','event_cancelled')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','unknown','provider_accepted','failed')),
  FOREIGN KEY(event_id,guest_email) REFERENCES community_event_guest_capabilities(event_id,email) ON DELETE CASCADE,
  UNIQUE(event_id,guest_email,event_version,kind)
);
CREATE TABLE community_event_reminders (
  reminder_id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES community_events ON DELETE CASCADE,
  member_ref uuid REFERENCES users,
  guest_email text,
  minutes_before_start bigint NOT NULL CHECK(minutes_before_start BETWEEN 1 AND 9007199254740991),
  channel text NOT NULL CHECK(channel IN ('in_app','email')),
  enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL CHECK(status IN ('pending','provider_accepted','recorded','cancelled','failed')),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version BETWEEN 1 AND 9007199254740991),
  event_version bigint NOT NULL CHECK(event_version BETWEEN 1 AND 9007199254740991),
  starts_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  attempted_at timestamptz,
  processed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((member_ref IS NULL)<>(guest_email IS NULL)),
  CHECK(guest_email IS NULL OR channel='email'),
  FOREIGN KEY(event_id,guest_email) REFERENCES community_event_guest_capabilities(event_id,email),
  UNIQUE(event_id,member_ref),
  UNIQUE(event_id,guest_email)
);
CREATE INDEX community_event_reminders_due ON community_event_reminders(due_at,reminder_id) WHERE enabled AND status='pending';
CREATE TABLE community_event_reminder_receipts (
  event_id uuid NOT NULL,
  guest_email text NOT NULL,
  command_id text NOT NULL CHECK(command_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
  PRIMARY KEY(event_id,guest_email,command_id),
  FOREIGN KEY(event_id,guest_email) REFERENCES community_event_guest_capabilities(event_id,email) ON DELETE CASCADE
);
CREATE TABLE community_event_reminder_attempts (
  reminder_id uuid NOT NULL REFERENCES community_event_reminders ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  minutes_before_start bigint NOT NULL,
  channel text NOT NULL CHECK(channel IN ('in_app','email')),
  status text NOT NULL CHECK(status IN ('failed','provider_accepted','recorded')),
  attempted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(reminder_id,starts_at,minutes_before_start,channel)
);
ALTER TABLE member_notifications DROP CONSTRAINT member_notifications_kind_check;
ALTER TABLE member_notifications ADD CONSTRAINT member_notifications_kind_check CHECK(kind IN (
  'friend_request','friend_accepted','friend_declined','squad_invitation',
  'guild_application_approved','guild_application_rejected',
  'guild_expert_appointed','guild_expert_revoked','guild_master_appointed','guild_master_revoked',
  'guild_member_promoted','guild_member_demoted',
  'event_submitted','event_review_needed','event_approved','event_rejected',
  'event_waitlist_invited','event_schedule_changed','event_cancelled','event_start_reminder'));
