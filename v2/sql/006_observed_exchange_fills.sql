-- Observed exchange fill identity registry. This is a REVIEW-ONLY index:
-- a claim proves neither on-chain execution nor authority to settle a batch.
-- Prevents the same (network,vault,tid) being silently attributed to multiple
-- source batches or accepted again with changed execution economics.
-- Requires 003_portfolio_batches.sql, 005_settlement_audits.sql.
-- Apply only to the isolated v2 CI database during development.
BEGIN;
CREATE TABLE IF NOT EXISTS v2_observed_exchange_fills (
  network text NOT NULL CHECK(network IN ('mainnet','testnet')),
  vault_address varchar(42) NOT NULL,
  trade_id varchar(20) NOT NULL CHECK (trade_id ~ '^(0|[1-9][0-9]*)$'),
  batch_id char(64) NOT NULL REFERENCES v2_portfolio_batches(batch_id),
  client_order_id varchar(34) NOT NULL CHECK (client_order_id ~ '^0x[0-9a-f]{32}$'),
  exchange_order_id varchar(20) NOT NULL CHECK (exchange_order_id ~ '^(0|[1-9][0-9]*)$'),
  economic_digest char(64) NOT NULL CHECK (economic_digest ~ '^[a-f0-9]{64}$'),
  economic_record jsonb NOT NULL CHECK(jsonb_typeof(economic_record)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (network,vault_address,trade_id)
);
CREATE INDEX IF NOT EXISTS v2_observed_exchange_fills_batch_idx
  ON v2_observed_exchange_fills (batch_id, trade_id);
COMMIT;
