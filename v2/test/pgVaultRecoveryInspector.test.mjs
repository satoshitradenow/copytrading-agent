import test from 'node:test';
import assert from 'node:assert/strict';
import {PgVaultRecoveryInspector} from '../src/pgVaultRecoveryInspector.mjs';

const V='0x'+'a'.repeat(40),BATCH='b'.repeat(64),INTENT='c'.repeat(64);
function fake(overrides={}){
 const db={controls:null,lease:null,pending:[],intents:[],audits:[],
  queries:[],commits:0,rollbacks:0,released:0,failSQL:null,...overrides};
 return {db,pool:{async connect(){return {release(){db.released++;},
  async query(sql,params=[]){
   db.queries.push({sql,params});
   if(db.failSQL&&sql.includes(db.failSQL))throw Error('Database unavailable');
   if(sql.startsWith('BEGIN'))return {rows:[]};
   if(sql==='COMMIT'){db.commits++;return {rows:[]};}
   if(sql==='ROLLBACK'){db.rollbacks++;return {rows:[]};}
   if(sql.includes('FROM v2_vault_execution_controls'))
    return {rows:db.controls?[structuredClone(db.controls)]:[]};
   if(sql.includes('FROM v2_vault_writer_leases'))
    return {rows:db.lease?[structuredClone(db.lease)]:[]};
   if(sql.includes('FROM v2_portfolio_batches'))
    return {rows:structuredClone(db.pending)};
   if(sql.includes('FROM v2_execution_intents'))
    return {rows:structuredClone(db.intents)};
   if(sql.includes('FROM v2_settlement_audits'))
    return {rows:structuredClone(db.audits)};
   throw Error('Unexpected recovery SQL');
  }}};}};
}
test('missing controls and writer lease always yield a blocked diagnostic',async()=>{
 const {pool,db}=fake();
 const r=await new PgVaultRecoveryInspector(pool).inspect({vaultAddress:V});
 assert.equal(r.mode,'READ_ONLY_RECOVERY_INSPECTION');
 assert.equal(r.halted,true);
 assert.equal(r.readyToResumeTrading,false);
 assert.equal(r.executeAuthorized,false);
 assert.equal(r.safeToResubmit,false);
 assert.equal(r.settlementAuthorized,false);
 assert.equal(r.requiresIndependentExchangeReconciliation,true);
 assert.ok(r.blockingReasons.includes('MISSING_EXECUTION_CONTROL_HALTED_BY_DEFAULT'));
 assert.ok(r.blockingReasons.includes('NO_VERIFIED_WRITER_LEASE'));
 assert.equal(db.commits,1);assert.equal(db.rollbacks,0);assert.equal(db.released,1);
 assert.equal(db.queries[0].sql,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 assert.deepEqual(r.executionIntents,[]);
});
test('even an explicitly non-halted control row cannot authorize live execution',async()=>{
 const {pool}=fake({controls:{vault_address:V,halted:false,generation:'9',halt_reason:null}});
 const r=await new PgVaultRecoveryInspector(pool).inspect({vaultAddress:V});
 assert.equal(r.halted,false);
 assert.equal(r.readyToResumeTrading,false);
 assert.ok(r.blockingReasons.includes('CONTROL_NOT_HALTED_BUT_NO_TRADE_AUTHORITY'));
 assert.ok(r.blockingReasons.includes('LIVE_EXECUTION_NOT_IMPLEMENTED_OR_AUTHORIZED'));
});
test('expired writer lease is reported using database active flag, not client wall clock',async()=>{
 const lease={vault_address:V,writer_id:'worker',fencing_token:'2',
  expires_at:'2000-01-01T00:00:00.000Z',active:false};
 const {pool}=fake({lease});
 const r=await new PgVaultRecoveryInspector(pool).inspect({vaultAddress:V});
 assert.equal(r.leasePresent,true);assert.equal(r.leaseActive,false);
 assert.ok(r.blockingReasons.includes('EXPIRED_WRITER_LEASE_NEEDS_RECONCILIATION'));
 assert.equal(r.readyToResumeTrading,false);
});
test('active writer, unresolved exchange result, and staged batch show all holds',async()=>{
 const lease={vault_address:V,writer_id:'worker',fencing_token:'8',
  expires_at:'2099-01-01T00:00:00.000Z',active:true};
 const {pool}=fake({
  controls:{vault_address:V,halted:true,generation:'4',halt_reason:'Operator stop'},
  lease,
  pending:[{batch_id:BATCH,status:'STAGED',source_fill_key:'source:sample'}],
  intents:[{intent_id:INTENT,status:'UNKNOWN'}],
  audits:[{audit_seq:'3',chain_hash:'1'.repeat(64)}]
 });
 const r=await new PgVaultRecoveryInspector(pool).inspect({vaultAddress:V});
 assert.deepEqual(r.executionIntents,[{intentId:INTENT,status:'UNKNOWN'}]);
 assert.equal(r.pendingBatch.batchId,BATCH);
 assert.equal(r.pendingBatch.auditIntegrityVerified,false);
 assert.equal(r.pendingBatch.lastAuditSequence,'3');
 for(const code of ['EMERGENCY_HALT_ACTIVE','WRITER_LEASE_ACTIVE_NEEDS_RECONCILIATION',
  'UNRESOLVED_EXCHANGE_INTENT','PENDING_SOURCE_BATCH',
  'SETTLEMENT_EVIDENCE_REQUIRES_INDEPENDENT_CHAIN_VERIFICATION'])
  assert.ok(r.blockingReasons.includes(code),code);
 assert.equal(r.executeAuthorized,false);
});
test('missing audit evidence is explicit, not a green readiness signal',async()=>{
 const {pool}=fake({pending:[{batch_id:BATCH,status:'REVIEW_REQUIRED',source_fill_key:'f'}]});
 const r=await new PgVaultRecoveryInspector(pool).inspect({vaultAddress:V});
 assert.equal(r.pendingBatch.lastAuditSequence,null);
 assert.ok(r.blockingReasons.includes('MISSING_SETTLEMENT_EVIDENCE'));
});
test('repeated pending batches or >200 execution intents fail closed',async()=>{
 const batch={batch_id:BATCH,status:'STAGED',source_fill_key:'f'};
 const {pool,db}=fake({pending:[batch,{...batch,batch_id:'a'.repeat(64)}]});
 await assert.rejects(new PgVaultRecoveryInspector(pool).inspect({vaultAddress:V}),/multiple pending/);
 assert.equal(db.rollbacks,1);assert.equal(db.commits,0);
 const b=fake({intents:Array.from({length:201},()=>({intent_id:INTENT,status:'DRAFT'}))});
 await assert.rejects(new PgVaultRecoveryInspector(b.pool).inspect({vaultAddress:V}),/Unbounded intent history/);
});
test('unknown or corrupt intent status never implies successful reconciliation',async()=>{
 for(const status of ['AUTOMATICALLY_SETTLED',null]){
  const {pool}=fake({intents:[{intent_id:INTENT,status}]});
  await assert.rejects(new PgVaultRecoveryInspector(pool).inspect({vaultAddress:V}),
   /Unknown or corrupt/);
 }
});
test('database outage aborts inspection and releases the connection',async()=>{
 const {pool,db}=fake({failSQL:'FROM v2_execution_intents'});
 await assert.rejects(new PgVaultRecoveryInspector(pool).inspect({vaultAddress:V}),/Database unavailable/);
 assert.equal(db.commits,0);assert.equal(db.rollbacks,1);assert.equal(db.released,1);
});
test('an old FILLED intent remains a reconciliation hold without a separate settlement proof',async()=>{
 const {pool}=fake({intents:[{intent_id:INTENT,status:'FILLED'}]});
 const r=await new PgVaultRecoveryInspector(pool).inspect({vaultAddress:V});
 assert.ok(r.blockingReasons.includes('UNRESOLVED_EXCHANGE_INTENT'));
 assert.equal(r.readyToResumeTrading,false);
});
test('report only accepts an exact vault identity and has no arming API',async()=>{
 const {pool}=fake();
 const r=new PgVaultRecoveryInspector(pool);
 await assert.rejects(r.inspect({vaultAddress:'HL:invalid'}),/42-character/);
 assert.equal(typeof r.arm,'undefined');
 assert.equal(typeof r.resume,'undefined');
 assert.equal(typeof r.settle,'undefined');
});
