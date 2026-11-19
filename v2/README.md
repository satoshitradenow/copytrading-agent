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