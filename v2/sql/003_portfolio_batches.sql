-- SHADOW-ONLY durable proposed source event batches; no exchange signing,
-- transfers, order submission or automatic settlement logic.
-- Requires sql/002_execution_ledger.sql; apply only in isolated test database.
BEGIN;
CREATE TABLE IF NOT EXISTS v2_portfolio_batches (
  batch_id char(64) PRIMARY KEY CHECK(batch_id ~ '^[a-f0-9]{64}$'),
  vault_address varchar(42) NOT NULL,
  network text NOT NULL CHECK(network IN ('mainnet','testnet')),
  source_fill_key varchar(220) NOT NULL,
  source_record jsonb NOT NULL CHECK(jsonb_typeof(source_record)='object'),
  expected_net_before jsonb NOT NULL CHECK(jsonb_typeof(expected_net_before)='object'),
  desired_net_after jsonb NOT NULL CHECK(jsonb_typeof(desired_net_after)='object'),
  planned_legs jsonb NOT NULL CHECK(jsonb_typeof(planned_legs)='array'),
  status text NOT NULL DEFAULT 'STAGED' CHECK(status IN ('STAGED','REVIEW_REQUIRED','SETTLED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT v2_portfolio_source_once UNIQUE(vault_address,source_fill_key)
);
-- A proposed source event remains unresolved until an independent execution
-- evidence and actual vault-state audit are integrated; no self-unfreeze.
CREATE UNIQUE INDEX IF NOT EXISTS v2_one_pending_portfolio_batch_per_vault
  ON v2_portfolio_batches(vault_address)
  WHERE status IN ('STAGED','REVIEW_REQUIRED');
COMMIT;