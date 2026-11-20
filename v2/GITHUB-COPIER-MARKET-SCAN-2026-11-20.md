# Hyperliquid vault-destination copytrader ecosystem check — 2026-11-20

**Decision: retain the original application `Gajesh2007/copytrading-agent` through our existing `satoshitradenow/copytrading-agent` fork.** It is *the* project that has already run for this user, and the code explicitly sets `ExchangeClient.defaultVaultAddress` when `FOLLOWER_VAULT_ADDRESS` is provided. Focus on a narrow event-driven, idempotent trigger fix, not replacing the app.

## Precise meaning of "supports a vault"

- **Target/source vault:** reading a trader or a *vault* as the copied account. This does **not** mean that the bot's submitted orders execute inside our own vault.
- **Destination/follower vault:** signing trade actions using the permitted agent and explicitly routing orders to the **follower vault**. This is the requirement that matters here.
- **Multi-pair vs one shared vault:** running five independent leader-follower pairs, each with its own private key, is **not** automatically safe for aggregating five leaders into one vault. It needs a common position/accounting ledger and serialized order writer.

## Public GitHub comparison

Sources are public GitHub repository metadata/READMEs and selected source files inspected on Nov 20, 2026. Stars/forks are snapshot figures, **not safety or code-quality proofs**.

| Candidate | Last commit / stars | Confirmed destination-vault route | Main assessment |
| --- | --- | --- | --- |
| [Gajesh2007/copytrading-agent](https://github.com/Gajesh2007/copytrading-agent) | Dec 25, 2025 / 52 stars | **YES**: `src/clients/hyperliquid.ts` includes `defaultVaultAddress`; root app already in our fork | **Keep as base.** SDK, WS, order executor, metadata and existing Render integration. Current sync-by-position behavior is the known fee-churn hazard; `src/index.ts` contains conflicting override patches, not an event-idempotency proof. |
| [jestersimpps/hyperliquid-copytrader](https://github.com/jestersimpps/hyperliquid-copytrader) | Jan 20, 2026 / 10 stars | **YES**: per-account `vaultAddress` forwarded into `openLong/openShort/closePosition` in `src/services/sync.service.ts` | Useful alternative for per-account UI/fee tracking and multi-account config. **Explicitly has drift-triggered size synchronization**, the exact kind of functionality that caused the user's fee churn. Cannot assume 5 independent accounts can safely share one vault. |
| [jstkyle/hyperliquid_bot](https://github.com/jstkyle/hyperliquid_bot) | Apr 23, 2026 / 0 stars | **Not verified**: Python `copybot/engine/execution.py` uses follower account and SDK's account_address; no explicit vault routing seen | Interesting fill-first copying, multiple leader/follower pairs, reversal close/open, paper mode and limited unit tests. Replacing our TypeScript working app with Python/Discord adds migration effort. Consider logic ideas, not replacement. |
| [MaxIsOntoSomething/Hyperliquid_Copy_Trader](https://github.com/MaxIsOntoSomething/Hyperliquid_Copy_Trader) | Jun 3, 2026 / 47 stars | **Not established**: `TARGET_WALLET_ADDRESS` supports a SOURCE vault, not proof of destination-vault execution | Useful 2026 Python project with simulated mode, notifications and sizing. No verified stronger fit for our **destination** vault; switching language and state introduces risk/time. |
| [keidev-sol/Hyperliquid-Copy-Trading-Bot](https://github.com/keidev-sol/Hyperliquid-Copy-Trading-Bot) | May 18, 2026 / 0 stars | **Not verified**: docs say a public SOURCE/vault can be tracked | Typed fill-driven TypeScript alternative with dry-run and risk knobs; newly published, no evidence it is more battle-tested, or has destination vault / five-source shared-vault accounting. |
| [Brobicho/HLCopy](https://github.com/Brobicho/HLCopy) | Public GitHub README | **Not verified**: `copy_vaults.txt` is a list of vaults **to copy from** | Tracks multiple **source** vaults; does not demonstrate route into the follower's Hyperliquid vault. |

## Verified issue in our original core

- `src/services/subscriptions.ts` calls `leaderState.handleFillEvent(event)` and then `onLeaderFill()` after WS fill notification. The callback **does not pass the fill IDs or economic details** to the executor.
- `src/index.ts` also has a periodic `pollLoop()` that invokes `syncWithLeader()` without a new leader fill. This unifies two different triggers, meaning the executor can't prove the order came from a new trade.
- The original `TradeExecutor.syncWithLeader()` recomputes the target from current positions, mark price and live equity, then executes `followerState.computeDeltas()`. This can trade for price/equity changes even without a new source transaction.
- The fork's last two patches redefine `TradeExecutor.prototype.syncWithLeader` twice: the second override's `originalSyncWithLeader` points to the **first no-op override**, not the class implementation. This is a **concrete danger to legitimate copying**, not a proven fix.
- The correct narrow repair is source-fill-triggered intent creation (with durable dedup and replay protection) through **the same original metadata/SDK/vault client**, with account polling read-only and no write trigger. Do not suppress legit opens/adds/reductions/closes. Do not simply re-enable the old sync loop.

## Revised implementation planning ranges — conditional, not promised

**Original single-leader bot working in shadow/testnet:** tentatively **2–5 focused working days**, if Render config, credentials, exact deployed commit and the account's trading permissions can be verified promptly.

**A cautiously scoped small mainnet pilot of the repaired single-leader bot:** tentatively **5–10 working days** *after* review of the above, adequate no-churn observation, testnet execution and separate authorization. No launch is scheduled or guaranteed.

**Five leaders -> ONE vault:** more complex than five independent copies. Tentatively **1–3 weeks** for safe functional integration and testnet validation, assuming the five identities and sizing/aggregation policy are available. The existing v2 shadow/durable work can reduce effort but is not yet connected to the original runtime. Full hardened operations/security review could extend these windows.

### Fast acceptance criteria

1. Verify Render's actual deployed SHA, repo branch, worker count and run configuration; do not touch production or ask for secrets here.
2. Compile and retain original TypeScript SDK/vault routing. Preserve already working order builder and metadata.
3. In shadow mode, trigger only on a uniquely identified leader economic fill; observe no orders from idle poll, equity changes or mark prices.
4. Prove correct copy open/add/partial reduction/close/flip, including missed WS events, duplicate events and restart, with synthetic tests and actual read-only exchange observations.
5. Test authorized **testnet** vault order routing, canceled/partial responses, crash recovery and emergency stop before any mainnet pilot.
6. Human review and explicit approval for a minimal, bounded mainnet pilot, followed by measured fee-churn/order-diff monitoring and rollback.

**Current development branch remains disconnected, shadow-only, and without live execution. Never turn on trading or deploy the old bot based solely on this report.**
