-- Fail-closed, one-way operator emergency HALT for each vault.
-- SHADOW-ONLY v2. No unaudited 'arm trading' API exists.
-- Every vault without an explicitly approved control row is HALTED by code.
-- Requires the prior v2_execution_intents schema; apply only to isolated test DB.
BEGIN;
CREATE TABLE IF NOT EXISTS v2_vault_execution_controls (
  vault_address varchar(42) PRIMARY KEY,
  halted boolean NOT NULL DEFAULT TRUE,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation>0),
  halt_reason varchar(256),
  halted_by varchar(64),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMIT;