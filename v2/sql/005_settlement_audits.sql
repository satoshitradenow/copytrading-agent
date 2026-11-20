-- Shadow-only, review-only exchange settlement audit log.
-- This is EVIDENCE STORAGE, NOT an authorization ledger, a settlement
-- transition, an operator approval, or proof of complete exchange history.
-- Apply only to a deliberately isolated v2 test DB for current CI.
BEGIN;
CREATE TABLE IF NOT EXISTS v2_settlement_audits (
  batch_id char(64) NOT NULL REFERENCES v2_portfolio_batches(batch_id),
  audit_seq bigint NOT NULL CHECK (audit_seq > 0),
  vault_address varchar(42) NOT NULL,
  evidence_digest char(64) NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  previous_chain_hash char(64) NOT NULL CHECK (previous_chain_hash ~ '^[a-f0-9]{64}$'),
  chain_hash char(64) NOT NULL CHECK (chain_hash ~ '^[a-f0-9]{64}$'),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  audit_report jsonb NOT NULL CHECK (jsonb_typeof(audit_report) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (batch_id, audit_seq),
  CONSTRAINT v2_settlement_audit_once UNIQUE (batch_id, evidence_digest)
);
CREATE INDEX IF NOT EXISTS v2_settlement_audits_vault_review_idx
  ON v2_settlement_audits (vault_address, created_at);
COMMIT;
