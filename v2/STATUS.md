# Vault copier v2 — current implementation status

Date: 2026-11-19. **SHADOW / READ-ONLY ONLY; NOT READY TO MANAGE REAL MONEY.**

## Latest work (this session)

- 95 local Node.js 22 tests pass, including 38 additional tests beyond the original 57.
- `src/intentLedger.mjs`: deterministic order intent ID + 16-byte client ID, reversible replay of append-only SHA-256 chained events, risk-approval, unknown-result blocking, fill confirmation, duplicate and overfill detection. Late ACK never reverses a PARTIAL/FILLED state.
- `src/pgIntentRepository.mjs` and `sql/002_execution_ledger.sql`: transactional intent state plus append-only audit event persistence, UNIQUE source-fill-to-vault mapping, serializable transactions, row locking and rollback tests. Future writer lease table is DESIGN ONLY.
- `src/pgSourceCapture.mjs`: transactional read-only source fill capture with verified page completeness, rollback-safe cursor commit, same-TID conflict fail-closed, baseline/network check, restart recovery and a persisted-fill overlap retention sentinel. Test coverage uses a mocked PostgreSQL pool; real Postgres integration pending.
- `src/watchPg.mjs`: an isolated read-only PostgreSQL monitor entry point for 1–5 explicitly enabled source addresses. Requires new DB + provider-secret `DATABASE_URL` and is intentionally not launched.
- `src/hyperliquidRead.mjs`: source-equity snapshot is marked non-historical; never used to fill missing historical equity.
- `src/readOnlyMonitor.mjs`: explicit mainnet/testnet WebSocket host to match REST history network.
- No Hyperliquid `/exchange` signer, master private key, API agent, wallet transfer or order submission is present in the new modules.

## Blockers before even a supervised pilot

- Vault's verified public destination address, leader authorization, exact exchange rules.
- Two missing/unverified trader addresses; example includes three candidate addresses all disabled.
- Actual PostgreSQL integration test and new isolated database, and post-deploy monitoring.
- Per-vault transactional writer fencing and recovered state before ANY order submission.
- Contemporaneous audited source equity/order-sizing methodology and risk policy approval.
- Actual exchange testnet agent authorization and confirmed direct-vault order routing.
- Slippage and fee instrumentation, position/account reconciliation, partial-fill handling,
  missed fills / liquidation / funding, and human kill-switch validation.
- Independent security review and any applicable compliance checks before third-party deposits.

## Existing infrastructure

Old Render `copy-agent` worker remains suspended. GitHub `main` is untouched.
Work is on `vault-v2-design-20261119` based on the actual historical deployed
commit. New v2 code is under `v2/` and will not run from the old root package.

## New retention verification

Hyperliquid's /info fill history retains only the most recent 10,000 fills
per source wallet; the 2,000-fill per-response pagination limit is separate.
PostgreSQL capture now halts if a previously saved fill inside its polling
overlap is missing from the public history query. This does not prove that
history preceding the initial verified baseline is complete; an archival
source remains necessary for very-high-frequency accounts or long outages.