-- Member professional services and their public covers.
-- Click points stay on promotion_clicks. They are never XP, rewards, contributions or work records.
-- At most five active or paused services per owner is enforced in the application, with an advisory lock.
-- Objects are owned by the migrator role. Default privileges grant the runtime role.

CREATE TABLE member_services (
  service_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(community_id),
  owner_user_id uuid NOT NULL REFERENCES users(user_id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  category text NOT NULL CHECK (category IN ('hair_beauty','courses','language','design','photo_video','tech','consulting','handmade','other')),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 160),
  description text CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 2000),
  price_text text CHECK (price_text IS NULL OR char_length(price_text) BETWEEN 1 AND 60),
  area_text text CHECK (area_text IS NULL OR char_length(area_text) BETWEEN 1 AND 60),
  service_mode text NOT NULL CHECK (service_mode IN ('online','in_person','both')),
  contacts jsonb NOT NULL CHECK (jsonb_typeof(contacts) = 'array' AND jsonb_array_length(contacts) BETWEEN 1 AND 3),
  state text NOT NULL CHECK (state IN ('active','paused','hidden','deleted')),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX member_services_public
  ON member_services(community_id, updated_at DESC, service_id DESC) WHERE state = 'active';
CREATE INDEX member_services_owner
  ON member_services(owner_user_id, updated_at DESC) WHERE state IN ('active', 'paused');

CREATE TABLE member_service_covers (
  service_id uuid PRIMARY KEY REFERENCES member_services(service_id) ON DELETE CASCADE,
  image_bytes bytea NOT NULL CHECK (octet_length(image_bytes) BETWEEN 1 AND 524288),
  updated_at timestamptz NOT NULL DEFAULT now()
);
