-- Vault v2: durable intent ledger schema, NOT APPLIED / NOT LIVE.
-- Review and test in a brand-new isolated database before deploying.
-- A DB ledger is necessary, but not sufficient, for safe order execution.
BEGIN;
CREATE TABLE IF NOT EXISTS v2_execution_intents (
  intent_id char(64) PRIMARY KEY CHECK (intent_id ~ '^[a-f0-9]{64}$'),
  vault_address varchar(42) NOT NULL,
  fill_key varchar(160) NOT NULL,
  client_order_id varchar(34) NOT NULL UNIQUE CHECK (client_order_id ~ '^0x[a-f0-9]{32}$'),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  last_event_hash char(64) NOT NULL DEFAULT repeat('0',64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT v2_execution_fill_once UNIQUE(vault_address, fill_key)
);
CREATE TABLE IF NOT EXISTS v2_execution_events (
  intent_id char(64) NOT NULL REFERENCES v2_execution_intents(intent_id),
  version bigint NOT NULL CHECK (version > 0),
  previous_hash char(64) NOT NULL,
  event_hash char(64) NOT NULL,
  event_type varchar(50) NOT NULL,
  event_data jsonb NOT NULL CHECK (jsonb_typeof(event_data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (intent_id, version)
);
CREATE INDEX IF NOT EXISTS v2_execution_intents_state_idx
  ON v2_execution_intents ((state->>'status'), updated_at);

-- This table is a development *design* for single-writer fencing. An execution
-- worker must stop on lease loss and must reconcile all in-flight / UNKNOWN
-- orders before a new writer sends any order. A DB lease by itself cannot stop
-- a delayed HTTP request that has already left an old worker.
CREATE TABLE IF NOT EXISTS v2_vault_writer_leases (
  vault_address varchar(42) PRIMARY KEY,
  fencing_token bigint NOT NULL DEFAULT 1 CHECK (fencing_token > 0),
  writer_id varchar(128) NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;