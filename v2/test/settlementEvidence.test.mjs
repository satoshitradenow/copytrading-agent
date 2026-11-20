import test from 'node:test';
import assert from 'node:assert/strict';
import {ShadowPortfolioNetting} from '../src/portfolioNetting.mjs';
import {ShadowLedger,MemoryJournal} from '../src/ledger.mjs';
import {validateStagedPortfolioPreview} from '../src/pgPortfolioBatchRepository.mjs';
import {auditStagedPortfolioSettlement} from '../src/settlementEvidence.mjs';

const VAULT='0x'+'9'.repeat(40),TRADER='0x'+'1'.repeat(40);
const traders=[{address:TRADER,allocationUsd:'1000',maxVirtualLeverage:5,enabled:true}];
const FILL={trader:TRADER,fillId:'HL:45',coin:'BTC',side:'buy',size:'1',priceUsd:'50000',sourceStartPosition:'0',timeMs:100_000};
const NOW=102_000;
function observedPos(positions={},at=100_150,opts={}) {return {mode:'READ_ONLY',vaultAddress:VAULT,network:'mainnet',positions,asOfMs:at,...opts};}
function staged({flip=false}={}){
 const journal=new MemoryJournal();
 if(flip)new ShadowLedger({traders,allowedCoins:['BTC'],journal}).applyFill({...FILL,sourceEquityUsd:'100000'});
 const f=flip?{...FILL,fillId:'HL:46',side:'sell',size:'2',sourceStartPosition:'1',timeMs:100_000}:FILL;
 const preview=new ShadowPortfolioNetting({vaultAddress:VAULT,traders,allowedCoins:['BTC'],journal}).preview({
  fill:f,nowMs:100_090,unresolvedIntents:[],
  sourceObservation:{mode:'READ_ONLY',network:'mainnet',trader:TRADER,accountValueUsd:'100000',observedAtStartMs:100_010,observedAtEndMs:100_020,
    positions:[{position:{coin:'BTC',szi:flip?'-1':'1'}}]},
  vaultSnapshot:observedPos(flip?{BTC:'0.01'}:{BTC:'0'},100_040),
 });
 return {...preview,batchId:validateStagedPortfolioPreview(preview).batchId};
}
function proof(leg,{status='filled',sz=leg.size,tid='21',oid=321,snapshotAt=101_000,statusAt=100_900,position=leg.netAfter}={}){
 return {statusResponse:{status:'order',order:{status,statusTimestamp:statusAt,order:{oid,cloid:leg.clientOrderId,coin:leg.coin,side:leg.side==='buy'?'B':'A',origSz:leg.size,reduceOnly:leg.netBefore!=='0'&&leg.netAfter==='0'}}},
    observedFills:[{oid,tid,coin:leg.coin,side:leg.side==='buy'?'B':'A',sz,time:100_800}],
    vaultSnapshot:observedPos({BTC:position},snapshotAt)};
}
const audit=(p,reports,extra={})=>auditStagedPortfolioSettlement({preview:p,initialVaultSnapshot:observedPos(p.expectedNetBefore,100_100),legReports:reports,nowMs:NOW,...extra});

test('complete order and matching vault position generate review-only corroboration, NEVER settlement',()=>{
 const p=staged(),o=audit(p,[proof(p.intents[0])]);
 assert.equal(o.classification,'CORROBORATED_BUT_NOT_SETTLED');
 assert.equal(o.legAudits[0].classification,'CORROBORATED_REVIEW_ONLY');
 assert.equal(o.safeToResubmit,false);assert.equal(o.commitAuthorized,false);assert.equal(o.executeAuthorized,false);
 assert.equal(o.historyComplete,false);assert.equal(o.requiresOperatorReview,true);
});
test('partial filled size remains unresolved even when exchange status says filled',()=>{
 const p=staged(),o=audit(p,[proof(p.intents[0],{sz:'0.005',position:'0.005'})]);
 assert.equal(o.classification,'REQUIRES_RECONCILIATION');
 assert.ok(o.legAudits[0].reasons.includes('OBSERVED_SIZE_INCOMPLETE'));
});
test('cancelled or still-open orders never count as settled, even with full reported fill size',()=>{
 const p=staged();for(const status of ['canceled','open','rejected']){
  const o=audit(p,[proof(p.intents[0],{status})]);
  assert.equal(o.classification,'REQUIRES_RECONCILIATION');
 }});
test('unknownOid does not authorize a retry or count as non-execution',()=>{
 const p=staged(),leg=p.intents[0],report=proof(leg);report.statusResponse={status:'unknownOid'};
 const o=audit(p,[report]);
 assert.equal(o.legAudits[0].classification,'UNCONFIRMED');
 assert.equal(o.safeToResubmit,false);
});
test('wrong client order ID and forged reduce-only status throw rather than certify another order',()=>{
 const p=staged(),r=proof(p.intents[0]);r.statusResponse.order.order.cloid='0x'+'0'.repeat(32);
 assert.throws(()=>audit(p,[r]),/does not match/);
 const r2=proof(p.intents[0]);r2.statusResponse.order.order.reduceOnly=true;
 assert.throws(()=>audit(p,[r2]),/does not match/);
});
test('post-order vault position drift is unresolved despite apparent full fills',()=>{
 const p=staged(),o=audit(p,[proof(p.intents[0],{position:'0.009'})]);
 assert.equal(o.classification,'REQUIRES_RECONCILIATION');
 assert.ok(o.legAudits[0].reasons.includes('POST_ORDER_POSITION_DRIFT:BTC'));
});
test('untracked unrelated coin position is also drift; do not ignore manual trades',()=>{
 const p=staged(),r=proof(p.intents[0]);r.vaultSnapshot.positions.ETH='0.5';
 assert.ok(audit(p,[r]).legAudits[0].reasons.includes('POST_ORDER_POSITION_DRIFT:ETH'));
});
test('invalid batch digest is never treated as exchange evidence',()=>{
 const p=staged();assert.throws(()=>audit({...p,batchId:'0'.repeat(64)},[]),/batch hash mismatch/);
});
test('pre-order vault drift, wrong network and wrong vault reject before any audit',()=>{
 const p=staged(),r=proof(p.intents[0]);
 assert.throws(()=>auditStagedPortfolioSettlement({preview:p,initialVaultSnapshot:observedPos({BTC:'1'}),legReports:[r],nowMs:NOW}),/Pre-order vault position drift/);
 r.vaultSnapshot.network='testnet';assert.throws(()=>audit(p,[r]),/network mismatch/);
 r.vaultSnapshot.network='mainnet';r.vaultSnapshot.vaultAddress='0x'+'8'.repeat(40);
 assert.throws(()=>audit(p,[r]),/identity or network mismatch/);
});
test('stale final account observation requires reconciliation even with matching evidence',()=>{
 const p=staged(),o=audit(p,[proof(p.intents[0])],{nowMs:120_000,maxSnapshotAgeMs:5_000});
 assert.equal(o.classification,'REQUIRES_RECONCILIATION');
 assert.ok(o.reasons.includes('LAST_VAULT_SNAPSHOT_STALE'));
});
test('snapshot before fill status cannot corroborate order settlement',()=>{
 const p=staged(),o=audit(p,[proof(p.intents[0],{statusAt:101_100,snapshotAt:101_000})]);
 assert.ok(o.legAudits[0].reasons.includes('SNAPSHOT_PRECEDES_ORDER_STATUS'));
});
test('full close and confirmed separate open can corroborate both legs but cannot auto-commit',()=>{
 const p=staged({flip:true});assert.equal(p.intents.length,2);
 const one=proof(p.intents[0],{oid:10,tid:'100',snapshotAt:100_950,statusAt:100_900,position:'0'});
 const two=proof(p.intents[1],{oid:11,tid:'101',snapshotAt:101_300,statusAt:101_200,position:'-0.01'});
 two.observedFills[0].time=101_100;
 const o=audit(p,[one,two]);
 assert.equal(o.classification,'CORROBORATED_BUT_NOT_SETTLED');
 assert.deepEqual(o.legAudits.map(x=>x.classification),['CORROBORATED_REVIEW_ONLY','CORROBORATED_REVIEW_ONLY']);
 assert.equal(o.commitAuthorized,false);
});
test('unresolved reversal close prevents second leg from being classified complete',()=>{
 const p=staged({flip:true});const one=proof(p.intents[0],{status:'canceled',sz:'0.005',position:'0.005'});
 const two=proof(p.intents[1],{oid:11,tid:'101',snapshotAt:101_300,statusAt:101_200,position:'-0.01'});
 const o=audit(p,[one,two]);
 assert.equal(o.classification,'REQUIRES_RECONCILIATION');
 assert.equal(o.legAudits[1].classification,'PRIOR_LEG_UNRESOLVED');
});
test('chronologically impossible reversal snapshots are rejected',()=>{
 const p=staged({flip:true});const one=proof(p.intents[0],{oid:10,tid:'100',snapshotAt:101_300,statusAt:100_900,position:'0'});
 const two=proof(p.intents[1],{oid:11,tid:'101',snapshotAt:101_100,statusAt:101_000,position:'-0.01'});
 assert.throws(()=>audit(p,[one,two]),/Out-of-order|precedes previous vault snapshot/);
});
test('missing reports, missing history and missing vault snapshots keep batch unresolved',()=>{
 const p=staged();for(const patch of [null,{statusResponse:proof(p.intents[0]).statusResponse},{...proof(p.intents[0]),vaultSnapshot:null}]){
  const o=audit(p,[patch]);assert.equal(o.classification,'REQUIRES_RECONCILIATION');
 }
});
test('full order with conflicting exchange fill IDs or overfilled volume fails closed',()=>{
 const p=staged();const bad=proof(p.intents[0]);bad.observedFills.push({...bad.observedFills[0],sz:'0.002'});
 assert.throws(()=>audit(p,[bad]),/Conflicting/);
 const tooLarge=proof(p.intents[0],{sz:'0.011'});
 assert.throws(()=>audit(p,[tooLarge]),/exceed/);
});
test('no-trade virtual event still requires a fresh vault confirmation and journal review',()=>{
 const base=staged();const p={...base,intents:[],requiresSequentialSettlement:false,desiredNetAfter:base.expectedNetBefore};
 p.batchId=validateStagedPortfolioPreview(p).batchId;
 const result=audit(p,[]);assert.equal(result.classification,'NO_ORDER_REQUIRED_REVIEW');assert.equal(result.commitAuthorized,false);
});

test('terminal order lacking a reliable exchange timestamp cannot corroborate settlement',()=>{
 const p=staged(),r=proof(p.intents[0]);delete r.statusResponse.order.statusTimestamp;
 assert.ok(audit(p,[r]).legAudits[0].reasons.includes('ORDER_STATUS_TIMESTAMP_MISSING'));
});
test('post-vault snapshot preceding any observed fill is not post-trade evidence',()=>{
 const p=staged(),r=proof(p.intents[0]);r.observedFills[0].time=101_100;
 assert.ok(audit(p,[r]).legAudits[0].reasons.includes('POST_ORDER_SNAPSHOT_PRECEDES_FILL'));
});
test('an old order-status timestamp cannot be reused after a later pre-leg position observation',()=>{
 const p=staged(),r=proof(p.intents[0],{statusAt:100_050,snapshotAt:101_000});
 const o=audit(p,[r]);
 assert.equal(o.classification,'REQUIRES_RECONCILIATION');
 assert.ok(o.legAudits[0].reasons.includes('ORDER_STATUS_PRECEDES_PREVIOUS_SNAPSHOT'));
 assert.equal(o.commitAuthorized,false);
});
test('reversal open status must follow the close-leg vault snapshot',()=>{
 const p=staged({flip:true});
 const close=proof(p.intents[0],{oid:10,tid:'100',snapshotAt:100_950,statusAt:100_900,position:'0'});
 const open=proof(p.intents[1],{oid:11,tid:'101',snapshotAt:101_300,statusAt:100_940,position:'-0.01'});
 open.observedFills[0].time=101_100;
 const o=audit(p,[close,open]);
 assert.equal(o.classification,'REQUIRES_RECONCILIATION');
 assert.ok(o.legAudits[1].reasons.includes('ORDER_STATUS_PRECEDES_PREVIOUS_SNAPSHOT'));
});
