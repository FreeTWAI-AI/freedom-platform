-- Personal reminder policy only; no inbox, read cursor, subscription or delivery writes.
CREATE TABLE member_notification_preferences (
  community_id uuid NOT NULL REFERENCES communities,
  owner_user_id uuid NOT NULL,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version BETWEEN 1 AND 9007199254740991),
  friends_mode text NOT NULL DEFAULT 'instant' CHECK(friends_mode IN ('instant','summary','off')),
  squads_mode text NOT NULL DEFAULT 'instant' CHECK(squads_mode IN ('instant','summary','off')),
  events_mode text NOT NULL DEFAULT 'instant' CHECK(events_mode IN ('instant','summary','off')),
  following_mode text NOT NULL DEFAULT 'instant' CHECK(following_mode IN ('instant','summary','off')),
  quiet_enabled boolean NOT NULL DEFAULT false,
  time_zone text NOT NULL DEFAULT 'Asia/Taipei' CHECK(length(time_zone) BETWEEN 1 AND 100),
  quiet_start text NOT NULL DEFAULT '22:00' CHECK(quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  quiet_end text NOT NULL DEFAULT '08:00' CHECK(quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  muted_channel_ids text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(community_id,owner_user_id),
  FOREIGN KEY(owner_user_id,community_id) REFERENCES users(user_id,community_id),
  CHECK(NOT quiet_enabled OR quiet_start<>quiet_end),
  CHECK(cardinality(muted_channel_ids)<=50 AND array_position(muted_channel_ids,NULL) IS NULL)
);
