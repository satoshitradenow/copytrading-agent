# Vault clean upstream baseline — 2026-11-20

This branch is based **directly** on upstream third-party project
[`Gajesh2007/copytrading-agent`](https://github.com/Gajesh2007/copytrading-agent)
commit `5422835ea77acdd8ef2867814b38f6c921ec2c40`, including its Dec 25,
2025 frontend Next.js security update.

The upstream root `src/`, `frontend/`, `package.json` and `Dockerfile`
were intentionally **not modified** when the branch was created.
Only the independently developed `v2/` SHADOW-ONLY audit/test support and
a GitHub CI workflow were added.

The user's original fork is preserved at `main`; its last two emergency
prototype overrides in `src/index.ts` are **not included** in this branch.
Those patches were not a trustworthy fix for unintended fee-generating sync
orders, but the original upstream itself still triggers position-target
resynchronization from idle account polling. **Do not deploy or execute this
branch** until event-only trigger/idempotency corrections are independently
tested; merely fetching the fresh upstream does not fix that problem.

## Next narrow improvements

1. Preserve original SDK, WebSocket client, vault routing, metadata service,
   exchange order builder and application boot/shutdown.
2. Add separately tested source-fill attribution/deduplication and replace the
   idle-timer's order-generating callback with read-only observation.
3. Keep the original trade executor's write endpoint disabled until complete
   order-intent durability, reconciliation and testnet checks are integrated.
4. Keep one verified writer for one vault; integrate the requested five source
   streams only after single-source regression checks.
5. Explicitly verify current Render service identity, deployment SHA, process
   count and rollback; no automatic deploy, no private key reads or mainnet
   trades during this work.

## Verification

The test workflow builds the untouched original TypeScript core without
starting it, runs `v2/` Node unit tests and runs two PostgreSQL integration
scripts in an isolated CI database. These passing checks do **not** constitute
a green light for live trading. The original upstream copyright/license
conditions continue to apply to reused source.
