# Vault — original third-party copier is the application core

**Decision (2026-11-20): Preserve and extend the existing upstream core; do NOT replace it with an unrelated full rewrite.** This supersedes descriptions of v2 as a complete replacement. The v2 modules are currently sidecar/shadow-only development code and have **not** been integrated into the original runtime.

## Proven repository lineage

- Original third-party project: [Gajesh2007/copytrading-agent](https://github.com/Gajesh2007/copytrading-agent).
- Our live-project fork: [satoshitradenow/copytrading-agent](https://github.com/satoshitradenow/copytrading-agent).
- GitHub's actual fork metadata records the original as the fork parent.
- Our fork's `main` was `b53bd8c786d406264020010b87c8dad116039eac` at audit. The segregated v2 branch starts from this existing application and adds `v2/` safety work. Original root application files were not replaced by the v2 branch.
- Upstream newest commit at this audit: `5422835ea77a`, December 25, 2025. It merged React Server Components security dependency fixes. **No more recent core-trading-engine update was verified.**
- The upstream and our fork contain byte-identical versions of:
  - `src/services/tradeExecutor.ts`: Hyperliquid IOC order construction and dispatch;
  - `src/services/subscriptions.ts`: leader-fill WebSocket events;
  - `src/clients/hyperliquid.ts`: original SDK client transports and vault routing;
  - `src/services/marketMetadata.ts`: metadata, asset identifiers and precision.
- `src/index.ts` differs because our fork contains emergency overrides to `TradeExecutor.prototype.syncWithLeader`; these are not proof that the fee-churn issue was correctly repaired. Do not assume this patch distinguishes new leader fills from idle polls.

## Preserve as the core — reuse rather than recreate

| Existing upstream asset | Role in the eventual architecture | Integration requirement |
| --- | --- | --- |
| `src/clients/hyperliquid.ts` | Hyperliquid SDK information, WebSocket, and **future separately approved** execution transport | Preserve upstream account/vault routing and SDK semantics; isolate any signing client behind a separately authorized execution boundary |
| `src/services/subscriptions.ts` | Low-latency leader fill notifications | Make fill notifications wake durable capture and dedup; never treat an unverified WS event as an order authorization |
| `src/services/marketMetadata.ts` | Correct exchange asset and precision metadata | Reuse with exact-decimal v2 risk/price checks; keep metadata refresh non-trading |
| `src/domain/traderState.ts` | Position snapshots and incremental fill handling | Retain known-good behavior but verify position math and reconcile against read-only exchange state; avoid currency/size rounding drift |
| `src/services/tradeExecutor.ts` | Existing order builder/SDK execution path | Retain original structure; patch only the dispatch trigger so price changes, idle polls and account equity changes do not generate fresh copy orders. No live call until separate approval |
| `src/services/reconciler.ts` | Read-only source/follower state refresh | Keep observational repair, remove any automatic order creation from periodic state-only reconciliation |
| `src/index.ts` | Original app lifecycle and shutdown | Eliminate contradictory prototype monkey patches after review; preserve existing application and safe shutdown |
| Original frontend | UI and vault dashboard | Reuse; selectively incorporate verified upstream December 2025 dependency security updates after normal review |

## v2 modules as supporting safety layers, not a new wholesale bot

The separate `v2/` code currently includes shadow ingestion/deduplication, exact-decimal netting, bounded risk checks, staged source batches, immutable economic audit, cross-batch exchange TID registry, emergency HALT, writer fencing and recovery diagnostics. These are useful **candidate modules** to connect to the existing TypeScript engine, not permission to bypass the upstream SDK or rewrite already-working features.

A practical integration sequence:

1. Verify **exact deployed Render commit/branch**, instance count and mode before touching production. Do not assume upstream main equals running bytes or that the original process is suspended. Do not expose credentials.
2. Establish a root-application build baseline from the existing fork, including the upstream client/market metadata and WebSocket code.
3. Inspect `syncWithLeader()`, leader fill subscription callback, concurrent polling, patch overrides and real order-response handling. Confirm which path caused fee-generating repeated trades, using log evidence. Keep position refresh separate from order dispatch.
4. Bridge original fill subscription → durable read-only v2 capture → strict source event dedup → *review-only* proposed IOC order intent. Reuse original SDK metadata/order-building semantics. Do not auto-place an order in this step.
5. Integrate the five approved leader streams (when identities are verified), one vault writer fence, event-sourced allocation ledger, and crash-safe per-leg outcome audit, preserving the original engine.
6. Add independently approved settlement and authorized execution only after full exchange accounting, reversal/partial-fill recovery, testnet permission testing, emergency cancellation and independent review. Live mainnet activation requires a separate explicit decision.

## Current blockers / hard rules

- Earlier conversation handoffs explicitly name this fork and original author, but **do not contain a verbatim copy of the complete VAULT chat**; do not claim a full word-for-word historical audit.
- The source event requirement is **one copy attempt per genuine master economic fill**, not automatic follower rebalancing every poll.
- The upstream core currently targets a single leader/follower and computes position deltas. The requested five-leader shared-vault behavior needs an integration layer, but it does not require discarding the existing SDK client or frontend.
- The previously modified `src/index.ts` overrides are contradictory and need an evidence-backed, tested minimal patch rather than more monkey-patching.
- v2 passing shadow tests is **not** evidence the upstream SDK runtime has been integrated or that real trading is safe.
- Keep the original application `main` unchanged until integration design, baseline build, and an independently approved rollout. **No live order, signer, transfer, account funds, automatic unhalt, or Render deploy** in this audit phase.
