/**
 * Deterministic offline stress replay ONLY. Simulated full settlement is
 * applied to an in-memory SHADOW ledger by this test harness, not v2's DB.
 * A passing result does NOT prove live fill completeness or strategy returns.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryJournal,ShadowLedger} from '../src/ledger.mjs';
import {ShadowPortfolioNetting} from '../src/portfolioNetting.mjs';

const VAULT='0x'+'f'.repeat(40);
const TRADERS=Array.from({length:5},(_,i)=>({
 address:'0x'+String(i+1).repeat(40),allocationUsd:'1000',
 maxVirtualLeverage:5,enabled:true
}));
const COINS=['BTC','ETH'];
function rng(seed){
 let state=seed>>>0;
 return ()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
}
function replay(seed=10141988,count=900){
 const next=rng(seed),journal=new MemoryJournal();
 const expectedSnapshots=[],counts={sourceEvents:0,generatedLegs:0,reversals:0,
  duplicatesIgnored:0,unchangedPollsWithoutOrders:0};
 for(let i=0;i<count;i++){
  const trader=TRADERS[next()%TRADERS.length].address;
  const coin=COINS[next()%COINS.length];
  const ledger=new ShadowLedger({traders:TRADERS,allowedCoins:COINS,journal});
  const before=ledger.snapshot();
  const key=trader.toLowerCase()+'|'+coin;
  const current=Number(before.sourcePositions[key]??'0');
  const options=[-1,0,1].filter(x=>x!==current);
  const target=options[next()%options.length];
  const delta=target-current;
  const time=100000+i*3000;
  const fill={trader,fillId:'HL:SHADOW'+i,coin,side:delta>0?'buy':'sell',
   size:String(Math.abs(delta)),priceUsd:coin==='BTC'?'50000':'3000',
   sourceStartPosition:String(current),timeMs:time};
  const sourceObservation={mode:'READ_ONLY',network:'mainnet',trader,
   accountValueUsd:'100000',observedAtStartMs:time+1,
   observedAtEndMs:time+10,positions:[{position:{coin,szi:String(target)}}]};
  const now=time+12;
  const makePlan=snapshot=>new ShadowPortfolioNetting({
   vaultAddress:VAULT,traders:TRADERS,allowedCoins:COINS,journal
  }).preview({fill,sourceObservation,
   vaultSnapshot:{mode:'READ_ONLY',network:'mainnet',vaultAddress:VAULT,
    positions:snapshot.net,asOfMs:time+11},
   unresolvedIntents:[],nowMs:now});
  const preview=makePlan(before);
  assert.equal(preview.mode,'SHADOW_ONLY');
  assert.equal(preview.commitAuthorized,false);
  assert.equal(preview.executeAuthorized,false);
  const didReverse=preview.intents.length===2;
  if(didReverse){
   counts.reversals++;
   assert.deepEqual(preview.intents.map(x=>x.phase),
    ['close-first','open-after-close']);
  }
  counts.generatedLegs+=preview.intents.length;
  // Simulate exchange completion only inside this test. No real DB or exchange.
  const accepted=ledger.applyFill({...fill,sourceEquityUsd:'100000'});
  assert.equal(accepted.status,'accepted');
  const after=ledger.snapshot();
  assert.deepEqual(after.net,preview.desiredNetAfter);
  assert.deepEqual(after.virtual,preview.projectedVirtual);
  assert.equal(journal.readAll().length,i+1);
  counts.sourceEvents++;
  // Repeated websocket notifications or polling the SAME source fill may not
  // create another order or journal entry after the synthetic completion.
  const repeated=makePlan(after);
  assert.equal(repeated.status,'DUPLICATE');
  assert.equal(repeated.virtualLedgerUnchanged,true);
  assert.deepEqual(repeated.intents,[]);
  counts.duplicatesIgnored++;
  // Time/mark/equity changes alone do not append a fill or produce an intent.
  const idle=new ShadowLedger({traders:TRADERS,allowedCoins:COINS,journal}).snapshot();
  assert.deepEqual(idle.net,after.net);
  counts.unchangedPollsWithoutOrders++;
  if(i%100===0)expectedSnapshots.push(after.net);
 }
 return {final:new ShadowLedger({traders:TRADERS,allowedCoins:COINS,journal}).snapshot(),
  counts,expectedSnapshots};
}
test('sustained 5-source 2-market source-only replay has no duplicate or idle rebalance orders',()=>{
 const a=replay();
 assert.equal(a.counts.sourceEvents,900);
 assert.equal(a.counts.duplicatesIgnored,900);
 assert.equal(a.counts.unchangedPollsWithoutOrders,900);
 assert.ok(a.counts.reversals>0);
 assert.ok(a.counts.generatedLegs>=900);
 assert.equal(a.final.journaledFills,900);
 assert.deepEqual(replay(),a,'replay must be reproducible for the same seed and fills');
});
