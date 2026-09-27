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

CREATE OR REPLACE FUNCTION lab_jsonb_canonical(input jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  keys text[];
  k text;
  parts text[];
  elem jsonb;
BEGIN
  IF input IS NULL THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(input) = 'null' THEN
    RETURN 'null';
  END IF;

  IF jsonb_typeof(input) = 'object' THEN
    SELECT array_agg(key ORDER BY key COLLATE "C") INTO keys FROM jsonb_object_keys(input) AS key;
    parts := ARRAY[]::text[];
    IF keys IS NOT NULL THEN
      FOREACH k IN ARRAY keys LOOP
        parts := parts || (to_jsonb(k)::text || ': ' || lab_jsonb_canonical(input -> k));
      END LOOP;
    END IF;
    RETURN '{' || array_to_string(parts, ', ') || '}';
  END IF;

  IF jsonb_typeof(input) = 'array' THEN
    parts := ARRAY[]::text[];
    FOR elem IN SELECT value FROM jsonb_array_elements(input) AS value LOOP
      parts := parts || lab_jsonb_canonical(elem);
    END LOOP;
    RETURN '[' || array_to_string(parts, ', ') || ']';
  END IF;

  IF jsonb_typeof(input) = 'number' THEN
    RETURN trim_scale(input::text::numeric)::text;
  END IF;

  RETURN input::text;
END;
$$;
