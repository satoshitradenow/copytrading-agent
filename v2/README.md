# Hyperliquid vault copy v2 — shadow accounting foundation

**Status: not live, not deployable to real funds. This module has no signing key, trading API client, order placement, transfer action or restart mechanism for live trading.** It is intentionally separate from the legacy `src/` tree and old `copy-agent` service.

## Why this exists

Historical Render copy-agent duplicated fee-generating position adjustments without new source fills. The new core consumes explicitly identified source fill events, journals each once, scales new positions by source equity, closes already-open positions proportionally even when source equity changes, and nets the virtual allocations of up to five traders. Mark-price or equity changes by themselves cannot generate additional intents. A virtual fill is not a real order.

## Run tests

From `v2/`: `npm test` (Node.js 22+, no packages to install).

For a manual offline replay: `npm run shadow -- config/traders.json examples/fills.jsonl ./local-state/journal.jsonl`. Copy and edit the example config first, deliberately enable only approved sources, and provide *normalized, independently verified* fill events. The normalized event fields are `trader`, `fillId` (stable unique exchange fill identifier), `coin`, `side` (`buy`/`sell`), `size` (source coin amount), `priceUsd`, and `sourceEquityUsd` at event time. All amounts are plain decimal strings. Never store secrets in event files.

## Read-only live inspection

`npm run inspect -- 0xPUBLIC_VAULT_ADDRESS` queries only Hyperliquid `/info` for current public vault leader, equity and positions. It never signs or places trades. Tests use mocked network responses; real vault verification awaits the actual public vault address.


## Bounded read-only source capture (new)

Run from the v2 directory with Node.js 22 or higher:

`npm run capture -- config/traders.json 0xAPPROVED_SOURCE START_EPOCH_MS ./local-state/source.jsonl`

All source addresses in the supplied example are deliberately disabled; copy the example, confirm identities and set `enabled:true` only for sources you approved. `START_EPOCH_MS` is the precise millisecond start of capture, not a vault position entry command. The CLI reads the public Hyperliquid `userFillsByTime` `/info` endpoint only, ends ten seconds behind wall clock, and writes raw immutable fill evidence plus durable timestamps. It does NOT attach source equity to fills, size follower trades, or send orders. It refuses to use a journal initialized for a different trader or start time.

The polling implementation splits time windows recursively if an API page reaches the 2,000-fill cap, and refuses to advance checkpoints if pages are ambiguous, malformed, or fail. Restarts overlap recent time windows and deduplicate by Hyperliquid `tid`. `auditPositionContinuity()` flags sources whose first captured fill has a nonzero `startPosition`; such a stream must not be treated as a fresh leader position. **Capture alone does not prove full historical completeness**: the exchange limits old fill history (and some accounts exceed retention). Avoid assuming a historical backfill is complete without independent archival validation. The JSONL demo requires one process and reliable local disk; ephemeral Render disk is unsuitable for production persistence.

`sql/001_shadow_ingestion.sql` is a **design draft, not applied**. It provides source-fill uniqueness and read-only capture cursors in PostgreSQL; production still needs a fenced single-writer, cross-transaction order lifecycle, account-equity attestations, and review.

Source leverage changes and manual modifications to already-open leader positions are explicitly **not** modeled as new fill orders; their handling will need a separate tested policy.

## Safety constraints still blocking production

1. **Missing vault address and final source list:** The current conversation supplied three full source wallet addresses; two other desired trader addresses and the existing destination vault address were not confirmed. All example traders are disabled.
2. **No exchange execution adapter:** Verify leader-to-vault authorization, intended account and chain, actual vault balances and positions read-only. Testnet/shadow first. No mainnet trading without separate explicit approval.
3. **Live ingestion remains incomplete:** Read-only HTTP `userFillsByTime` capture now exists, with event de-duplication, timestamp-window splitting, a replayable JSONL journal, and source-position continuity audits. A continuously running WebSocket listener with REST backfill, independent equity snapshots and durable transactional PostgreSQL is still required. Never open inherited positions by accident.
4. **Not a production durability system:** JSONL is a single-process prototype. Replace with transactional Postgres with unique `(trader, fillId)`, intent lifecycle, serializable allocation updates, distributed lease/fencing, and reconciliation against exchange accepted/rejected/partially filled orders. Resolve indeterminate network responses before retries.
5. **Need full risk engine:** Per-trader virtual notional cap exists only as an early check. Still required: vault equity guard, gross exposure and concentration caps, correlation, market restrictions, min order size and price precision, slippage/spread limits, collateral and liquidation buffers, risk-off mode, separate reduction behavior, alarms and operator kill switch.
6. **Virtual positions aren't real segregated vault capital.** A legacy Hyperliquid vault has one net position per market. Opposing trader positions net, and a strategy's loss may affect every depositor. Separate strategy budgets are accounting, not isolated margin protection.
7. **Possible agent abuse:** Agent trading rights can destroy vault value without direct withdrawals, e.g. excessive leveraged or illiquid trades. Use narrow permissions where supported, fresh revocable keys, security reviews, immutable builds, and independent risk limits.
8. **No guarantee of identical source leverage or performance.** This engine scales each source *fill* using allocation/source equity, never rescales merely because PnL or leverage changes. How to handle explicit source leverage updates must be specified and tested separately.

## Public source address status

Three candidate addresses recovered from the conversation are in `config/traders.example.json`, deliberately disabled. Two remain unresolved; do not guess. Validate whether each candidate is actually a tradeable user account or vault and whether its event stream supports strategy replication.

## Deployment separation

Legacy Render `copy-agent` is currently suspended. It must remain so. Do not point the root package, existing Render service, Vercel dashboard or real Hyperliquid agent credentials at this new code. When mature, create an isolated new worker with `SHADOW_ONLY` default on.

## New pre-trade SHADOW risk gate

`src/riskGate.mjs` adds a pure, default-deny `assessShadowVaultRisk()` function and a strict adapter for Hyperliquid `clearinghouseState.assetPositions`. It checks actual vault position versus intended `netBefore`, rejects stale vault snapshots, unknown or unpriced existing assets, and enforces explicit order notional, market concentration and gross leverage caps. It recognizes a genuine same-direction **reduction** as such, while treating reversals as new exposure. It returns a proposed decision only: **there is still no exchange execution path**. All inputs must be sourced from fresh independent API observations in a future worker. Example policy: `config/risk.example.json`. An SDK or service that ignores this gate is not safe to deploy.

GitHub Actions configuration for this branch is at repository root `.github/workflows/vault-v2-tests.yml`; it runs the test suite only and does not deploy or access secrets.

`readVaultRiskInputs(vaultAddress)` combines read-only Hyperliquid `clearinghouseState` and `allMids` to supply the gate's normalized positions, mark prices, equity, and an observation timestamp. These are **not atomic** exchange snapshots; an eventual live engine must recheck actual account state immediately before any order. There is still no order submission, API wallet, or deployment.

## Opt-in development monitor (no trading)

`npm run watch -- config/traders.json START_EPOCH_MS ./local-state` uses a WebSocket `userFills` subscription only to **wake** REST historical capture, plus a 15-second independent polling fallback. REST history is always deduplicated, validated, and checkpointed before it advances. Existing sources remain disabled in the example config. For a **new** journal, the start timestamp must be within the last 9.5 minutes; an existing journal can reuse its original start timestamp if its latest checkpoint is sufficiently recent. Prolonged read gaps beyond 10 minutes halt the process rather than pretending the API retained all older fills. WebSocket snapshots are never treated as executable fills. The worker is read-only and has no order or wallet code. **This local JSONL version must not be deployed on Render's ephemeral disk**; a PostgreSQL-backed, fenced writer remains a production prerequisite.

## Transactional persistence milestone (2026-11-19, development only)

A separate PostgreSQL option is now implemented for **read-only capture** and
**shadow-order intent accounting**. It is not deployed and has not been tested
against a provisioned PostgreSQL server. The automated tests use deterministic
in-memory stand-ins for PostgreSQL transactions; a real PostgreSQL integration
suite and independently reviewed migrations are still required before production.

- `src/pgSourceCapture.mjs`: bounded Hyperliquid `/info` history, synchronized
  baseline and cursor, duplicate/conflicting fill detection, rollback on any
  incomplete response or database fault. Each group of captured fills and its
  progress cursor are written in one serializable transaction, protected by
  a per-trader baseline-row lock. Cross-process serializable conflicts cause a
  fail-closed stop; they are never silently retried.
- `src/intentLedger.mjs`: pure intent lifecycle with stable client order IDs,
  event hashes, deterministic replay, duplicate fill defense and no blind retry
  after an unknown result. Its `SUBMISSION_STARTED` event is only a data-state
  transition; there is no submitter or signing wallet behind it.
- `src/pgIntentRepository.mjs`: an independent serializable, row-locked durable
  intent proposal/transition repository with append-only event rows. This is
  **not** a usable execution pipeline until the per-vault writer-fencing,
  live exchange reconciliation, and operator-approval mechanisms are built.
- `sql/002_execution_ledger.sql`: migration **proposal only**, not applied.
  It includes a future per-vault writer lease design; code does not yet
  enforce those leases. Do not infer that a SQL lease alone prevents an old
  worker's delayed HTTP submission.
- `src/readOnlyMonitor.mjs`: explicit mainnet/testnet WS selection, aligned
  with the REST network to prevent accidental cross-network monitoring.
- `readSourceEquityObservation`: a contemporary public source account snapshot
  for research. It deliberately does **not** furnish exact source equity for
  a historical fill or authorize copy sizing.

### Isolated read-only PostgreSQL monitor entry point

Requires an entirely separate database with migrations `001_shadow_ingestion.sql`
(review first) and `002_execution_ledger.sql` (review first). Do **not** apply
these migrations to a CoreFraction or other unrelated application database.
Install Node.js 22+ and dependencies with `npm install` within `v2/`, then set
`DATABASE_URL` securely using your hosting provider's secrets manager. Never
check it into Git or send it in chat. The following command is an example, NOT
an instruction to start trading:

`npm run watch:pg -- ./config/traders.json START_EPOCH_MS`

You must explicitly enable only independently verified public sources in a
private copy of `traders.example.json`. The original example disables all
sources. The monitor only performs public `/info` requests and INSERT/UPDATE
operations into the isolated v2 capture database; it has **no signer or
exchange-order code**. It requires the same capture baseline on restarts.

### What remains to reach an actual live pilot

1. Confirm the existing vault address and leader-controlled authorization, and
   verify all five source addresses. Confirm vault market restrictions and
   maximum order/exchange tick precision via independent live metadata.
2. Build transactionally fenced *per-vault* allocation and order planning,
   including unresolved-order blocking and crash recovery. The v2 ledger is
   separate from live execution and no database end-to-end integration tests
   have been run yet.
3. Resolve reliable, audited sizing of trader fills when the source equity is
   not exactly available at fill time. Never equate a current source account
   snapshot with historical fill-time equity; exact leverage matching cannot
   currently be promised.
4. Authorize and test a dedicated agent for direct vault execution on testnet,
   and then a separately approved tiny mainnet pilot. Support known order IDs,
   retries/rejected/partial fills, liquidation prevention, funding, leverage
   updates, stale data, withdrawals, and operator kill switch.
5. Independently review financial security and regulatory obligations before
   any outside depositor money is solicited.

**No real trading, key installation, or production Render/Vercel deployment has
occurred in this version.** The suspended historical Render worker stays off.

### Exchange history retention safeguard

Hyperliquid `userFillsByTime` has a 2,000-row **response** cap and a separate
**10,000 most recent fills per source account** retention cap. Recursive time
range splitting handles the response cap, but it cannot recreate fills already
outside the 10,000-row retention window. The PostgreSQL capture now compares
one previously persisted fill inside each polling overlap against the API's
response. If that anchor disappears it refuses to advance the checkpoint.
This safeguards *observable overlap continuity*, not complete historical
provenance before the initial baseline. Very high-frequency source accounts
may require a verified independent archival data feed before live copying.

## Vault single-writer lease and isolated database verification

The new `src/pgVaultWriterLease.mjs` provides a **shadow-only** PostgreSQL lease with one UUID writer per process, database-clock expiry, a monotonically increasing fencing token, explicit renewal, and protection against takeovers if an unresolved `SUBMITTING`, `UNKNOWN`, `ACKED`, `PARTIAL`, or `REVIEW_REQUIRED` intent exists. It deliberately rejects simultaneous writers and stale owners. This is defense-in-depth, **not** sufficient by itself for live trading: it cannot revoke an HTTP request already transmitted by an old process; the actual execution adapter must implement external reconciliation and an emergency kill switch.

`npm test` includes the 12 mocked SQL lease tests (107 tests in total as of this commit). A *separate, manual* real-PostgreSQL integration script exists: `npm run test:postgres`. It refuses to run without `V2_INTEGRATION_CONFIRM=YES_ISOLATED_TEST_DATABASE` and a `V2_INTEGRATION_DATABASE_URL` whose database path and the server-reported database name are both exactly `vault_copy_v2_test`. The integration script creates test tables and deletes only its own randomly generated test records, so **never** point it at any production project or a shared database. It has **not** been run against a real PostgreSQL server, since no isolated test database credentials were supplied. No migrations have been applied anywhere.

**Still blocked:** no direct vault signer/agent approval, no execution transport, no real exchange order reconciliation, no full five-trader source verification, no live deployment, and no independently confirmed vault address. The suspended legacy Render worker must stay disabled.


## Read-only order-status evidence (no trading, no automatic retries)

The new `src/orderEvidence.mjs` and `readVaultOrderStatus` in `src/hyperliquidRead.mjs` query Hyperliquid's documented `POST /info` `orderStatus` method by the 16-byte client order ID using the **vault address**, never the signing-agent address. Every response is matched against the expected order's cloid, market, side, original size and reduce-only flag. It returns a conservative evidence classification; it does **not** submit, cancel, or automatically retry orders or transition any intent to a settled state. An `unknownOid` is specifically **not evidence of non-execution**. Even a `filled` or `canceled` status requires independent fill and position history auditing.

An additional pure helper deduplicates matching exchange fill IDs, rejects conflicting fills or overfills, and reports the observed size without asserting that the truncated/retained API history is complete. Existing failure history motivates this requirement: a lost HTTP response must never trigger the old blind re-order behavior. The 12 new mocked API/evidence tests bring the `npm test` suite to 119 passing local cases as of this milestone. No real vault lookup or actual exchange execution has been performed. [Official API reference](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#query-order-status-by-oid-or-cloid).


## Conservative Hyperliquid historical fill pagination

The reader now treats **500 results** as a conservative saturation threshold by default and recursively divides any bounded window returning 500 **or more** fills. Previously an unexpectedly oversized page failed or a sub-2,000 response could have been accepted as complete. This change acknowledges a tension in Hyperliquid's documentation: the dedicated `userFillsByTime` description states up to 2,000 fills, while the general Info pagination guidance mentions 500 elements or distinct blocks. The smaller threshold provides additional protection against truncation, but **does not prove completeness** when the exchange truncates by block count, changes response semantics, or has already aged out older fills. No live copier should assume full source history from this count test alone; archival/sequence verification may still be needed. Two regression tests cover oversized responses, bringing the local test suite to 121. [Official Info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint).


## Fenced submission preparation and order-bound risk receipt (2026-11-19)

The v2 shadow intent repository now **rejects `SUBMISSION_STARTED` through the generic `transition()` path**. The only permitted pre-submission state change is `beginSubmission(intentId,event,{vaultAddress,writerId,fencingToken})`, which uses ONE serializable PostgreSQL transaction to:

1. Lock the exact non-expired vault lease for the process UUID + fencing token.
2. Compare the risk-rechecked and submission-event timestamps to the **PostgreSQL server clock**, with a 1-second maximum check age.
3. Reject any other unresolved in-flight exchange intent for the same vault.
4. Lock the intended row, check it belongs to the vault, verify its risk approval is at most 10 seconds old, transition to `SUBMITTING`, and commit the event and state atomically.

A separate fix prevents cross-order approval replay: `assessShadowVaultRisk()` now returns an `intentId` derived from the exact validated order specification, and `RISK_APPROVED` requires that exact `intentId`. It also fails closed on a mismatch between the intent vault and the snapshot vault. Added 8 local regression tests; existing GitHub Actions workflow will test this against the full suite.

**This is only shadow-only ledger preparation.** It never sends an order; it does not create exchange-side fencing or make an already-in-flight HTTP request safe. The real PostgreSQL integration test and live testnet authorization are separate, still-pending gates.


## Public vault identity checks (no signer)

Use `npm run inspect -- HL:0xYOUR_PUBLIC_VAULT_ADDRESS`, or set `V2_VAULT_ADDRESS` privately in the runtime environment. Both a raw `0x...` address and Hyperliquid's user-facing `HL:0x...` label are accepted; the prefix is stripped before requesting public `/info` data. Do **not** commit personal vault addresses to example configuration files.

For stronger verification, optionally set `V2_EXPECTED_VAULT_LEADER` (full 42-character 0x public address) and `V2_EXPECTED_VAULT_NAME`. The inspector fails closed on an address, leader, or name mismatch. Its output always states `signingAuthorityVerified:false`: public vault data **cannot** prove the API agent may trade in that vault. Do not confuse a vault's UI-level capital summary with available cross-margin equity, and do not permit trading based on a read-only inspection.


## Shadow-only IOC order preflight (2026-11-20)

`src/orderPlanner.mjs` builds an **unsigned, non-executable** Hyperliquid perpetual IOC order preview. It reruns the latest vault-level risk assessment from a fresh account/position snapshot, compares the exact intent-bound approval, then requires current cross-leverage to match explicit expected settings. It rejects stale observations, manual leverage/margin-mode changes, delisted or unsupported isolated-only markets, source flips that have not been split into separately approved close/open intents, undersized minimum-notional orders, and quantities not **exactly** representable in `meta.universe[].szDecimals`. It does not silently round position size or change leverage. IOC limit prices use integer fixed-point math and obey the official 5-significant-figures/6-minus-szDecimals rules, including Hyperliquid's integer-price exception, while staying inside the configured slippage band. A too-small slippage band fails closed instead of making an unmarketable order. No HTTP calls, signing imports, exchange submission, nonce or credentials are present.

Read-only `readMainPerpMetadata` and `readVaultAssetLeverage` query the official `/info` `meta` and `activeAssetData` endpoints, respectively. They never authorize a signer or trading request. This component is *not* production exchange execution: it lacks quote/book depth verification, reliable actual fill-time leader equity, integrated post-order state recovery and a testnet-signed adapter. Official references: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size and https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals.


## Full public read-only preflight pipeline

The `previewCurrentVaultIntent` function in `src/shadowPreflight.mjs` now connects public vault identity verification (with optional exact leader/name pins), current vault risk-state observation, validator-perp metadata, and per-market `activeAssetData` leverage into the pure unsigned IOC planner. Every data source must identify the **same destination vault and the same network**; stale data, position drift, unsupported markets, leverage changes and prior approvals for other orders are rejected before a preview is returned. This is intentionally a developer API with **no exchange client, signing credentials, order submission or default live path**. Seven focused tests exercise the integration and failure paths. The reads are non-atomic and cannot prove a future exchange execution will be accepted, nor that an API agent is authorized for the user's actual vault.
