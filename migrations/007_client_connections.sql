-- Explicitly approved, revocable read-only connections. Neither device secrets nor bearer tokens are stored in plaintext.
CREATE TABLE member_client_connections (
  connection_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities, user_id uuid NOT NULL REFERENCES users,
  client_name text NOT NULL, kind text NOT NULL CHECK(kind IN ('storefront','supplier')),
  scope text NOT NULL CHECK(scope IN ('storefront:read','supplier:read')),
  store_id uuid, token_hash text UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  aggregate_version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days', revoked_at timestamptz,
  FOREIGN KEY(store_id,community_id) REFERENCES retail_stores(store_id,community_id),
  CHECK((kind='storefront' AND scope='storefront:read' AND store_id IS NOT NULL) OR (kind='supplier' AND scope='supplier:read' AND store_id IS NULL))
);
CREATE TABLE client_pairing_requests (
  pairing_id uuid PRIMARY KEY, device_secret_hash text UNIQUE NOT NULL CHECK(device_secret_hash ~ '^[a-f0-9]{64}$'),
  user_code_hash text UNIQUE NOT NULL CHECK(user_code_hash ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK(kind IN ('storefront','supplier')), client_name text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','issued')),
  connection_id uuid REFERENCES member_client_connections,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
  last_polled_at timestamptz,
  CHECK((state='pending' AND connection_id IS NULL) OR (state IN ('approved','issued') AND connection_id IS NOT NULL))
);
CREATE INDEX client_pairing_expiry ON client_pairing_requests(expires_at);
CREATE INDEX member_client_connections_owner ON member_client_connections(community_id,user_id,created_at DESC);
