CREATE TABLE accounts (
  account_id SERIAL PRIMARY KEY,
  external_ref UUID NOT NULL DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  risk_tags TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  order_id BIGSERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(account_id),
  amount NUMERIC(18,2) NOT NULL,
  currency CHAR(3) NOT NULL,
  status TEXT NOT NULL,
  placed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE heartbeat (
  heartbeat_id BIGSERIAL PRIMARY KEY,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
