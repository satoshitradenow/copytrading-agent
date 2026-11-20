# Narrow correction on clean upstream SDK baseline

The root application starts from exactly upstream `5422835ea77a`, not
the fork's conflicting `TradeExecutor.prototype.syncWithLeader` patches.

This branch **only removes** the root `pollLoop()` path that periodically
called `TradeExecutor.syncWithLeader()` without a new leader fill.
It preserves the upstream Hyperliquid SDK, the original vault-routing
exchange client, the metadata/IOC executor, and the existing read-only
reconciler. `reconciler.start()` still periodically refreshes state but
never sends an order itself. The fill-triggered callback is left intact.

**Do not deploy or trade from this branch.** This initial correction is
necessary, but is **not sufficient** to prove one-to-one fill copying:
the remaining callback still converts each WebSocket event into a
position-target sync, with no persistent exchange TID deduplication,
and WebSocket history replay after restart remains unverified.
The original fills callback lacks raw fill identity at its call site;
that needs a durable v2 adapter rather than another monkey patch.

Regression tests guard against reintroducing an order-generating idle loop.
Next: route *individual verified leader fills* through durable v2 capture
and one staged intent, then through the existing Hyperliquid SDK only
after independently confirmed testnet safety and explicit authorization.

GitHub branch: `vault-upstream-integration-20261120`. Original `main`,
clean upstream baseline `vault-upstream-clean-20261120`, and old v2
shadow branch remain untouched.
