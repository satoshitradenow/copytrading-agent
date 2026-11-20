import test from 'node:test';
import assert from 'node:assert/strict';
import {ShadowPortfolioNetting} from '../src/portfolioNetting.mjs';
import {MemoryJournal} from '../src/ledger.mjs';
import {validateStagedPortfolioPreview} from '../src/pgPortfolioBatchRepository.mjs';
import {PgSettlementAuditLog} from '../src/pgSettlementAuditLog.mjs';

const VAULT='0x'+'9'.repeat(40),TRADER='0x'+'1'.repeat(40);
function setup(fillId='HL:AUDIT'){
 const fill={trader:TRADER,fillId,coin:'BTC',side:'buy',size:'1',
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
   planned_legs:spec.legs,status:'STAGED'},logs:[],fillClaims:[],rollbacks:0,commits:0,failInsert:false};
 const query=async(q,args,working,workingClaims)=>{
  if(q.startsWith('SELECT batch_id,vault_address,network,source_fill_key')){
   return {rows:db.batch&&db.batch.batch_id===args[0]&&db.batch.vault_address===args[1]
    ?[structuredClone(db.batch)]:[]};
  }
  if(q.startsWith('SELECT batch_id,audit_seq,vault_address,evidence_digest')){
   return {rows:structuredClone((working??db.logs).filter(x=>x.batch_id===args[0]))};
  }
  if(q.startsWith('INSERT INTO v2_settlement_audits')){
   if(db.failInsert)throw Error('Simulated INSERT failure');
   const [batch_id,audit_seq,vault_address,evidence_digest,previous_chain_hash,chain_hash,evidence,audit_report]=args;
   if((working??db.logs).some(x=>x.audit_seq===audit_seq))throw Error('Duplicate audit sequence');
   (working??db.logs).push({batch_id,audit_seq,vault_address,evidence_digest,
    previous_chain_hash,chain_hash,evidence:JSON.parse(evidence),audit_report:JSON.parse(audit_report)});
   return {rowCount:1,rows:[{audit_seq}]};
  }
  if(q.startsWith('INSERT INTO v2_observed_exchange_fills')){
   const [network,vault_address,trade_id,batch_id,client_order_id,exchange_order_id,economic_digest,economic_record]=args;
   const claims=workingClaims??db.fillClaims;
   if(claims.some(x=>x.network===network&&x.vault_address===vault_address&&x.trade_id===trade_id))
    return {rowCount:0,rows:[]};
   claims.push({network,vault_address,trade_id,batch_id,client_order_id,
    exchange_order_id,economic_digest,economic_record:JSON.parse(economic_record)});
   return {rowCount:1,rows:[{trade_id}]};
  }
  if(q.startsWith('SELECT network,vault_address,trade_id,batch_id')){
   const [network,vault_address,trade_id]=args;
   return {rows:structuredClone((workingClaims??db.fillClaims).filter(x=>
    x.network===network&&x.vault_address===vault_address&&x.trade_id===trade_id))};
  }
  throw Error('Unexpected audit SQL '+q.slice(0,75));
 };
 return {db,pool:{
  query:async(q,args=[])=>query(q,args,null,null),
  connect:async()=>{
   let working=null,workingClaims=null;
   return {release(){},async query(q,args=[]){
    if(q.startsWith('BEGIN')){
     working=structuredClone(db.logs);workingClaims=structuredClone(db.fillClaims);return {rows:[]};
    }
    if(q==='COMMIT'){
     db.logs=working;db.fillClaims=workingClaims;db.commits++;
     working=null;workingClaims=null;return {rows:[]};
    }
    if(q==='ROLLBACK'){
     db.rollbacks++;working=null;workingClaims=null;return {rows:[]};
    }
    if(working===null)throw Error('Outside transaction');
    return query(q,args,working,workingClaims);
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

test('economic fill-path review is versioned in same durable chain, independently verified on read',async()=>{
 const preview=setup(),{db,pool}=poolFor(preview),repo=new PgSettlementAuditLog(pool);
 const requestArgs=request(preview,[fullReport(preview)]);
 const leg=preview.intents[0],row=requestArgs.legReports[0].observedFills[0];
 Object.assign(row,{px:'50000',fee:'0.2',feeToken:'USDC',closedPnl:'0',
  startPosition:leg.netBefore,crossed:true});
 const base=await repo.record(requestArgs);
 const economic=await repo.recordEconomics(requestArgs);
 assert.equal(base.report.classification,'CORROBORATED_BUT_NOT_SETTLED');
 assert.equal(economic.report.classification,'ECONOMIC_PATH_CORROBORATED_BUT_NOT_SETTLED');
 assert.equal(economic.evidence.auditVariant,'FILL_PATH_ECONOMIC_V1');
 assert.equal(economic.report.commitAuthorized,false);
 assert.equal(economic.commitAuthorized,false);
 assert.equal(db.batch.status,'STAGED');
 assert.equal(db.logs.length,2);
 assert.equal(db.logs[1].previous_chain_hash,base.chainHash);
 assert.equal((await repo.recordEconomics(requestArgs)).idempotent,true);
 assert.equal(db.logs.length,2);
 const restored=await new PgSettlementAuditLog(pool).listForReview({
  batchId:preview.batchId,vaultAddress:VAULT
 });
 assert.equal(restored[0].report.classification,'CORROBORATED_BUT_NOT_SETTLED');
 assert.equal(restored[1].report.classification,'ECONOMIC_PATH_CORROBORATED_BUT_NOT_SETTLED');
 assert.equal(restored[1].report.economicLegAudits[0].path.economics.observedFeeUsd,'0.2');
 db.logs[1].audit_report.economicLegAudits[0].path.economics.observedFeeUsd='999';
 await assert.rejects(repo.listForReview({batchId:preview.batchId,vaultAddress:VAULT}),
  /Stored settlement report disagrees/);
});
test('economics record fails closed when fee or pre-fill position is missing',async()=>{
 const preview=setup(),{db,pool}=poolFor(preview),repo=new PgSettlementAuditLog(pool);
 const args=request(preview,[fullReport(preview)]);
 await assert.rejects(repo.recordEconomics(args),/fill price|price|fee|startPosition/);
 assert.equal(db.logs.length,0);
});
test('unknown audit variant can never be silently interpreted as the older algorithm',async()=>{
 const preview=setup(),{db,pool}=poolFor(preview),repo=new PgSettlementAuditLog(pool);
 await repo.record(request(preview));
 db.logs[0].evidence.auditVariant='FUTURE_UNSUPPORTED';
 await assert.rejects(repo.listForReview({batchId:preview.batchId,vaultAddress:VAULT}),
  /Unknown settlement review algorithm version/);
});

function completeEconomicArgs(preview,patch={}){
 const args=request(preview,[fullReport(preview)]),leg=preview.intents[0];
 Object.assign(args.legReports[0].observedFills[0],{
  px:'50000',fee:'0.2',feeToken:'USDC',closedPnl:'0',
  startPosition:leg.netBefore,crossed:true,...patch
 });
 return args;
}
test('verified exchange TID claims are persisted atomically with an economic review',async()=>{
 const p=setup(),{db,pool}=poolFor(p),audits=new PgSettlementAuditLog(pool);
 const first=await audits.recordEconomics(completeEconomicArgs(p));
 assert.equal(first.report.classification,'ECONOMIC_PATH_CORROBORATED_BUT_NOT_SETTLED');
 assert.equal(db.logs.length,1);assert.equal(db.fillClaims.length,1);
 assert.equal(db.fillClaims[0].batch_id,p.batchId);
 assert.equal(db.fillClaims[0].trade_id,'21');
 assert.equal(db.fillClaims[0].economic_record.fee,'0.2');
 assert.equal((await audits.recordEconomics(completeEconomicArgs(p))).idempotent,true);
 assert.equal(db.logs.length,1);assert.equal(db.fillClaims.length,1);
 assert.equal((await audits.listForReview({batchId:p.batchId,vaultAddress:VAULT})).length,1);
});
test('same exchange trade TID with edited fee or identity is blocked even within same batch',async()=>{
 const p=setup(),{db,pool}=poolFor(p),audits=new PgSettlementAuditLog(pool);
 await audits.recordEconomics(completeEconomicArgs(p));
 const dirty=completeEconomicArgs(p,{fee:'0.99'});
 await assert.rejects(audits.recordEconomics(dirty),
  /Observed exchange TID collision, changed economic fields/);
 assert.equal(db.logs.length,1);assert.equal(db.fillClaims.length,1);
 assert.equal(db.rollbacks,1);
});
test('same exchange TID cannot be attributed to two different source fill batches',async()=>{
 const first=setup(),{db,pool}=poolFor(first),audits=new PgSettlementAuditLog(pool);
 await audits.recordEconomics(completeEconomicArgs(first));
 const next=setup('HL:INDEPENDENT-SOURCE-FILL'),b=validateStagedPortfolioPreview(next);
 assert.notEqual(first.batchId,next.batchId);
 db.batch={batch_id:b.batchId,vault_address:VAULT,network:b.network,
  source_fill_key:b.sourceFillKey,source_record:b.sourceRecord,
  expected_net_before:b.expectedNetBefore,desired_net_after:b.desiredNetAfter,
  planned_legs:b.legs,status:'STAGED'};
 await assert.rejects(audits.recordEconomics(completeEconomicArgs(next)),
  /Observed exchange TID collision, changed economic fields/);
 assert.equal(db.logs.length,1);assert.equal(db.fillClaims.length,1);
 assert.equal(db.fillClaims[0].batch_id,first.batchId);
});
test('tampered or deleted fill registry row invalidates a historically valid review',async()=>{
 const p=setup(),{db,pool}=poolFor(p),audits=new PgSettlementAuditLog(pool);
 await audits.recordEconomics(completeEconomicArgs(p));
 const original=structuredClone(db.fillClaims[0]);
 db.fillClaims[0].economic_record.fee='999';
 await assert.rejects(audits.listForReview({batchId:p.batchId,vaultAddress:VAULT}),
  /Observed exchange TID collision, changed economic fields/);
 db.fillClaims[0]=original;
 db.fillClaims.splice(0);
 await assert.rejects(audits.record(completeEconomicArgs(p)),
  /missing registry record/);
 assert.equal(db.logs.length,1);
});
test('failed audit insert rolls back the new fill claim along with the report',async()=>{
 const p=setup(),{db,pool}=poolFor(p),audits=new PgSettlementAuditLog(pool);
 db.failInsert=true;
 await assert.rejects(audits.recordEconomics(completeEconomicArgs(p)),/INSERT failure/);
 assert.equal(db.logs.length,0);assert.equal(db.fillClaims.length,0);
 assert.equal(db.rollbacks,1);
});
