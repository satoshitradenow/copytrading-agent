# Vault Copier v2 — independent settlement gate

**Status:** Design and acceptance criteria only. SHADOW/READ-ONLY. No signed
orders, no automatic settlement, no agent permissions, no real funds.

## What is currently true

- The virtual portfolio is a **desired target**, not executed exchange exposure.
- `PgPortfolioBatchRepository` keeps a source fill STAGED and reconstructs the
  exact content-hashed batch after restart; no production `settle()` method.
- `auditStagedPortfolioSettlement` corroborates read-only order status,
  observed individual fills and pre/post vault positions, requiring a confirmed
  close before treating a reversal opening leg as corroborated.
- `PgSettlementAuditLog` records reviewable exchange observations/reports in
  PostgreSQL, recomputes reports on read and verifies a JSONB-safe SHA-256 hash
  chain. This is **not** authenticated exchange history or a tamperproof record.
- Emergency halt defaults to HALTED, missing control rows block submission
  preparation, and writer leases fence the *database* but cannot cancel
  an already in-flight HTTP request.

## Mandatory independent adjudication requirements

1. **Source fill identity and sizing.** Preserve five explicitly approved
   trader identities, exact economic fill fingerprints, opening position and
   a reliable source account equity observation policy at execution time.
   Hyperliquid historical fills lack exact equity snapshots. A current snapshot
   must never be described as actual historical at-fill equity.
2. **Vault and exchange provenance.** Confirm intended vault leader and
   network, delegated agent scope, actual order ID/client-order ID, per-fill
   exchange IDs, exact order side/reduce-only/size, and order terminal status.
   Distinguish an order status from complete fill history. No `unknownOid`
   implies non-execution or allows retry.
3. **Complete accounting.** Model actual partial sizes and fees, liquidity and
   slippage cost, funding, realized/unrealized PnL, canceled residual size,
   and manual/exchange-side position drift. No silently rounded quantities.
4. **Reversal safety.** The closing leg must be confirmed, including final
   position and all partials/cancellations, before any opening leg could ever
   be approved. Uncertain close freezes the batch.
5. **Independent approval.** A future decision must be traceable to a
   distinct authorized review role, not automatic optimism in a public
   non-atomic snapshot, and produce a durable review record.
6. **Atomic recovery and state.** Any future reviewed settlement transaction
   must require an unexpired same-vault writer fence, current HALT policy,
   exact expected portfolio/source journal version, complete exchange
   evidence and no unresolved order. Use SERIALIZABLE and compare-and-swap
   constraints. Crash/replay cannot double-credit source fills, double-sell
   contracts, or advance an unfilled strategy position.
7. **Safe deployment sequence.** Test adversarial cancellation, partial fill,
   duplicate/late fills, API retention gaps, network failure, unknown order
   response, stale permissions, and concurrent writers against isolated
   disposable PostgreSQL. Testnet only after explicit approval and verified
   agent authority; a tiny mainnet pilot is a separate explicit decision.

## Prohibited shortcuts

- No `CORROBORATED_BUT_NOT_SETTLED` -> `SETTLED` translation.
- No settlement or order execution based on price-only or equity-only moves.
- No blind resubmission after timeouts, unknown OIDs or partial fills.
- No use of the suspended legacy Render bot or root `src/` copier for v2.
- No API signer, live /exchange request, transfer, account funding,
  automated unhalt, or mainnet deployment in the current review-only phase.

## Current test evidence and the next coding boundary

The read-only audit, chronology safeguards, and independent pure
`fillAccounting.mjs` pass **269/269 Node 22 tests** plus both isolated
PostgreSQL integration scripts in
[GitHub Actions 44684159182](https://github.com/satoshitradenow/copytrading-agent/actions/runs/44684159182).
`fillAccounting.mjs` accounts for unaggregated per-order matched fills,
strict economic duplicate detection, fees, builder fee separation, partial
sizes, realized PnL and exact notional without floating-point rounding.

The **next coding boundary** is to connect trustworthy enough independent
exchange-fill provenance to a separate per-fill settlement adjudicator,
then design an operator-approved, fenced and transactionally atomic
portfolio promotion. No current audit report or fill-accounting summary
authorizes a transition. A future promotion API needs explicit operator
authorization, transaction proofs, recovery and adversarial tests.
This file is a gate, not approval.
