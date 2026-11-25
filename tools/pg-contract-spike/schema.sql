CREATE TABLE characters (
  id text PRIMARY KEY,
  version bigint NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991),
  currency integer NOT NULL DEFAULT 0 CHECK (currency >= 0)
);

CREATE TABLE items (
  character_id text NOT NULL REFERENCES characters (id),
  location smallint NOT NULL CHECK (location BETWEEN 0 AND 26),
  definition_id text NOT NULL,
  instance_id text UNIQUE,
  quantity smallint NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  metadata json NOT NULL CHECK (json_typeof(metadata) = 'object'),
  PRIMARY KEY (character_id, location),
  CHECK (instance_id IS NOT NULL OR location < 24),
  CHECK (instance_id IS NULL OR quantity = 1)
);

CREATE TABLE command_receipts (
  character_id text NOT NULL REFERENCES characters (id),
  request_key text NOT NULL,
  fingerprint text NOT NULL,
  code text NOT NULL,
  changed boolean NOT NULL,
  version bigint NOT NULL CHECK (version BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (character_id, request_key)
);
