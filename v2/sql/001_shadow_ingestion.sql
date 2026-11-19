-- REVIEW REQUIRED BEFORE DEPLOYMENT. Not applied to any database.
-- Designed for a single vault, five traders, read-only capture and intent
-- recording. No private keys, no trading API, no credentials stored here.
-- The future worker MUST use transactions with a per-vault advisory or fencing
-- lease and only advance the cursor after each batch's rows commit.
BEGIN;

CREATE TABLE IF NOT EXISTS v2_source_baselines (
  trader_address varchar(42) PRIMARY KEY,
  start_time_ms bigint NOT NULL CHECK (start_time_ms > 0),
  network text NOT NULL CHECK (network IN ('mainnet', 'testnet')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS v2_source_fills (
  trader_address varchar(42) NOT NULL REFERENCES v2_source_baselines(trader_address),
  fill_tid numeric(39,0) NOT NULL CHECK (fill_tid >= 0),
  fill_time_ms bigint NOT NULL CHECK (fill_time_ms > 0),
  coin text NOT NULL,
  side char(1) NOT NULL CHECK (side IN ('B','A')),
  size_text text NOT NULL,
  price_text text NOT NULL,
  raw_fill jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trader_address, fill_tid)
);
CREATE INDEX IF NOT EXISTS v2_source_fills_time_idx
  ON v2_source_fills (trader_address, fill_time_ms, fill_tid);

CREATE TABLE IF NOT EXISTS v2_source_cursors (
  trader_address varchar(42) PRIMARY KEY REFERENCES v2_source_baselines(trader_address),
  through_time_ms bigint NOT NULL CHECK (through_time_ms > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Separate from captured source fills: every intended follower execution
-- requires a unique durable lifecycle. No worker may blindly retry UNKNOWN.
CREATE TABLE IF NOT EXISTS v2_order_intents (
  intent_id uuid PRIMARY KEY,
  vault_address varchar(42) NOT NULL,
  coin text NOT NULL,
  delta_size_text text NOT NULL,
  mode text NOT NULL DEFAULT 'SHADOW' CHECK (mode = 'SHADOW'),
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN
    ('PROPOSED','BLOCKED','AWAITING_REVIEW','CANCELED')),
  attribution jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;