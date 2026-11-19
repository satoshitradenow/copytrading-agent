# Vault Copy Engine v2 — Design and Acceptance Gates

Status: DESIGN ONLY — trading is not enabled. This branch was based on deployed Render commit `7960d37137fb64a5864733e6e82b1615f91b547c` for historical reference. Do **not** deploy its inherited trading engine. The legacy repo is not production-safe for this strategy.

## Goal

Copy selected Hyperliquid individual traders directly into an **existing user-led Hyperliquid vault**, with one consolidated vault position book and up to five independent virtual strategy allocations. Do not route through SuperX or through a personal trading account. Preserve the existing vault and the original repo/main branch.

## Proven prior system facts (historical)

- Render background worker `copy-agent`, currently suspended for billing, one configured instance; automatic deploy off.
- Successful Render rollback on 2025-12-14 to commit `7960d37137fb64a5864733e6e82b1615f91b547c`.
- Later 2025-12-09 patch `b53bd8c...` repeatedly failed to build.
- Historical handoffs reported first trades copied, followed by repeated sync orders without leader activity (sometimes every 5–30 seconds).
- Legacy `syncWithLeader` used leader exposure and follower/vault account equity and mark prices to compute target deltas; this can trigger position resizing without new leader fills.
- Legacy code already has `FOLLOWER_VAULT_ADDRESS` and an exchange client `defaultVaultAddress`. Treat as **reference**, not reliable production implementation.
- The original root cause of every fee-generating historical order has not been proven from the available runtime logs.

## Design decision: new engine, selective reuse

1. **Keep** API transport patterns, read-only Hyperliquid query helpers, metadata logic, and frontend code only after tests and review.
2. **Replace** the TradeExecutor, dynamic equity-based position-target syncing, leader state reconciliation, event processing, order execution, and risk logic.
3. Run as an isolated persistent worker with a durable transactional database; the dashboard may remain separate.
4. Create fresh, revocable signing credentials only after read-only verification and paper-mode acceptance. Never copy historical secrets.
5. Use the master/leader address strictly for API-agent authorization; send actions with the existing vault's `vaultAddress`; always query vault equity and positions using the vault address. No assumption that API agent signer owns the trading equity.
6. Validate that the API agent is authorized for vault-directed trades before any live order. Do not infer permissions from keys alone.
7. Never resume or deploy existing Render `copy-agent` until explicitly approved; preferably use an independent worker service for v2.

## Worker topology

Source-trader fills and reconciliation snapshots (read-only)
→ deduplicated durable source event log (trader id, fill id, asset, side, size, price, timestamp, processing state)
→ per-trader virtual allocation and position ledger
→ aggregate net desired vault exposure per instrument
→ risk engine and independent vault-state verification
→ serialized, idempotent order intent / execution ledger
→ authorized Hyperliquid vault-address order submission (LIVE DISABLED UNTIL APPROVAL)
→ independent confirmation, partial-fill handling, audit metrics.

### Non-negotiable invariants

- Every unique source fill is applied to its virtual strategy ledger at most once. WS reconnect, polling, and restarts may replay events but cannot repeat a completed intent.
- With **no source fill and no explicitly authorized repair action**, follower-trading order count remains **zero**, regardless of mark-price or equity movement.
- Read-only balance reconciliation never directly places orders. Flag drift and require a clearly designed recovery policy.
- Failed/unknown order outcomes are resolved against exchange order/fill history before retry. No blind retries.
- Use exactly one serialized writer for each vault; database coordination must prevent duplicate workers from placing duplicate orders.
- No automatic opening of old positions on source subscription. Initial state is observed and explicitly accepted.
- Enforce notional caps, allowed markets (legacy vault restrictions), max leverage, slippage, margin usage, permitted allocation, kill switch, circuit breakers, and reduce-only logic where applicable.
- A traditional vault is one net position per market, not five isolated margin subaccounts. Opposing signals net. Maintain a separate virtual ledger for attribution, with explicit handling of incompatible allocations and potential losses larger than a virtual budget.
- Deposits and withdrawals update allocation budgets deliberately; they do not automatically create corrective orders when no leader trade occurred.
- Never promise `exactly once` external execution without a robust intent ledger, exchange order confirmation, and failure policy.

## Staged acceptance tests (all must pass before real-money use)

- Read-only: verify vault leader, vault address, current vault equity, balances, positions, and state snapshots against Hyperliquid UI.
- Reproduce old failure in tests: static leader exposure + changing price/equity + repeated polling must place **zero** follower orders.
- Events: open, same-coin add, partial reduction, close, flip, duplicate fill, out-of-order fill, stale WS event, restart, reconnect, high-volume burst.
- Execution: partial fill, rejected order, order accepted but response lost, dropped WS connection, rate limiting, balance mismatch, precision rounding, min-notional/dust, stale price, reduce-only.
- Five traders: different budget weights, same-market aligned positions, opposing positions, correlated risk, overlapping closes and reversals.
- Vault flows: deposits, withdrawals, leader min-equity requirement, vault restrictions, material equity change, insufficient margin.
- Observability: source vs intended vs confirmed fill counts, actual slippage/fees, position divergence, daily P&L and drawdown reporting.
- Simulated real fill streams and production shadow mode without API trading privileges; audit output before any authorized small-size live pilot.
- A live pilot is **not** implied by this document. Obtain explicit approval separately.

## Immediate implementation order

1. Build a clean `v2/` source tree and test suite, with all write paths default-disabled.
2. Implement the event journal, virtual positions and netting as pure deterministic code; write invariant tests.
3. Integrate read-only public trader streams, polling/replay, and vault-state queries.
4. Add persistence, idempotent order intents, failure recovery and alerts.
5. Add a Hyperliquid adapter behind a disabled execution gate and run on testnet/shadow mode.
6. Perform independent code review and documented acceptance tests before any production API agent setup or vault funding.

## Scope exclusions

No revival of the legacy runner, no change to active vault positions, no transfers, no exposure of API keys or environment-variable values, and no claim that a strategy's historical returns can be faithfully copied without measured execution data.
