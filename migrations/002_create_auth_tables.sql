CREATE TABLE IF NOT EXISTS merchant_users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'operator', 'reviewer')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email = lower(email))
);

CREATE TABLE IF NOT EXISTS merchant_sessions (
  sid varchar NOT NULL COLLATE "default",
  sess json NOT NULL,
  expire timestamp(6) NOT NULL,
  CONSTRAINT merchant_sessions_pkey PRIMARY KEY (sid)
);

CREATE INDEX IF NOT EXISTS merchant_sessions_expire_idx
  ON merchant_sessions (expire);
