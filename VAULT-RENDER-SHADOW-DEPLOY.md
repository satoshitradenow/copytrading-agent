# Vault — first deploy: signer-free, read-only Hyperliquid source monitor

**State:** INTEGRATION / NOT A MAINNET TRADING RELEASE.
**Runtime:** use the ORIGINAL copier repository on the separate
`vault-upstream-integration-20261120` branch, but start ONLY the isolated
`v2` PostgreSQL shadow monitor. Original `src/` SDK/order code remains
preserved, not authorized for execution.

## Prerequisites — operator approved, separate resources

1. **Render workspace selection:** verify the appropriate workspace with
   the owner before any Render service action. Never guess or alter an
   unrelated workspace or the old `copy-agent` service.
2. Create an **independent** Render background worker under the confirmed
   workspace; do not attach to an existing trading worker/URL or enable the
   legacy root npm start command. Budget/plan requires owner approval.
3. Create an independent PostgreSQL database such as
   `vault_copy_shadow`, separate from CoreFraction and the user's other
   databases. Review and apply only `v2/sql/001_shadow_ingestion.sql`
   to this database. This worker intentionally **does not run migrations**.
4. Verify and approve between **one and five source trader addresses**
   before monitoring. Do not assume a source vault is the trader wallet.
   Set the start baseline to a recent Unix timestamp in **milliseconds**
   just before enabling the worker. The capture process refuses an
   untrusted old initial baseline and will never silently skip gaps.
5. Do not provide any private wallet/API key to this worker. Remove inherited
   `FOLLOWER_PRIVATE_KEY`, `HL_SECRET_KEY`,
   `EXCHANGE_PRIVATE_KEY` and `API_PRIVATE_KEY` variables, or it refuses
   to start.

## Proposed Render worker configuration (NOT applied yet)

- Repo: `satoshitradenow/copytrading-agent`
- Branch: `vault-upstream-integration-20261120`
- Service type: **Background Worker**, separate from existing trading service
- Root directory: `v2`
- Runtime: Node 22+
- Build command: `npm install --ignore-scripts --no-audit --no-fund`
- Start command: `npm run watch:pg:env`
- Auto-deploy: **Off** during verification, even if GitHub changes occur
- Environment, via Render encrypted settings (no secrets in Git or chat):
  - `VAULT_SHADOW_MODE=SHADOW_ONLY`
  - `VAULT_NETWORK=mainnet` (READ ONLY information API; no signer)
  - `VAULT_SOURCE_ADDRESSES=0xSOURCE1,0xSOURCE2` (1–5 verified addresses)
  - `VAULT_BASELINE_MS=<recent 13-digit UTC Unix timestamp>`
  - `DATABASE_URL=<isolated PostgreSQL connection, stored securely>`

The worker checks exact connected database name, schema tables, fixed network,
source allowlist, recent baseline, lack of signer secrets, and a consistent
persisted cursor before connecting to public APIs. It reports
`read_only_capture` records and `read_only_shadow_active`. Any unbounded
history gap, saturated fill response, source ID conflict or database outage
halts progress instead of silently continuing.

## Why NOT to use root npm start yet

The legacy `src/index.ts` still contains the old target-position delta
copier. A periodic idle-triggered order loop was removed on the integration
branch, but a repeated WebSocket fill event can still call
`syncWithLeader()` without a durable order receipt. Starting its exchange
execution with a funded account would reintroduce avoidable order/fee risk.
Therefore root `src/index.ts` has a fail-closed development gate and
cannot start a trading process in this branch.

The original upstream exchange/metadata/vault-routing source is preserved for
a later, separately approved live order adapter after testnet checks.
The historical `main` branch and deployed Render service are untouched.

## Read-only acceptance criteria

- An operator confirms the correct Render workspace and service.
- Only one shadow worker is running, with no secrets/ExchangeClient.
- One or more verified source wallets produce accepted fill observations.
- Repeated WS messages or restarts do not duplicate stored trade IDs.
- Periods without new master fills produce no orders and no changes to
  the follower vault.
- Loss of PostgreSQL, network, historical retention or permission causes
  explicit error, without an order or cursor advance.
- Log/store accepted/duplicate counts, valid overlap and a resume baseline.
- Independent review of at-fill equity timing, order-identity linkage,
  vault risk and separately authorized testnet adapter is completed before
  any execution-capable pilot.

## Operational blockers as of 2026-11-20

The confirmed Render workspace has **not** yet been selected by the user
within this workflow, the actual deployed `copy-agent` commit/instance count
has **not** been audited, and no isolated database/worker has been created
or paid for. No source-wallet list beyond one previously supplied address
has been verified. A passing GitHub build is not proof of live readiness.
