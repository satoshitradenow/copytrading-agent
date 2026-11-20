import test from 'node:test';
import assert from 'node:assert/strict';
import {ShadowPortfolioNetting} from '../src/portfolioNetting.mjs';
import {MemoryJournal} from '../src/ledger.mjs';
import {validateStagedPortfolioPreview} from '../src/pgPortfolioBatchRepository.mjs';
import {PgSettlementAuditLog} from '../src/pgSettlementAuditLog.mjs';

const VAULT='0x'+'9'.repeat(40),TRADER='0x'+'1'.repeat(40);
function setup(){
 const fill={trader:TRADER,fillId:'HL:AUDIT',coin:'BTC',side:'buy',size:'1',
  priceUsd:'50000',sourceStartPosition:'0',timeMs:100000};
 const plan=new ShadowPortfolioNetting({vaultAddress:VAULT,
  traders:[{address:TRADER,allocationUsd:'1000',maxVirtualLeverage:5,enabled:true}],
  allowedCoins:['BTC'],journal:new MemoryJournal()});
 const preview=plan.preview({fill,nowMs:100090,unresolvedIntents:[],
  sourceObservation:{mode:'READ_ONLY',network:'mainnet',trader:TRADER,
   accountValueUsd:'100000',observedAtStartMs:100010,observedAtEndMs:100020,
   positions:[{position:{coin:'BTC',szi:'1'}}]},
  vaultSnapshot:{mode:'READ_ONLY',network:'mainnet',vaultAddress:VAULT,
   asOfMs:100040,positions:{BTC:'0'}}});
 return {...preview,batchId:validateStagedPortfolioPreview(preview).batchId};
}
const snap=(positions,asOfMs)=>({mode:'READ_ONLY',network:'mainnet',
 vaultAddress:VAULT,positions,asOfMs});
function request(preview,legReports=[null],nowMs=102000){
 return {preview,initialVaultSnapshot:snap(preview.expectedNetBefore,100100),
  legReports,nowMs};
}
function fullReport(preview){
 const leg=preview.intents[0],oid=321;
 return {statusResponse:{status:'order',order:{status:'filled',statusTimestamp:100900,
  order:{oid,cloid:leg.clientOrderId,coin:leg.coin,
   side:leg.side==='buy'?'B':'A',origSz:leg.size,reduceOnly:false}}},
  observedFills:[{oid,tid:21,coin:leg.coin,side:'B',sz:leg.size,time:100800}],
  vaultSnapshot:snap({BTC:leg.netAfter},101000)};
}
function poolFor(preview){
 const spec=validateStagedPortfolioPreview(preview);
 const db={batch:{batch_id:spec.batchId,vault_address:VAULT,network:spec.network,
   source_fill_key:spec.sourceFillKey,source_record:spec.sourceRecord,
   expected_net_before:spec.expectedNetBefore,desired_net_after:spec.desiredNetAfter,
   planned_legs:spec.legs,status:'STAGED'},logs:[],rollbacks:0,commits:0,failInsert:false};
 const query=async(q,args,working)=>{
  if(q.startsWith('SELECT batch_id,vault_address,network,source_fill_key')){
   return {rows:db.batch&&db.batch.batch_id===args[0]&&db.batch.vault_address===args[1]
    ?[structuredClone(db.batch)]:[]};
  }
  if(q.startsWith('SELECT batch_id,audit_seq,vault_address,evidence_digest')){
   return {rows:structuredClone(working??db.logs)};
  }
  if(q.startsWith('INSERT INTO v2_settlement_audits')){
   if(db.failInsert)throw Error('Simulated INSERT failure');
   const [batch_id,audit_seq,vault_address,evidence_digest,previous_chain_hash,chain_hash,evidence,audit_report]=args;
   if((working??db.logs).some(x=>x.audit_seq===audit_seq))throw Error('Duplicate audit sequence');
   (working??db.logs).push({batch_id,audit_seq,vault_address,evidence_digest,
    previous_chain_hash,chain_hash,evidence:JSON.parse(evidence),audit_report:JSON.parse(audit_report)});
   return {rowCount:1,rows:[{audit_seq}]};
  }
  throw Error('Unexpected audit SQL '+q.slice(0,75));
 };
 return {db,pool:{
  query:async(q,args=[])=>query(q,args,null),
  connect:async()=>{
   let working=null;
   return {release(){},async query(q,args=[]){
    if(q.startsWith('BEGIN')){working=structuredClone(db.logs);return {rows:[]};}
    if(q==='COMMIT'){db.logs=working;db.commits++;working=null;return {rows:[]};}
    if(q==='ROLLBACK'){db.rollbacks++;working=null;return {rows:[]};}
    if(working===null)throw Error('Outside transaction');
    return query(q,args,working);
   }};
  }
 }};
}

test('a corroborated exchange report is stored as review-only, never settled or executable',async()=>{
 const preview=setup(),{db,pool}=poolFor(preview),repo=new PgSettlementAuditLog(pool);
 const out=await repo.record(request(preview,[fullReport(preview)]));
 assert.equal(out.report.classification,'CORROBORATED_BUT_NOT_SETTLED');
 assert.equal(out.report.commitAuthorized,false);
 assert.equal(out.commitAuthorized,false);
 assert.equal(out.executeAuthorized,false);
 assert.equal(out.safeToResubmit,false);
 assert.equal(db.batch.status,'STAGED');
 assert.equal(db.logs.length,1);
 assert.equal((await repo.listForReview({batchId:preview.batchId,vaultAddress:VAULT}))[0].chainHash,out.chainHash);
});
test('audit history is idempotent for identical evidence and chained across new observations',async()=>{
 const preview=setup(),{db,pool}=poolFor(preview),repo=new PgSettlementAuditLog(pool);
 const a=await repo.record(request(preview));
 const same=await repo.record(request(preview));
 assert.equal(same.idempotent,true);
 assert.equal(same.chainHash,a.chainHash);
 assert.equal(db.logs.length,1);
 const b=await repo.record(request(preview,[{statusResponse:{status:'unknownOid'}}]));
 assert.equal(b.auditSeq,'2');
 assert.notEqual(b.chainHash,a.chainHash);
 assert.equal(b.report.classification,'REQUIRES_RECONCILIATION');
 assert.equal(db.logs[1].previous_chain_hash,a.chainHash);
 assert.equal((await repo.listForReview({batchId:preview.batchId,vaultAddress:VAULT})).length,2);
});
test('corrupt evidence, broken chain and forged settled flags are rejected on read and append',async()=>{
 const preview=setup(),{db,pool}=poolFor(preview),repo=new PgSettlementAuditLog(pool);
 await repo.record(request(preview));
 const originalEvidence=structuredClone(db.logs[0].evidence);
 db.logs[0].evidence.initialVaultSnapshot.positions.BTC='123';
 await assert.rejects(repo.listForReview({batchId:preview.batchId,vaultAddress:VAULT}));
 await assert.rejects(repo.record(request(preview,[{statusResponse:{status:'unknownOid'}}])));
 db.logs[0].evidence=originalEvidence;
 db.logs[0].chain_hash='f'.repeat(64);
 await assert.rejects(repo.listForReview({batchId:preview.batchId,vaultAddress:VAULT}),/chain hash mismatch/);
 db.logs[0].chain_hash='0'.repeat(64);
 await assert.rejects(repo.record(request(preview)),/chain hash mismatch/);
});
test('identity mismatch, corrupt stored batch and settled batch never accept new audits',async()=>{
 const preview=setup(),{db,pool}=poolFor(preview),repo=new PgSettlementAuditLog(pool);
 await assert.rejects(repo.record(request({...preview,batchId:'f'.repeat(64)})),/batch ID mismatch/);
 db.batch.source_record.fillDigest='0'.repeat(64);
 await assert.rejects(repo.record(request(preview)),/batch hash corruption/);
 db.batch.source_record=validateStagedPortfolioPreview(preview).sourceRecord;
 db.batch.status='SETTLED';
 await assert.rejects(repo.record(request(preview)),/settled batch/);
 assert.equal(db.logs.length,0);
});
test('database insert errors roll back and the audit stays absent',async()=>{
 const preview=setup(),{db,pool}=poolFor(preview),repo=new PgSettlementAuditLog(pool);
 db.failInsert=true;
 await assert.rejects(repo.record(request(preview)),/INSERT failure/);
 assert.equal(db.logs.length,0);assert.equal(db.rollbacks,1);
});
test('audit rejects non-JSON input rather than silently dropping evidence fields',async()=>{
 const preview=setup(),{db,pool}=poolFor(preview),repo=new PgSettlementAuditLog(pool);
 await assert.rejects(repo.record({...request(preview),unrelated:undefined,legReports:[{bad:undefined}]}),
  /safe JSON/);
 assert.equal(db.logs.length,0);
});
