# NEW MILESTONE — 2026-11-20: SHADOW PORTFOLIO PENDING-BATCH PERSISTENCE

- `v2/src/pgPortfolioBatchRepository.mjs` adds serialized lease-checked **read-only staging** of netted source events and up to two ordered unsigned leg intents. Source virtual positions are NOT automatically marked filled or committed.
- `v2/sql/003_portfolio_batches.sql` enforces one unresolved source batch per vault in PostgreSQL and one unique batch per source fill. Replay with incompatible economic evidence fails closed.
- `v2/test/pgPortfolioBatchRepository.test.mjs` exercises idempotency, stale writers, conflicting fills, pending-batch halt, fake identity, reversal phases and transaction rollback with a SQL mock. Separate `integration/portfolioPostgres.mjs` tests the actual Node/PostgreSQL path in an isolated disposable CI database.
- **Still deliberately missing:** an independent audited settlement transition that updates the virtual source ledger *only after* real exchange fill evidence and exact observed vault position agreement. No order signing, no exchange writes, no permanent Render worker, no live funds.
- Previous 5-trader portfolio preview now exposes an immutable source journal record fingerprint to make eventual database promotions deterministic.
- Verify GitHub Actions result for this commit separately; counts below are historical.

---

# CURRENT MILESTONE — 2026-11-20: FIVE-STRATEGY NETTING (SHADOW ONLY)

- Added pure `portfolioNetting.mjs` with source-event-only projection across five strategy allocations, explicit mainnet/testnet matching, source start-position and recent account/equity observation, vault drift checks on **all markets**, refusal when any prior order remains unresolved, and deterministic split close/open intents for vault net reversals.
- Added 17 focused portfolio tests (including 150-event replay and a five-trader portfolio) and 4 source economic-fingerprint tests. Tests are deliberately simulated; they **do not** prove live exchange execution.
- A source-fill ID with changed size, side, price, equity evidence, pre-fill position or timestamp now blocks rather than being counted as harmless duplicate. Older un-fingerprinted source ledger journals require manual review before replay.
- Current source equity observation now includes network. This observation is **not exact equity at trade time** and cannot by itself authorize actual copy orders.
- **Critical hold:** current virtual source state represents **desired** follower positions, never proof of actual filled exposure. The new preview refuses new source intent proposals if its expected prior net does not match a recent vault snapshot. This preview does not mutate the source journal or database.
- Pending integration: one atomic PostgreSQL transaction across captured source event, portfolio state and trade intents; exchange fill settlement evidence; per-leg independent preflight and confirmation; full source list verification, delegated vault-signing testnet proof and independent security review. No live trading, old Render still suspended.
- Prior release milestones below are historical, with earlier test counts. The GitHub CI result for this new commit should be verified independently.

---

# CURRENT HANDOFF — 2026-11-20 (supersedes older milestone counts)

**Status: SHADOW/READ-ONLY ONLY. Never run the inherited root `src/` trader or fund a bot using this branch without passing the remaining live-execution gates.**

- Latest developed implementation commit: `8595ff4e3b1c3dcfe6e2548a5e884d8a9d55f087`. Follow-on documentation commit can advance the branch head.
- **176 Node.js unit/property tests passed** on the new order planner and preceding modules. GitHub Actions test job verified; separate disposable PostgreSQL integration job runs alongside it. [CI run](https://github.com/satoshitradenow/copytrading-agent/actions/runs/44676666969).
- Isolated **Neon Free-plan PostgreSQL 18 test project** `vault-copy-v2-integration-test` (`vault_copy_v2_test`) exists independently of Core Fraction. Real DB uniqueness, transaction rollback and writer-lease semantics were tested. The separate GitHub Actions PostgreSQL 16 job tests actual Node `PgVaultWriterLease` and `PgIntentRepository` on each commit, not just SQL mocks. No live vault credentials or funds.
- Vault destination: public Hyperliquid mainnet page previously verified as a genuine vault, **E30 Vault 1**, with a public leader; the full vault address is intentionally **not** hardcoded or published in repo fixtures. Keep it in runtime settings.
- Trader source state: three candidate public addresses are in `v2/config/traders.example.json`, all **DISABLED**; two final source wallet addresses are still not independently recovered. Never assume candidates are final.
- `src/ledger.mjs`: one-to-five trader virtual allocation and event-only target changes. No price-driven/equity-driven periodic rebalance orders.
- `src/pgSourceCapture.mjs` plus `src/readOnlyMonitor.mjs`: duplicate-resistant source fill history with split pagination, DB checkpoints and gap guards; source WS is merely a trigger to REST fetch, not an execution authority.
- `src/pgIntentRepository.mjs` + `src/pgVaultWriterLease.mjs`: exact-fill intent uniqueness, event audit, lease fencing, risk receipt bound to exact order, stale writer and unresolved order blocking.
- `src/orderEvidence.mjs`: read-only exchange order-status and observed fill evidence; **never automatically resubmits UNKNOWN orders**.
- `src/orderPlanner.mjs`: **unsigned**, IOC-only, fixed-point lot/price formatting (including high-integer exception), slippage ceiling, min notional, no silent rounding, block unsplit position flips, fresh risk approval recheck, network matching, observed vault cross-leverage consistency, and per-side `activeAssetData.maxTradeSzs` capacity check. No signer, no `/exchange` request.
- `src/shadowPreflight.mjs`: end-to-end read-only vault identity -> fresh margin/market/metadata/leverage -> fresh risk -> unsigned IOC preview. Supported network must match ALL observations.
- Old Render `copy-agent` remains **suspended** for billing with auto deploy off; no v2 Render service or mainnet trading orders exist. GitHub `main` is unchanged.

## BLOCKERS BEFORE ANY LIVE DEPLOYMENT

1. Confirm all five source trader addresses and perform sustained read-only streaming/replay against current public fills. Need a credible, explicit source equity at-fill sizing policy; Hyperliquid fills do **not** contain historical equity snapshots.
2. Verify the complete public vault leader address, user-led vault authority and API-agent signing permissions. A valid public vault address and the presence of `vaultAddress` in SDK code **do not establish permission**.
3. Test signed trade routing with a newly funded, explicitly authorized **testnet** vault, separate from the owner's existing mainnet vault. No mainnet order or transfer without specific approval.
4. Integrate one fenced writer, durable source->intent->order->exchange fill recovery, precision, liquidations, fee/slippage accounting and kill switch. Uncertain HTTP responses may never initiate blind retries.
5. Validate cross-market netting and five-leader opposing exposures, position flips as *separate* approved close/open intents, partial executions and manual changes of leverage/account settings.
6. Run sustained shadow simulation plus adversarial loss/network tests and independent security review. Only then request approval for a **small** mainnet pilot; never auto-deploy the broken root runner.
7. Preserve the system's limitations: all source history queries have retention/page caps; quote/account snapshots are non-atomic; an API agent cannot ordinarily withdraw but can still generate leveraged trading losses.

---

# VERIFIED DATABASE INTEGRATION — 2026-11-20

- A **separate Neon Free-plan test project** was created: `vault-copy-v2-integration-test` / database `vault_copy_v2_test`; it is NOT the existing Core Fraction Neon project. Only the v2 prototype schema was applied there; test records were cleaned up. No trading activity.
- Actual PostgreSQL 18 checks via the Neon connector passed: exclusive writer row, fencing-token advancement, unresolved intent blocks takeover, unique fill-key rollback, atomic intent/event record.
- The separate **GitHub Actions PostgreSQL 16 service** ran the actual Node `integration/leasePostgres.mjs` and PASSED, alongside the 129-case `npm test` suite. [Verified CI run](https://github.com/satoshitradenow/copytrading-agent/actions/runs/44671413426).
- The test harness now uses the guarded `beginSubmission` path and intent-bound risk receipt. No keys, vault transfers, mainnet orders, or Render deployments have been initiated.
- **Critical remaining gates:** destination public vault address and actual leader authorization, all five verified source addresses, historical source-equity and copy ratio policy, independent price/lot precision tests, exchange-side order confirmation/unknown-state handling, and carefully bounded testnet signing. Real DB integration does NOT prove that live exchange execution is safe.
- GitHub `main` and the suspended Render `copy-agent` are unchanged.

---

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

## Writer fencing (2026-11-19 continuation)

- Implemented `src/pgVaultWriterLease.mjs`: fail-closed PostgreSQL ownership, DB-clock TTL, non-reentrant UUID writer, incrementing fencing token, renewal/check/release, and takeover blocked by unresolved in-flight order intents.
- Added 12 mocked SQL tests (107 local unit tests total). These are **not real PostgreSQL integration results**.
- Added explicitly opt-in `integration/leasePostgres.mjs` that refuses any database except `vault_copy_v2_test` with a separate confirmation variable. Not yet run against a real PG instance.
- Real exchange requests can outlive database lease expiry. No production writer implementation or signer exists; lease fencing alone does not provide exactly-once exchange execution.
- No Neon/Render/Vercel state changed and no test migrations executed.


## Exchange order evidence (2026-11-19 continuation)

- `src/orderEvidence.mjs` validates read-only `orderStatus` identity and status for a vault/cloid and tallies observed user fills conservatively. `unknownOid` is never a retry signal.
- No `/exchange` calls or execution states changed; the evidence API cannot prove complete history and cannot clear an unresolved intent by itself.
- 119 local mocked/regular tests pass; actual PG and live vault tests are still pending.


## Conservative source pagination (2026-11-19 continuation)

- Both JSONL and PostgreSQL shadow-source readers now default to a conservative 500-result split threshold, rather than treating fewer than 2,000 returned fills as necessarily complete. Oversized responses are recursively split instead of being silently accepted.
- Two new replay tests pass (121 local tests total). GitHub Actions result for this commit should be checked separately.
- Hyperliquid's general 500-element/block guidance means returned count alone is **not proof** that all fills are recoverable. True production completeness remains an explicit blocker; no live orders are enabled.


## Atomic lease-guarded submission boundary

- General PostgreSQL `transition()` can no longer start submissions without checking vault writer ownership.
- New `beginSubmission()` checks the active lease, fence, independent PostgreSQL clock freshness, and other in-flight intents under one serializable DB transaction before appending the `SUBMITTING` event.
- Risk approval receipts now bind to the **exact intent ID**, not merely the vault/coin, eliminating cross-order approval reuse. Vault snapshot identity is checked too.
- The code is still shadow-only. Tests use a SQL mock; no independent PostgreSQL service, agent signer or exchange execution has been activated.
