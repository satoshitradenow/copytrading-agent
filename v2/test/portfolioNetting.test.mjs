import test from 'node:test';
import assert from 'node:assert/strict';
import {ShadowPortfolioNetting} from '../src/portfolioNetting.mjs';
import {ShadowLedger,MemoryJournal,sizeUnits,formatUnits} from '../src/ledger.mjs';

const A='0x1111111111111111111111111111111111111111';
const B='0x2222222222222222222222222222222222222222';
const VAULT='0x9999999999999999999999999999999999999999';
const traders=[A,B].map(address=>({address,allocationUsd:'1000',maxVirtualLeverage:5,enabled:true}));
const allowedCoins=['BTC','ETH'];
const abs=n=>n<0n?-n:n;
const cfg={vaultAddress:VAULT,network:'mainnet',traders,allowedCoins};
const baseFill={trader:A,fillId:'HL:1',coin:'BTC',side:'buy',size:'1',priceUsd:'50000',
  sourceStartPosition:'0',timeMs:10000};
const mkSnap=(positions={},asOfMs=10100,options={})=>({mode:'READ_ONLY',vaultAddress:VAULT,
  network:'mainnet',positions,asOfMs,...options});
function observation(fill,opts={}){
 const start=sizeUnits(fill.sourceStartPosition);
 const delta=sizeUnits(fill.size)*(fill.side==='buy'?1n:-1n);
 return {mode:'READ_ONLY',trader:fill.trader,network:'mainnet',
   observedAtStartMs:fill.timeMs,observedAtEndMs:fill.timeMs+20,
   accountValueUsd:'100000',positions:[{position:{coin:fill.coin,szi:formatUnits(start+delta)}}],...opts};
}
function harness(){
 const journal=new MemoryJournal();
 return {journal,planner:new ShadowPortfolioNetting({...cfg,journal}),commit:(fill)=>new ShadowLedger({traders,allowedCoins,journal}).applyFill({...fill,sourceEquityUsd:'100000'})};
}
const preview=(planner,fill=baseFill,vaultPositions={},extra={})=>planner.preview({
  fill,sourceObservation:observation(fill),vaultSnapshot:mkSnap(vaultPositions,fill.timeMs+40),
  unresolvedIntents:[],nowMs:fill.timeMs+50,...extra,
});

test('one source fill produces one unsigned intent and leaves the source journal untouched',()=>{
 const {planner,journal}=harness();
 const out=preview(planner);
 assert.equal(out.status,'PREVIEW_ONLY');assert.equal(out.mode,'SHADOW_ONLY');
 assert.equal(out.executeAuthorized,false);assert.equal(out.commitAuthorized,false);
 assert.equal(out.intents.length,1);assert.equal(out.intents[0].coin,'BTC');
 assert.equal(out.intents[0].side,'buy');assert.equal(out.intents[0].size,'0.01');
 assert.equal(out.intents[0].netBefore,'0');assert.equal(out.intents[0].netAfter,'0.01');
 assert.equal(out.sourceEquityQuality,'RECENT_SNAPSHOT_NOT_HISTORICAL_PROOF');
 assert.equal(journal.readAll().length,0);assert.ok(Object.isFrozen(out.intents));
 assert.equal(out.proposedSourceJournalRecord.fillKey,`${A}:HL:1`);
 assert.match(out.proposedSourceJournalRecord.fillDigest,/^[a-f0-9]{64}$/);
});

test('two opposing traders net against the single observed vault position',()=>{
 const {planner,commit}=harness();
 const a=preview(planner);commit(baseFill);
 const second={...baseFill,trader:B,fillId:'HL:2',side:'sell',timeMs:11000};
 const b=preview(planner,second,{BTC:'0.01'});
 assert.equal(b.intents.length,1);assert.equal(b.intents[0].side,'sell');
 assert.equal(b.intents[0].size,'0.01');assert.equal(b.intents[0].netAfter,'0');
 assert.equal(b.desiredNetAfter.BTC,'0');assert.equal(b.requiresSequentialSettlement,false);
 assert.equal(a.intents[0].side,'buy');
});

test('net portfolio reversal is explicitly separated into reduce-first then open-after-confirmation',()=>{
 const {planner,commit}=harness();preview(planner);commit(baseFill);
 const flip={...baseFill,fillId:'HL:flip',side:'sell',size:'2',sourceStartPosition:'1',timeMs:11000};
 const out=preview(planner,flip,{BTC:'0.01'});
 assert.equal(out.intents.length,2);assert.equal(out.requiresSequentialSettlement,true);
 const [close,open]=out.intents;
 assert.equal(close.phase,'close-first');assert.equal(close.side,'sell');
 assert.equal(close.size,'0.01');assert.equal(close.netAfter,'0');
 assert.equal(close.requiresPriorLegConfirmation,false);
 assert.equal(open.phase,'open-after-close');assert.equal(open.side,'sell');
 assert.equal(open.size,'0.01');assert.equal(open.netBefore,'0');
 assert.equal(open.netAfter,'-0.01');assert.equal(open.requiresPriorLegConfirmation,true);
 assert.notEqual(close.fillKey,open.fillKey);assert.notEqual(close.clientOrderId,open.clientOrderId);
 // The speculative preview did NOT modify the journal or produce trade requests.
 assert.equal(new ShadowLedger({traders,allowedCoins,journal:planner.journal}).snapshot().net.BTC,'0.01');
});

test('a source fill cannot be copied while a prior exchange order remains unresolved',()=>{
 const {planner}=harness();
 assert.throws(()=>preview(planner,baseFill,{}, {unresolvedIntents:[{status:'UNKNOWN'}]}),/Unresolved exchange order/);
 assert.throws(()=>preview(planner,baseFill,{}, {unresolvedIntents:undefined}),/unresolved-intent list/);
});

test('vault drift from a partially executed or manually adjusted position blocks the next trade',()=>{
 const {planner,commit}=harness();commit(baseFill);
 const fill={...baseFill,fillId:'HL:2',size:'0.5',sourceStartPosition:'1',timeMs:11000};
 assert.throws(()=>preview(planner,fill,{BTC:'0'}),/VAULT_POSITION_DRIFT:BTC/);
 assert.throws(()=>preview(planner,fill,{BTC:'0.005'}),/VAULT_POSITION_DRIFT:BTC/);
 assert.equal(new ShadowLedger({traders,allowedCoins,journal:planner.journal}).snapshot().net.BTC,'0.01');
});

test('a wholly untracked manual ETH position blocks new BTC source fills',()=>{
 const {planner}=harness();
 assert.throws(()=>preview(planner,baseFill,{ETH:'0.1'}),/VAULT_POSITION_DRIFT:ETH/);
 assert.equal(preview(planner,baseFill,{ETH:'0'}).intents.length,1);
});

test('source fill is rejected if it lacks a startPosition or mismatches current source position',()=>{
 const {planner}=harness();
 assert.throws(()=>planner.preview({fill:{...baseFill,sourceStartPosition:undefined},sourceObservation:observation(baseFill),vaultSnapshot:mkSnap({},10040),unresolvedIntents:[],nowMs:10050}),/startPosition required/);
 assert.throws(()=>preview(planner,baseFill,{}, {sourceObservation:observation(baseFill,{positions:[{position:{coin:'BTC',szi:'2'}}]})}),/post-fill position disagrees/);
});

test('source observation must be same trader/network, recent, post-fill and positive equity',()=>{
 const {planner}=harness();
 for(const change of [{trader:B},{network:'testnet'},{accountValueUsd:'0'},
   {observedAtEndMs:9999},{observedAtEndMs:12500},{observedAtStartMs:12000},
   {positions:null}]){
   assert.throws(()=>preview(planner,baseFill,{}, {sourceObservation:observation(baseFill,change)}));
 }
 assert.throws(()=>preview(planner,{...baseFill,sourceEquityUsd:'99999'}),/disagrees/);
});

test('vault snapshots cannot be mislabeled, stale, future, or cross-network',()=>{
 const {planner}=harness();
 for(const change of [{mode:'LIVE'},{vaultAddress:A},{network:'testnet'},
   {asOfMs:1},{asOfMs:12345},{positions:null}]){
   assert.throws(()=>preview(planner,baseFill,{}, {vaultSnapshot:mkSnap({},10040,change)}));
 }
});

test('duplicate source event cannot produce another proposed order',()=>{
 const {planner,commit}=harness();commit(baseFill);
 const out=preview(planner,baseFill,{BTC:'0.01'});
 assert.equal(out.status,'DUPLICATE');assert.deepEqual(out.intents,[]);
});

test('zero-size follower increments are retained in the virtual ledger without inventing a minimum-size order',()=>{
 const journal=new MemoryJournal();
 const tiny=new ShadowPortfolioNetting({...cfg,journal,
   traders:traders.map(t=>({...t,allocationUsd:'0.000001'}))});
 const out=preview(tiny);
 assert.equal(out.intents.length,0);assert.equal(out.desiredNetAfter.BTC,'0');
 assert.equal(journal.readAll().length,0);
});

test('subsequent full close is proportional to virtual exposure when source equity changes',()=>{
 const {planner,commit}=harness();commit(baseFill);
 const close={...baseFill,fillId:'HL:3',side:'sell',size:'1',sourceStartPosition:'1',timeMs:11000};
 const result=preview(planner,close,{BTC:'0.01'}, {sourceObservation:observation(close,{accountValueUsd:'150000'})});
 assert.equal(result.intents.length,1);assert.equal(result.intents[0].size,'0.01');assert.equal(result.intents[0].netAfter,'0');
});

test('different markets and source traders share one vault but never confuse coin-level net books',()=>{
 const {planner,commit}=harness();commit(baseFill);
 const eth={...baseFill,trader:B,fillId:'HL:ETH',coin:'ETH',size:'2',priceUsd:'2000',timeMs:11000};
 const result=preview(planner,eth,{BTC:'0.01'});
 assert.equal(result.intents.length,1);assert.equal(result.intents[0].coin,'ETH');
 assert.equal(result.intents[0].size,'0.02');assert.equal(result.desiredNetAfter.BTC,'0.01');
});

test('repeat calls are deterministic and do not mutate the journal, pending orders, or vault snapshot',()=>{
 const {planner,journal}=harness();const vaultSnap=mkSnap({},10040);
 const a=preview(planner,baseFill,{}, {vaultSnapshot:vaultSnap});
 const b=preview(planner,baseFill,{}, {vaultSnapshot:vaultSnap});
 assert.deepEqual(a,b);assert.equal(journal.readAll().length,0);assert.deepEqual(vaultSnap,mkSnap({},10040));
});

test('sustained event-only portfolio netting conserves aggregate deltas over 150 deterministic events',()=>{
 const {planner,commit}=harness();let positions={BTC:'0',ETH:'0'};
 const source=new Map();const markets=['BTC','ETH'];let eventId=0,legCount=0;
 for(let i=0;i<150;i++){
   const trader=i%2?A:B,coin=markets[(i+Math.floor(i/3))%2],k=trader+':'+coin;
   const sourceStart=source.get(k)??0n;
   const sign=(i%7===0?-1n:1n);
   const delta=sign*(i%3===0?2n:1n)*100000000n;
   const fill={trader,coin,fillId:'HL:'+String(++eventId),side:delta>0n?'buy':'sell',size:formatUnits(abs(delta)),
     sourceStartPosition:formatUnits(sourceStart),priceUsd:coin==='BTC'?'1000':'1000',timeMs:10000+i*1000};
   const prevExpected=sizeUnits(positions[coin]);
   const out=preview(planner,fill,positions);
   let combined=0n,intermediate=prevExpected;
   for(const leg of out.intents){
     assert.equal(sizeUnits(leg.netBefore),intermediate);
     const d=(leg.side==='buy'?1n:-1n)*sizeUnits(leg.size);
     combined+=d;intermediate=sizeUnits(leg.netAfter);legCount++;
   }
   assert.equal(combined,sizeUnits(out.desiredNetAfter[coin]??'0')-prevExpected);
   commit(fill);
   source.set(k,sourceStart+delta);
   positions={...positions,[coin]:out.desiredNetAfter[coin]??'0'};
 }
 assert.ok(legCount>=100,`legs=${legCount}`);assert.equal(planner.journal.readAll().length,150);
});

test('all five independent strategy positions aggregate into one net BTC position',()=>{
  const accounts='12345'.split('').map(c=>'0x'+c.repeat(40));
  const strategies=accounts.map(address=>({address,allocationUsd:'1000',maxVirtualLeverage:5,enabled:true}));
  const journal=new MemoryJournal();
  const planner=new ShadowPortfolioNetting({...cfg,traders:strategies,journal});
  let actual='0';
  for(let i=0;i<accounts.length;i++){
    const side=i<2?'buy':'sell';
    const fill={...baseFill,trader:accounts[i],fillId:'HL:'+String(100+i),side,
      sourceStartPosition:'0',timeMs:20000+i*1000};
    const plan=preview(planner,fill,{BTC:actual});
    assert.equal(plan.intents.length,1);
    new ShadowLedger({traders:strategies,allowedCoins,journal})
      .applyFill({...fill,sourceEquityUsd:'100000'});
    actual=plan.desiredNetAfter.BTC;
  }
  assert.equal(actual,'-0.01');
  assert.equal(journal.readAll().length,5);
  const ledger=new ShadowLedger({traders:strategies,allowedCoins,journal});
  assert.equal(Object.keys(ledger.snapshot().virtual).length,5);
});

test('replaying an ID with altered source economics is refused before it could generate any new intent',()=>{
  const {planner,commit}=harness();commit(baseFill);
  assert.throws(()=>preview(planner,{...baseFill,size:'2'}, {BTC:'0.01'},
    {sourceObservation:observation({...baseFill,size:'2'})}),/Conflicting source fill ID/);
});