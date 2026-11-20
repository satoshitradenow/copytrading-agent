/**
 * Explicit, opt-in PostgreSQL integration verification against an ISOLATED DB.
 * This script does not run under npm test or GitHub CI. It creates tables
 * only when V2_INTEGRATION_CONFIRM=YES_ISOLATED_TEST_DATABASE and the actual
 * server-reported database name is exactly vault_copy_v2_test.
 *
 * Never point this at a live vault database, a production Neon project, or
 * Core Fraction's existing projects. No external order API exists here.
 */
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {PgVaultWriterLease} from '../src/pgVaultWriterLease.mjs';
import {PgIntentRepository} from '../src/pgIntentRepository.mjs';
import {PgEmergencyStop} from '../src/pgEmergencyStop.mjs';

const APPROVAL='YES_ISOLATED_TEST_DATABASE';
function checkEnv(){
  if(process.env.V2_INTEGRATION_CONFIRM!==APPROVAL)throw Error('Explicit isolated DB integration approval env var not set');
  const raw=process.env.V2_INTEGRATION_DATABASE_URL;
  if(!raw)throw Error('V2_INTEGRATION_DATABASE_URL not set');
  const parsed=new URL(raw);
  if(!['postgres:','postgresql:'].includes(parsed.protocol))throw Error('Only PostgreSQL URLs accepted');
  if(decodeURIComponent(parsed.pathname)!=='/vault_copy_v2_test')throw Error('Target must be database vault_copy_v2_test');
  return raw;
}
async function run(){
  const url=checkEnv();
  const {Pool}=await import('pg');
  const pool=new Pool({connectionString:url,max:4,connectionTimeoutMillis:10000});
  const vault=`0x${randomBytes(20).toString('hex')}`;
  const a=randomUUID(),b=randomUUID();
  let intentId=null;
  try{
    const name=await pool.query('SELECT current_database() AS name');
    if(name.rows.length!==1||name.rows[0].name!=='vault_copy_v2_test')throw Error('Server database does not match explicit test DB');
    const sql=await readFile(new URL('../sql/002_execution_ledger.sql',import.meta.url),'utf8');
    await pool.query(sql); // DDL permitted only in independently named isolated test database.
    const emergencySchema=await readFile(new URL('../sql/004_emergency_stop.sql',import.meta.url),'utf8');
    await pool.query(emergencySchema);
    const lease=new PgVaultWriterLease(pool),intents=new PgIntentRepository(pool);
    const claim=await lease.acquire({vaultAddress:vault,writerId:a,ttlMs:15000});
    assert.equal(claim.fencingToken,'1');
    const attempted=await Promise.allSettled([
      lease.acquire({vaultAddress:vault,writerId:b,ttlMs:15000}),
      lease.acquire({vaultAddress:vault,writerId:randomUUID(),ttlMs:15000})
    ]);
    assert(attempted.every(x=>x.status==='rejected'),'Active ownership must be exclusive');
    assert.equal((await lease.assertActive({vaultAddress:vault,writerId:a,fencingToken:'1'})).fencingToken,'1');
    assert.equal((await lease.renew({vaultAddress:vault,writerId:a,fencingToken:'1',ttlMs:15000})).fencingToken,'1');
    await lease.release({vaultAddress:vault,writerId:a,fencingToken:'1'});
    const claim2=await lease.acquire({vaultAddress:vault,writerId:b});
    assert.equal(claim2.fencingToken,'2');
    await assert.rejects(lease.renew({vaultAddress:vault,writerId:a,fencingToken:'1'}),/expired or lost/);

    const input={mode:'SHADOW_ONLY',vaultAddress:vault,fillKey:`source:${randomBytes(8).toString('hex')}`,
      coin:'BTC',side:'buy',size:'0.01',netBefore:'0',netAfter:'0.01'};
    const item=await intents.propose(input);intentId=item.intentId;
    // The same source fill must never create a different order.
    await assert.rejects(intents.propose({...input,size:'0.02',netAfter:'0.02'}),
      /different order|maps to different order/);
    assert.equal((await intents.get(item.intentId)).status,'DRAFT');
    // A receipt for any other intent may not authorize this one.
    await assert.rejects(intents.transition(item.intentId,{type:'RISK_APPROVED',atMs:Date.now(),
      receipt:{mode:'SHADOW_ONLY',allowed:true,intentId:'0'.repeat(64),vaultAddress:vault,
        coin:'BTC',requiresReduceOnly:false}}),/receipt disagrees/);

    // Approval is bound to the exact intent, never just the market or vault.
    const approvedAt=Date.now();
    await intents.transition(item.intentId,{type:'RISK_APPROVED',atMs:approvedAt,
      receipt:{mode:'SHADOW_ONLY',allowed:true,intentId:item.intentId,
        vaultAddress:vault,coin:'BTC',requiresReduceOnly:false}});
    // General transition() MUST reject attempts to bypass the active writer.
    await assert.rejects(intents.transition(item.intentId,{
      type:'SUBMISSION_STARTED',atMs:Date.now(),clientOrderId:item.clientOrderId,
      riskRecheckedAtMs:Date.now()}),/fenced vault lease/);
    // No control row exists yet: the vault must fail closed.
    const pendingEvent={type:'SUBMISSION_STARTED',atMs:Date.now(),
      clientOrderId:item.clientOrderId,riskRecheckedAtMs:Date.now()};
    await assert.rejects(intents.beginSubmission(item.intentId,pendingEvent,
      {vaultAddress:vault,writerId:b,fencingToken:'2'}),/Emergency HALT/);
    // TEST HARNESS ONLY. Production has NO 'arm' API; separate operator review
    // would be required to create such a row for a real vault.
    await pool.query(`INSERT INTO v2_vault_execution_controls
      (vault_address,halted,generation,halt_reason,halted_by)
      VALUES ($1,FALSE,1,'isolated CI test only','ci')`,[vault]);
    // DB-clock freshness, ownership and unsettled-intent checks are performed
    // atomically by beginSubmission(). NO external exchange request occurs.
    await lease.renew({vaultAddress:vault,writerId:b,fencingToken:'2',ttlMs:15000});
    const submissionAt=Date.now();
    // An expired/replaced writer cannot prepare a submission.
    await assert.rejects(intents.beginSubmission(item.intentId,{
      type:'SUBMISSION_STARTED',atMs:submissionAt,clientOrderId:item.clientOrderId,
      riskRecheckedAtMs:submissionAt
    },{vaultAddress:vault,writerId:a,fencingToken:'1'}),/Lease lost|expired/);
    const submitting=await intents.beginSubmission(item.intentId,{
      type:'SUBMISSION_STARTED',atMs:submissionAt,clientOrderId:item.clientOrderId,
      riskRecheckedAtMs:submissionAt
    },{vaultAddress:vault,writerId:b,fencingToken:'2'});
    assert.equal(submitting.status,'SUBMITTING');
    const halt=new PgEmergencyStop(pool);
    const stopped=await halt.halt({vaultAddress:vault,
      reason:'Explicitly stop this disposable CI test vault',requestedBy:'ci'});
    assert.equal(stopped.halted,true);
    assert.equal((await halt.status(vault)).halted,true);
    // The test DOES NOT submit anything to Hyperliquid, despite simulating
    // the durable state transition that would precede an external request.
    await lease.release({vaultAddress:vault,writerId:b,fencingToken:'2'});
    await assert.rejects(lease.acquire({vaultAddress:vault,writerId:randomUUID()}),/Unresolved exchange intent/);
    assert.equal((await intents.unresolvedForVault(vault)).length,1);
    process.stdout.write('PASS: isolated PostgreSQL lease fencing, intent transactions, and unresolved-order takeover halt\n');
  }finally{
    // Delete only the unique test vault's rows. Never touch other data.
    try{
      if(intentId)await pool.query('DELETE FROM v2_execution_events WHERE intent_id=$1',[intentId]);
      await pool.query('DELETE FROM v2_execution_intents WHERE vault_address=$1',[vault]);
      await pool.query('DELETE FROM v2_vault_execution_controls WHERE vault_address=$1',[vault]);
      await pool.query('DELETE FROM v2_vault_writer_leases WHERE vault_address=$1',[vault]);
    }finally{await pool.end();}
  }
}
run().catch(e=>{process.stderr.write(`ISOLATED POSTGRES TEST FAILED: ${e.message}\n`);process.exitCode=1;});