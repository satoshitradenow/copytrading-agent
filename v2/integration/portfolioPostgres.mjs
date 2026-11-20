/**
 * Disposable real-PostgreSQL integration for shadow-only portfolio batch state.
 * Strictly refuses every database name except vault_copy_v2_test and requires
 * the same deliberate opt-in confirmation as integration/leasePostgres.mjs.
 * NEVER targets user mainnet, keys, or an exchange /exchange endpoint.
 */
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {ShadowPortfolioNetting} from '../src/portfolioNetting.mjs';
import {MemoryJournal} from '../src/ledger.mjs';
import {PgPortfolioBatchRepository} from '../src/pgPortfolioBatchRepository.mjs';
import {PgSettlementAuditLog} from '../src/pgSettlementAuditLog.mjs';
import {PgVaultRecoveryInspector} from '../src/pgVaultRecoveryInspector.mjs';
import {PgVaultWriterLease} from '../src/pgVaultWriterLease.mjs';

function guardedConnection(){
  if(process.env.V2_INTEGRATION_CONFIRM!=='YES_ISOLATED_TEST_DATABASE')throw Error('Isolated test opt-in required');
  const raw=process.env.V2_INTEGRATION_DATABASE_URL;
  if(!raw)throw Error('Missing V2_INTEGRATION_DATABASE_URL');
  const url=new URL(raw);
  if(!['postgres:','postgresql:'].includes(url.protocol) || decodeURIComponent(url.pathname)!=='/vault_copy_v2_test')
    throw Error('Refuse PostgreSQL database that is not vault_copy_v2_test');
  return raw;
}
async function run(){
  const {Pool}=await import('pg');
  const pool=new Pool({connectionString:guardedConnection(),max:4,connectionTimeoutMillis:10000});
  const vault='0x'+randomUUID().replace(/-/g,'')+'01234567';
  const trader='0x'+'1'.repeat(40),owner={writerId:randomUUID(),fencingToken:'1'};
  const fill={trader,fillId:'HL:TEST1',coin:'BTC',side:'buy',size:'1',priceUsd:'50000',sourceStartPosition:'0',timeMs:10000};
  let firstBatch=null,secondBatch=null;
  try{
    const actual=await pool.query('SELECT current_database() AS name');
    if(actual.rows.length!==1||actual.rows[0].name!=='vault_copy_v2_test')throw Error('Unexpected PostgreSQL database');
    const ddl2=await readFile(new URL('../sql/002_execution_ledger.sql',import.meta.url),'utf8');
    const ddl3=await readFile(new URL('../sql/003_portfolio_batches.sql',import.meta.url),'utf8');
    await pool.query(ddl2);
    await pool.query(ddl3);
    const ddl4=await readFile(new URL('../sql/004_emergency_stop.sql',import.meta.url),'utf8');
    await pool.query(ddl4);
    const ddl5=await readFile(new URL('../sql/005_settlement_audits.sql',import.meta.url),'utf8');
    await pool.query(ddl5);
    const ddl6=await readFile(new URL('../sql/006_observed_exchange_fills.sql',import.meta.url),'utf8');
    await pool.query(ddl6);
    const leases=new PgVaultWriterLease(pool),repo=new PgPortfolioBatchRepository(pool);
    const lease=await leases.acquire({vaultAddress:vault,writerId:owner.writerId});
    owner.fencingToken=lease.fencingToken;
    const planner=new ShadowPortfolioNetting({vaultAddress:vault,traders:[{address:trader,allocationUsd:'1000',maxVirtualLeverage:5,enabled:true}],allowedCoins:['BTC'],journal:new MemoryJournal()});
    const plan=event=>planner.preview({fill:event,sourceObservation:{mode:'READ_ONLY',network:'mainnet',trader,
      accountValueUsd:'100000',observedAtStartMs:event.timeMs,observedAtEndMs:event.timeMs+10,
      positions:[{position:{coin:'BTC',szi:event.size}}]},
      vaultSnapshot:{mode:'READ_ONLY',network:'mainnet',vaultAddress:vault,asOfMs:event.timeMs+11,positions:{BTC:'0'}},
      unresolvedIntents:[],nowMs:event.timeMs+12});
    const one=plan(fill);
    firstBatch=(await repo.stage(one,owner)).batchId;
    assert.equal((await repo.stage(one,owner)).idempotent,true);
    assert.equal((await repo.pendingForVault(vault)).length,1);
    const persisted=await repo.readForAudit({batchId:firstBatch,vaultAddress:vault});
    assert.equal(persisted.persistedStatus,'STAGED');
    assert.deepEqual(persisted.intents.map(x=>x.intentId),one.intents.map(x=>x.intentId));
    const recovery=new PgVaultRecoveryInspector(pool);
    const frozen=await recovery.inspect({vaultAddress:vault});
    assert.equal(frozen.halted,true);
    assert.equal(frozen.pendingBatch.batchId,firstBatch);
    assert.ok(frozen.blockingReasons.includes('MISSING_EXECUTION_CONTROL_HALTED_BY_DEFAULT'));
    assert.ok(frozen.blockingReasons.includes('PENDING_SOURCE_BATCH'));
    assert.ok(frozen.blockingReasons.includes('MISSING_SETTLEMENT_EVIDENCE'));
    assert.equal(frozen.readyToResumeTrading,false);
    assert.equal(persisted.executeAuthorized,false);
    // Write an explicitly incomplete audit of the proposed leg into real
    // PostgreSQL. It remains review-only and MUST NOT settle the batch.
    const auditLog=new PgSettlementAuditLog(pool);
    const evidence={preview:{...one,batchId:firstBatch},
      initialVaultSnapshot:{mode:'READ_ONLY',network:'mainnet',vaultAddress:vault,
        positions:one.expectedNetBefore,asOfMs:fill.timeMs+13},
      legReports:one.intents.map(()=>null),nowMs:fill.timeMs+14};
    const firstAudit=await auditLog.record(evidence);
    assert.equal(firstAudit.report.classification,'REQUIRES_RECONCILIATION');
    assert.equal(firstAudit.report.commitAuthorized,false);
    assert.equal(firstAudit.executeAuthorized,false);
    assert.equal((await auditLog.record(evidence)).idempotent,true);
    // The same immutable evidence may have both a base status and an
    // independent detailed-economics review in one chained database journal.
    const reviewed=await auditLog.recordEconomics(evidence);
    assert.equal(reviewed.report.classification,'REQUIRES_RECONCILIATION');
    assert.equal(reviewed.report.commitAuthorized,false);
    assert.equal((await auditLog.recordEconomics(evidence)).idempotent,true);
    const chain=await auditLog.listForReview({batchId:firstBatch,vaultAddress:vault});
    assert.equal(chain.length,2);
    assert.equal(chain[1].evidence.auditVariant,'FILL_PATH_ECONOMIC_V1');
    assert.equal(chain[1].report.classification,'REQUIRES_RECONCILIATION');
    // Second economic audit with a complete, internally consistent synthetic
    // order/fill/position path. Still not sufficient to auto-settle the DB batch.
    const leg=one.intents[0],oid=123456;
    const full={...evidence,nowMs:fill.timeMs+600,
      legReports:[{statusResponse:{status:'order',order:{
        status:'filled',statusTimestamp:fill.timeMs+400,
        order:{oid,cloid:leg.clientOrderId,coin:leg.coin,
          side:leg.side==='buy'?'B':'A',origSz:leg.size,reduceOnly:false}}},
        observedFills:[{oid,tid:201,coin:leg.coin,
          side:leg.side==='buy'?'B':'A',sz:leg.size,
          px:'50000',fee:'0.15',feeToken:'USDC',closedPnl:'0',
          startPosition:leg.netBefore,time:fill.timeMs+300}],
        vaultSnapshot:{mode:'READ_ONLY',network:'mainnet',vaultAddress:vault,
          positions:{BTC:leg.netAfter},asOfMs:fill.timeMs+500}}]};
    const success=await auditLog.recordEconomics(full);
    assert.equal(success.report.classification,'ECONOMIC_PATH_CORROBORATED_BUT_NOT_SETTLED');
    assert.equal(success.report.commitAuthorized,false);
    assert.equal(success.report.economicLegAudits[0].path.economics.observedFeeUsd,'0.15');
    const later=await auditLog.listForReview({batchId:firstBatch,vaultAddress:vault});
    assert.equal(later.length,3);
    assert.equal(later[2].report.classification,'ECONOMIC_PATH_CORROBORATED_BUT_NOT_SETTLED');
    const foundClaim=await pool.query(`SELECT batch_id,trade_id,exchange_order_id,economic_record
      FROM v2_observed_exchange_fills WHERE network=$1 AND vault_address=$2 AND trade_id=$3`,
      ['mainnet',vault,'201']);
    assert.equal(foundClaim.rows.length,1);
    assert.equal(foundClaim.rows[0].batch_id,firstBatch);
    assert.equal(foundClaim.rows[0].economic_record.fee,'0.15');
    assert.equal((await auditLog.recordEconomics(full)).idempotent,true);
    const manipulated=structuredClone(full);
    manipulated.legReports[0].observedFills[0].fee='0.16';
    await assert.rejects(auditLog.recordEconomics(manipulated),
      /Observed exchange TID collision, changed economic fields/);
    assert.equal((await repo.readForAudit({batchId:firstBatch,vaultAddress:vault})).persistedStatus,'STAGED');
    const reviewedRecovery=await recovery.inspect({vaultAddress:vault});
    assert.equal(reviewedRecovery.pendingBatch.auditIntegrityVerified,false);
    assert.equal(reviewedRecovery.pendingBatch.lastAuditSequence,'3');
    assert.ok(reviewedRecovery.blockingReasons.includes('SETTLEMENT_EVIDENCE_REQUIRES_INDEPENDENT_CHAIN_VERIFICATION'));
    assert.equal(reviewedRecovery.readyToResumeTrading,false);
    assert.equal((await repo.pendingForVault(vault)).length,1);
    await assert.rejects(repo.stage({...one,proposedSourceJournalRecord:{...one.proposedSourceJournalRecord,fillDigest:'a'.repeat(64)}},owner),/Conflicting portfolio batch/);
    const two=plan({...fill,fillId:'HL:TEST2',timeMs:11000});
    await assert.rejects(repo.stage(two,owner),/Previous source event/);
    await assert.rejects(repo.stage(one,{writerId:randomUUID(),fencingToken:owner.fencingToken}),/lease/);
    // Explicitly test SQL partial UNIQUE index: no two active batches per vault,
    // even if someone writes outside the normal repository API.
    const forced='f'.repeat(64);
    await assert.rejects(pool.query(`INSERT INTO v2_portfolio_batches
       (batch_id,vault_address,network,source_fill_key,source_record,expected_net_before,desired_net_after,planned_legs,status)
       VALUES ($1,$2,'mainnet','forced:second','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'STAGED')`,[forced,vault]),/duplicate key|unique constraint/);
    // Mark test-only settled without any trade: the production repository
    // deliberately has NO method that settles an order based on an assertion.
    await pool.query('UPDATE v2_portfolio_batches SET status=$2 WHERE batch_id=$1',[firstBatch,'SETTLED']);
    assert.equal((await repo.pendingForVault(vault)).length,0);
    secondBatch=(await repo.stage(two,owner)).batchId;
    assert.notEqual(firstBatch,secondBatch);
    assert.equal((await repo.pendingForVault(vault)).length,1);
    // Even after synthetic test-only transition of the prior batch, an
    // already attributed exchange tid cannot fund a new source event.
    const secondLeg=two.intents[0],crossBatch={
      preview:{...two,batchId:secondBatch},
      initialVaultSnapshot:{mode:'READ_ONLY',network:'mainnet',vaultAddress:vault,
        positions:two.expectedNetBefore,asOfMs:11013},
      legReports:[{statusResponse:{status:'order',order:{status:'filled',statusTimestamp:11400,
        order:{oid,cloid:secondLeg.clientOrderId,coin:secondLeg.coin,
          side:secondLeg.side==='buy'?'B':'A',origSz:secondLeg.size,reduceOnly:false}}},
        observedFills:[{oid,tid:201,coin:secondLeg.coin,side:secondLeg.side==='buy'?'B':'A',
          sz:secondLeg.size,px:'50000',fee:'0.15',feeToken:'USDC',closedPnl:'0',
          startPosition:secondLeg.netBefore,time:11300}],
        vaultSnapshot:{mode:'READ_ONLY',network:'mainnet',vaultAddress:vault,
          positions:{BTC:secondLeg.netAfter},asOfMs:11500}}],nowMs:11600};
    await assert.rejects(auditLog.recordEconomics(crossBatch),
      /Observed exchange TID collision, changed economic fields/);
    assert.equal((await repo.pendingForVault(vault)).length,1);
    await leases.release({vaultAddress:vault,writerId:owner.writerId,fencingToken:owner.fencingToken});
    await assert.rejects(leases.acquire({vaultAddress:vault,writerId:randomUUID()}),
      /Pending source batch blocks writer takeover/);
    const stillOne=await pool.query('SELECT batch_id FROM v2_observed_exchange_fills WHERE vault_address=$1',[vault]);
    assert.equal(stillOne.rows.length,1);
    assert.equal(stillOne.rows[0].batch_id,firstBatch);
    process.stdout.write('PASS: real PostgreSQL portfolio staging, audited settlement evidence, lease fencing, idempotency and no premature journal advancement\n');
  }finally{
    try{
      // Only a randomly generated test vault; no arbitrary table truncation.
      await pool.query('DELETE FROM v2_observed_exchange_fills WHERE vault_address=$1',[vault]);
      await pool.query('DELETE FROM v2_settlement_audits WHERE vault_address=$1',[vault]);
      await pool.query('DELETE FROM v2_portfolio_batches WHERE vault_address=$1',[vault]);
      await pool.query('DELETE FROM v2_vault_writer_leases WHERE vault_address=$1',[vault]);
    }finally{await pool.end();}
  }
}
run().catch(e=>{process.stderr.write(`PORTFOLIO POSTGRES TEST FAILED: ${e.message}\n`);process.exitCode=1;});