import test from 'node:test';
import assert from 'node:assert/strict';
import {ShadowPortfolioNetting} from '../src/portfolioNetting.mjs';
import {ShadowLedger,MemoryJournal} from '../src/ledger.mjs';
import {validateStagedPortfolioPreview} from '../src/pgPortfolioBatchRepository.mjs';
import {reviewObservedPerpFillPath,auditPortfolioFillEconomics} from '../src/portfolioFillEconomics.mjs';

const VAULT='0x'+'9'.repeat(40),TRADER='0x'+'1'.repeat(40);
const traders=[{address:TRADER,allocationUsd:'1000',maxVirtualLeverage:5,enabled:true}];
const FILL={trader:TRADER,fillId:'HL:45',coin:'BTC',side:'buy',size:'1',priceUsd:'50000',
 sourceStartPosition:'0',timeMs:100000};
const snap=(positions,asOfMs=100100)=>({
 mode:'READ_ONLY',network:'mainnet',vaultAddress:VAULT,positions,asOfMs
});
function staged({flip=false}={}){
 const journal=new MemoryJournal();
 if(flip)new ShadowLedger({traders,allowedCoins:['BTC'],journal})
  .applyFill({...FILL,sourceEquityUsd:'100000'});
 const f=flip?{...FILL,fillId:'HL:46',side:'sell',size:'2',sourceStartPosition:'1'}:FILL;
 const preview=new ShadowPortfolioNetting({vaultAddress:VAULT,traders,allowedCoins:['BTC'],journal})
  .preview({fill:f,nowMs:100090,unresolvedIntents:[],
   sourceObservation:{mode:'READ_ONLY',network:'mainnet',trader:TRADER,
    accountValueUsd:'100000',observedAtStartMs:100010,observedAtEndMs:100020,
    positions:[{position:{coin:'BTC',szi:flip?'-1':'1'}}]},
   vaultSnapshot:snap(flip?{BTC:'0.01'}:{BTC:'0'},100040)
  });
 return {...preview,batchId:validateStagedPortfolioPreview(preview).batchId};
}
function fill(leg,{oid=321,tid=21,sz=leg.size,startPosition=leg.netBefore,
 time=100800,fee='0.25',closedPnl='0',...more}={}){
 return {oid,tid,coin:leg.coin,side:leg.side==='buy'?'B':'A',
  sz,px:'50000',fee,feeToken:'USDC',closedPnl,startPosition,time,
  crossed:true,...more};
}
function proof(leg,{oid=321,status='filled',time=100800,statusAt=100900,
 snapshotAt=101000,position=leg.netAfter,fillRows=null}={}){
 return {statusResponse:{status:'order',order:{status,statusTimestamp:statusAt,
  order:{oid,cloid:leg.clientOrderId,coin:leg.coin,
   side:leg.side==='buy'?'B':'A',origSz:leg.size,
   reduceOnly:leg.netBefore!=='0'&&leg.netAfter==='0'}}},
  observedFills:fillRows??[fill(leg,{oid,time})],
  vaultSnapshot:snap({BTC:position},snapshotAt)};
}
const audit=(preview,legReports,opts={})=>auditPortfolioFillEconomics({
 preview,initialVaultSnapshot:snap(preview.expectedNetBefore),
 legReports,nowMs:102000,...opts
});

test('a complete single-leg fill has corroborated economics, never settlement authority',()=>{
 const p=staged(),r=audit(p,[proof(p.intents[0])]);
 assert.equal(r.classification,'ECONOMIC_PATH_CORROBORATED_BUT_NOT_SETTLED');
 const leg=r.economicLegAudits[0];
 assert.equal(leg.classification,'ECONOMIC_PATH_CORROBORATED_REVIEW_ONLY');
 assert.equal(leg.path.observedPositionBefore,'0');
 assert.equal(leg.path.reconstructedPositionAfter,'0.01');
 assert.equal(leg.path.economics.observedGrossNotionalUsd,'500');
 assert.equal(leg.path.economics.observedFeeUsd,'0.25');
 assert.equal(leg.path.economics.feeIncludesBuilderFee,true);
 assert.equal(r.settlementAudit.commitAuthorized,false);
 assert.equal(r.commitAuthorized,false);assert.equal(r.executeAuthorized,false);
 assert.equal(r.safeToResubmit,false);assert.equal(r.historyComplete,false);
});
test('two same-millisecond partial fills are sequenced by exchange pre-fill position, not tid',()=>{
 const p=staged(),leg=p.intents[0];
 const rows=[
  fill(leg,{tid:24,sz:'0.005',startPosition:'0.005',time:100800,fee:'0.2'}),
  fill(leg,{tid:22,sz:'0.005',startPosition:'0',time:100800,fee:'0.2'})
 ];
 const r=audit(p,[proof(leg,{fillRows:rows})]);
 assert.equal(r.classification,'ECONOMIC_PATH_CORROBORATED_BUT_NOT_SETTLED');
 const path=r.economicLegAudits[0].path;
 assert.deepEqual(path.fills.map(x=>x.tradeId),['22','24']);
 assert.equal(path.economics.observedFeeUsd,'0.4');
 assert.equal(path.reconstructedPositionAfter,'0.01');
});
test('same-time ambiguous fills with identical pre-position fail closed rather than invent order',()=>{
 const p=staged(),leg=p.intents[0];
 const rows=[fill(leg,{tid:22,sz:'0.005',startPosition:'0',time:100800}),
   fill(leg,{tid:23,sz:'0.005',startPosition:'0',time:100800})];
 assert.throws(()=>audit(p,[proof(leg,{fillRows:rows})]),/Ambiguous same-timestamp|discontinuity/);
});
test('a canceled partial fill can corroborate the observed partial path but not intended full exposure',()=>{
 const p=staged(),leg=p.intents[0];
 const r=audit(p,[proof(leg,{status:'canceled',position:'0.005',
  fillRows:[fill(leg,{sz:'0.005'})]})]);
 assert.equal(r.classification,'REQUIRES_RECONCILIATION');
 assert.equal(r.economicLegAudits[0].classification,'REQUIRES_RECONCILIATION');
 assert.equal(r.economicLegAudits[0].path.pathMatchesObservedPosition,true);
 assert.equal(r.economicLegAudits[0].path.economics.remainingUnverifiedSize,'0.005');
 assert.equal(r.commitAuthorized,false);
});
test('observed vault snapshot disagrees with exact fill-derived path: no corroboration',()=>{
 const p=staged(),leg=p.intents[0];
 const r=audit(p,[proof(leg,{position:'0.009'})]);
 assert.equal(r.classification,'REQUIRES_RECONCILIATION');
 assert.equal(r.economicLegAudits[0].path.classification,'POSITION_DRIFT_REQUIRES_RECONCILIATION');
});
test('missing pre-fill positions and economically incomplete public fills fail closed',()=>{
 const p=staged(),leg=p.intents[0];
 const withoutStart=fill(leg);delete withoutStart.startPosition;
 assert.throws(()=>audit(p,[proof(leg,{fillRows:[withoutStart]})]),/Missing explicit/);
 const withoutFee=fill(leg);delete withoutFee.fee;
 assert.throws(()=>audit(p,[proof(leg,{fillRows:[withoutFee]})]),/fee/);
});
test('conflicting same tid economics cannot be counted twice even if cumulative size appears correct',()=>{
 const p=staged(),leg=p.intents[0];
 const a=fill(leg,{tid:15,sz:'0.01'});
 const b=fill(leg,{tid:15,sz:'0.01',fee:'99'});
 assert.throws(()=>audit(p,[proof(leg,{fillRows:[a,b]})]),/Conflicting/);
});
test('identical repeated tid observations do not create a second position move',()=>{
 const p=staged(),leg=p.intents[0],a=fill(leg,{tid:15,sz:'0.01'});
 const b={...a,oid:'321',tid:'15'};
 const r=audit(p,[proof(leg,{fillRows:[a,b]})]);
 assert.equal(r.economicLegAudits[0].path.fills.length,1);
 assert.equal(r.economicLegAudits[0].path.economics.fillCount,1);
});
test('two-leg reversal must reconstruct close to zero before open from zero',()=>{
 const p=staged({flip:true}),[close,open]=p.intents;
 const first=proof(close,{oid:10,fillRows:[
  fill(close,{oid:10,tid:100,startPosition:'0.01',time:100800})],
  snapshotAt:100950,statusAt:100900,position:'0'});
 const second=proof(open,{oid:11,fillRows:[
  fill(open,{oid:11,tid:101,startPosition:'0',time:101100})],
  snapshotAt:101300,statusAt:101200,position:'-0.01'});
 const r=audit(p,[first,second]);
 assert.equal(r.classification,'ECONOMIC_PATH_CORROBORATED_BUT_NOT_SETTLED');
 assert.deepEqual(r.economicLegAudits.map(x=>x.classification),
  ['ECONOMIC_PATH_CORROBORATED_REVIEW_ONLY','ECONOMIC_PATH_CORROBORATED_REVIEW_ONLY']);
 assert.equal(r.economicLegAudits[1].path.observedPositionBefore,'0');
 assert.equal(r.economicLegAudits[1].path.reconstructedPositionAfter,'-0.01');
});
test('a canceled or uncertain reversal close blocks opening leg even with apparently matching data',()=>{
 const p=staged({flip:true}),[close,open]=p.intents;
 const first=proof(close,{oid:10,status:'canceled',position:'0.005',
  fillRows:[fill(close,{oid:10,sz:'0.005',tid:100,startPosition:'0.01'})],
  snapshotAt:100950,statusAt:100900});
 const second=proof(open,{oid:11,position:'-0.01',
  fillRows:[fill(open,{oid:11,tid:101,startPosition:'0',time:101100})],
  snapshotAt:101300,statusAt:101200});
 const r=audit(p,[first,second]);
 assert.equal(r.classification,'REQUIRES_RECONCILIATION');
 assert.equal(r.economicLegAudits[1].classification,'PRIOR_LEG_UNRESOLVED');
});
test('reduce-only paths that increase or reverse positions are rejected',()=>{
 assert.throws(()=>reviewObservedPerpFillPath({
  intent:{coin:'BTC',side:'sell',size:'0.02',requiresReduceOnly:true},
  exchangeOrderId:'321',positionBefore:'0.01',positionAfter:'-0.01',
  windowStartMs:100,windowEndMs:200,
  observedFills:[{oid:321,tid:1,coin:'BTC',side:'A',sz:'0.02',
   px:'50000',fee:'0.1',closedPnl:'0',startPosition:'0.01',
   feeToken:'USDC',time:150}]
 }),/Reduce-only/);
});
test('out-of-window and discontinuous fill paths are not valid evidence',()=>{
 const p=staged(),leg=p.intents[0];
 assert.throws(()=>reviewObservedPerpFillPath({
  intent:leg,exchangeOrderId:'321',observedFills:[
   fill(leg,{time:99})],positionBefore:'0',positionAfter:'0.01',
  windowStartMs:100,windowEndMs:200
 }),/outside observed position window/);
 const unrelatedStart=fill(leg,{startPosition:'0.005'});
 assert.throws(()=>audit(p,[proof(leg,{fillRows:[unrelatedStart]})]),/discontinuity/);
});
test('no-trade batch still requires separate review and never authorizes virtual promotion',()=>{
 const p=staged(),none={...p,intents:[],requiresSequentialSettlement:false,
  desiredNetAfter:p.expectedNetBefore};
 none.batchId=validateStagedPortfolioPreview(none).batchId;
 const r=audit(none,[]);
 assert.equal(r.classification,'NO_ORDER_REQUIRED_REVIEW');
 assert.equal(r.commitAuthorized,false);
 assert.deepEqual(r.economicLegAudits,[]);
});
