# Hyperliquid vault copier v2 — working state (2026-11-19)

**SHADOW / READ-ONLY ONLY — DO NOT DEPLOY OR ENABLE LIVE ORDERS.**

## Completed

- 57 local Node 22 tests passing; branch CI workflow at `.github/workflows/vault-v2-tests.yml` (status not independently verified in GitHub).
- Main v2 milestone commit `f5b40517b7364f6cd1e53db48626569dd68a21fc`.
- Fixed-point five-trader virtual ledger with leader fill deduplication, reversals, proportional closes and strict start-position checks.
- Read-only Hyperliquid source fill polling using `userFillsByTime`, time-range splitting on the 2,000-fill cap, restart journal, fail-closed data gaps and non-monotonic replay protection.
- Read-only WebSocket-triggered monitor with periodic REST backfill, one-writer concurrency, long-gap circuit breaker and shutdown hooks.
- Read-only vault equity/position/mark snapshots plus fail-closed SHADOW risk gate (account mismatch, stale state, gross leverage, market concentration, size, reduce-only).
- PostgreSQL ingestion schema drafted, but not applied; JSONL is only a local prototype.
- Old Render worker `copy-agent` is suspended; no new deployment, no signing key, no order submission, no transfers.

## Historical baseline

Original Render `copy-agent` successfully deployed revision `7960d37137fb64a5864733e6e82b1615f91b547c` at last rollback 2025-12-14. More recent patches failed build or were rolled back. Historical user-provided handoffs indicate repeated fee-generating follower syncs after legitimate opens. Do not revive the old runner or deploy inherited root `src/`.

## Next production gates

1. Verify existing vault public address, leader and current account state. Confirm all five source addresses; only three candidates are currently recorded in `config/traders.example.json` and **all are disabled**.
2. Build transactional Postgres event and order-intent persistence, unique IDs, fencing, crash restart, and reconciliation. Do not run the JSONL prototype on ephemeral Render storage.
3. Independently derive or attest source equity at the actual fill time; historical fills are not sufficient by themselves. Prevent accidental copying of pre-existing source positions.
4. Validate agent authorization and direct `vaultAddress` orders in testnet; then add explicitly gated exchange execution, partial-fill processing, retry/unknown-result detection, max risk, alerting and review.
5. Independently test live-vs-leader copy accuracy, fees, leverage-update handling, fund movements and regulatory obligations before accepting other depositors.

No live action should occur without separate explicit owner approval. Never put private keys or master-wallet secrets in code or tickets.
