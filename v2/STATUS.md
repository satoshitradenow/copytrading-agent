# VERIFIED PRECISE EXCHANGE FILL ECONOMICS — 2026-11-20

**Verified implementation:** `15f296b5d31ce50ec713d16ce657c41413ef651d`. **269/269 Node 22 tests passed**, and both disposable real PostgreSQL integration scripts passed in [GitHub Actions run 44684159182](https://github.com/satoshitradenow/copytrading-agent/actions/runs/44684159182).

- Added `src/fillAccounting.mjs` with purely read-only, fixed-point per-order/per-fill gross notional, confirmed observed size, observed USDC fee and closed-PnL summaries. TIDs deduplicate only when all recorded economic fields agree; malformed/unsafe IDs, mismatched markets, unsupported fee tokens, missing fees and observed overfills halt.
- Builder fees are tracked separately because inclusion in the primary fee is not independently verified. Data gaps, funding, liquidation costs and unrelated exchange orders remain independent risk gates.
- Added ten adversarial fill-accounting tests. **This summary does not settle a batch, authorize a retry, change a portfolio holding, call /exchange or enable trading.** The independent adjudication design is in `SETTLEMENT-GATE.md`.
- Current critical blockers: verified all-five source identities and exact at-fill equity sizing; actual vault agent authorization/testnet demonstration; complete authenticated-enough exchange fill provenance; independent transactionally atomic settlement with partials/fees; cancellation during emergency HALT; sustained paper trading and third-party review. No mainnet funding or activation.

---

# VERIFIED SETTLEMENT EVIDENCE JOURNAL — 2026-11-20

**Verified implementation:** `76fe57ab310a8948a353ee2f73edfec6e95c67b0`. **259/259 Node 22 tests passed**, and **both disposable real PostgreSQL integration scripts passed** in [GitHub Actions run 44683708422](https://github.com/satoshitradenow/copytrading-agent/actions/runs/44683708422). Later documentation-only commits require their own CI verification.

- Added review-only `PgSettlementAuditLog.record()` / `listForReview()` and `sql/005_settlement_audits.sql`. Each audit retains evidence and independently recomputed report, stable JSONB digest, and a per-batch SHA-256 hash chain. Duplicate observations do not append twice; evidence/report/hash tampering fails closed.
- Audit records append under a PostgreSQL batch lock and SERIALIZABLE transaction. Test coverage includes simulated rollback and a real PostgreSQL append/replay/readback. The existing staged batch stays **STAGED**, and subsequent batches remain blocked until a separate independent settlement process is designed and authorized.
- An order-status timestamp older than the *immediately preceding* vault-position observation now prevents order corroboration, including the second leg of a reversal. Two regression tests added.
- The evidence chain is **not** externally anchored, and untrusted public exchange snapshots cannot prove complete fill history. There is no settlement promotion, signer, order placement/cancellation, agent authorization, balance transfer, mainnet deployment or funding request. The v2 branch remains shadow-only. Legacy root trading code and Render deployment are unchanged.
- Next technical gates: authenticated and complete enough execution/fill evidence; an independent, auditable transactionally atomic settlement/partial-fill/fee ledger; exact-at-fill source equity sizing policy; all five approved source addresses; verified vault agent and testnet authority; emergency exchange cancellation; extended shadow runs and external review. **Do not enable mainnet.**

---

# VERIFIED EMERGENCY-STOP BUILD — 2026-11-20

**Commit:** `6ee37157f1c9224348b78b16c39c71d946daa30c`. **251/251 Node 22 tests passed** and **both disposable real PostgreSQL integration scripts passed** in [GitHub Actions run 44681368931](https://github.com/satoshitradenow/copytrading-agent/actions/runs/44681368931).

A database-level per-vault HALT is now enforced under the same serializable transaction as the writer lease and `SUBMISSION_STARTED` recording. The row defaults to halted, missing rows block, and `PgEmergencyStop.halt()` is intentionally one-way, independent of the writer. There is no generic arm API. HALT cannot recall already-sent exchange orders; a future live adapter must recheck immediately before sending and reconcile resting/in-flight exchange orders.

**Still strictly SHADOW-ONLY:** no signer, agent authorization, live order submission, account settlement promotion, mainnet funds, or new Render deployment. Main remaining gates: at-fill equity policy, all five verified traders, exchange/testnet vault authority, end-to-end settlement integration, emergency exchange cancellation and sustained shadow operation.

---

# NEW MILESTONE — 2026-11-20: DATABASE EMERGENCY HALT

- Added one-way `PgEmergencyStop.halt()` and per-vault `v2_vault_execution_controls` with default HALTED; missing control row cannot enable submission.
- `PgIntentRepository.beginSubmission()` now locks an explicit unhalted control row *inside the same serializable DB transaction* as the writer lease and intended order state.
- No unhalt/arming operator API exists; real trading remains impossible in v2, and an outstanding HTTP request cannot be revoked merely by writing a halt row.
- Added focused stop tests and real PostgreSQL CI checks (including missing control, test-only approval, subsequent halt). CI result must be verified for this commit.
- No legacy Render activation, secrets, private keys, wallet transfers or Hyperliquid exchange writes.

---

# VERIFIED SETTLEMENT AUDIT BUILD — 2026-11-20

**Build:** `c0f2e65c883b39bc9356585cb004dc31c3e12a6b` — **243/243 Node 22 tests passed**, plus both real PostgreSQL integration scripts, in [GitHub Actions run 44680833385](https://github.com/satoshitradenow/copytrading-agent/actions/runs/44680833385). This confirms the jsonb canonical-hash fix and persisted batch read-back against disposable PostgreSQL.

**Safety boundaries remain:** settlement evidence is read-only, human-review-only, and always has `executeAuthorized:false`, `commitAuthorized:false`, `safeToResubmit:false`. A matching account position and available fill history are not atomic proof of all exchange activity. No automatic DB settlement, portfolio journal promotion, exchange signer, Render v2 deployment, or live orders exist.

**Next engineering gates:** durable operator kill switch and exchange execution evidence logs; independent exchange-side confirmed settlement under one writer lease, correct partial-fill/fee accounting, full five-trader validation, source-equity evidence policy, testnet agent authorization and signed test orders (only with explicit approval), sustained paper/dry-run monitoring, then small monitored mainnet pilot after separate authorization.

---

# INTEGRATION FAILURE CAUGHT AND CORRECTED — 2026-11-20

- A disposable GitHub PostgreSQL test correctly failed on `readForAudit()`: DB `jsonb` reorders keys, and the initial batch hash was insertion-order-sensitive.
- The batch hash now uses recursively key-sorted canonical JSON; array order remains significant. Regression tests cover canonical JSONB readback and hash tampering.
- This is a **breaking content-hash format change** for any legacy STAGED batches from earlier shadow-only prototypes. Do not auto-accept/reconcile old IDs. No live production batches exist.
- The full PostgreSQL CI rerun for the corrective commit is the authoritative verification; not yet claimed here.

---

# LATEST WORK — 2026-11-20: READ-ONLY EXCHANGE SETTLEMENT AUDIT

- Added `src/settlementEvidence.mjs`: content-hashed staged portfolio batch versus read-only order status, individual exchange fills, and observed vault position snapshots. It refuses to classify partials/canceled/unknown order IDs as settled and blocks the second reversal leg if the close is unresolved.
- Added `PgPortfolioBatchRepository.readForAudit()` for read-only restart reconstruction, validating the stored batch hash against its original intent/position/source record. Does **not** promote any batch or change virtual strategy holdings.
- The audit is conservative **review only**, even when all observed evidence matches. It never authorizes execution, journal promotion or retry; true exchange completeness and account activity cannot be established from non-atomic snapshots alone.
- Added 21 local focused tests for settlement and persisted reader behavior; the disposable PostgreSQL CI integration now also checks read-back of the exact staged batch. See CI for authoritative all-suite result.
- Remaining major engineering work: independent auditable settlement procedure integrating live exchange fills with durable portfolio/source ledger; full five-source verification and actual at-fill equity policy; testnet vault-agent authorization/execution; sustained shadow monitoring; emergency stop and security review. Legacy Render remains suspended.

---

# VERIFIED BUILD HANDOFF — 2026-11-20

**Current implementation commit:** `ead9ec2505d1d09b269dc681509fcc81b98d5227` (economic anti-churn gate). The next documentation commit only records this verification.

**CI outcome:** **221 / 221** Node 22 application tests passed and both isolated PostgreSQL integration scripts passed in disposable GitHub Actions PostgreSQL. [Verified CI run](https://github.com/satoshitradenow/copytrading-agent/actions/runs/44679256108). This is not proof of production safety or profitability.

**Implemented, shadow-only:** source capture; immutable source economic fingerprints; five-strategy virtual ledger; opposing-trader netting; explicit close-first/open-after-confirmation for reversals; expected-vs-observed vault position drift halt; vault risk and IOC precision/slippage/capacity preflight; lease-fenced intent recording; staged source batch persistence without prematurely posting virtual executions; exchange order status evidence (read-only, no blind retries); optional fee/cost, market cooldown, hourly/daily anti-churn budget guard.

**Top remaining safety gates:** full source trader address list and auditable at-fill capital sizing policy; verified full vault-leader and testnet API agent permissions; actual exchange order signing/adaptor on testnet only; reliable exchange fill/partial/reject reconciliation; independently verified portfolio batch settlement (no current public settle method); durable attempt history and per-order costs integrated transactionally; sustained monitored shadow test; operator-controlled emergency shutdown and incident recovery; explicit separate owner approval for any tiny mainnet pilot. Old root trading engine must never be deployed as v2.

**Infrastructure:** GitHub development branch only. The original Render `copy-agent` remains suspended for billing and automatic deployment off as last verified. The user-provided destination is a genuine existing public Hyperliquid vault but is not stored in code; real funds and signing keys were not accessed. Isolated free Neon `vault-copy-v2-integration-test` is for database testing and is distinct from Core Fraction.

---

# ADDITIONAL MILESTONE — 2026-11-20: COST / CHURN PROTECTION

- Pure `economicThrottle.mjs`: blocks copy entries that exceed explicit daily estimated cost, hourly/daily attempt count or market cooldown policies. Canceled and rejected attempts still count; incomplete history and any UNKNOWN/PARTIAL/SUBMITTED prior order halt.
- Only legitimate reduce-only positions bypass economic quotas. The intent's net-before/after proves reduce-only; a forged IOC `r:true` cannot bypass. Full wire order asset/side/size/price/cloid identity checked.
- No profitability guarantee, no automatic selection of fee budgets, no signing keys, no trade execution and no live deployment. Requires a future database-backed full prior-attempt history integration.
- 14 focused test cases added. GitHub CI must independently verify total counts for this exact commit.

---

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
