# Render deployment audit — confirmed November 20, 2026

The owner confirmed workspace `tea-d4jin675r7bs73fft0l0`
(**Satoshi's workspace**). Live Render metadata confirms:

- Existing `copy-agent` worker `srv-d4jj9kndiees738qi9k0`:
  Singapore, Starter background worker, 1 configured instance,
  auto-deploy OFF, root branch `main`, startup `npm start`.
- The service was suspended for **billing** on February 27, 2026.
  It is **not running**. No resume, redeploy, configuration change,
  secret access or trade was performed.
- Render identifies last successful deployed commit
  `7960d37137fb64a5864733e6e82b1615f91b547c` (Dec 5, 2025)
  after a December 14 rollback. Attempts to deploy
  `b53bd8c786d406264020010b87c8dad116039eac`
  (Dec 9 emergency patch) show **build_failed**, not a live release.
  Do not assume the GitHub main head matches the last running binary.
- Render lists **no PostgreSQL instances** in this workspace.
- Attempted to provision an independent, **free-plan**
  PostgreSQL 16 instance in Singapore named `vault-copy-shadow`.
  Render rejected the creation with HTTP **402 billing_suspended**.
  **No new database was created.** Further provisioning is blocked
  until the workspace owner resolves billing with Render.
- This branch remains GitHub CI-only; the read-only capture worker
  is prepared but not deployed. **Do not use the legacy Starter worker
  for experimental tests or unblock billing by auto-resuming live trades.**
  Before starting a worker after billing is restored, verify service
  pause/auto-deploy settings, dedicated v2 database and signer-free config.

**Owner action required:** resolve the billing suspension through Render's
billing settings. Then recheck status and provision a *separate* shadow
worker and database; do not resume the original funded-account copier as
the first action. Final source wallets and historical baseline still need
explicit verification.

---

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
