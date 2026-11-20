import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizePerpFillEconomics} from '../src/fillAccounting.mjs';

const intent={coin:'BTC',side:'buy',size:'0.02'};
const fill=(tid,sz,more={})=>({oid:321,tid,coin:'BTC',side:'B',sz,
  px:'50000',fee:'0.25',feeToken:'USDC',closedPnl:'-2',
  time:1000,startPosition:'0',crossed:true,...more});
const run=(fills,opts={})=>summarizePerpFillEconomics({
 intent,exchangeOrderId:'321',observedFills:fills,...opts});

test('two partial fills sum 14-decimal notional, signed PnL and USDC fees exactly',()=>{
 const first=fill(10,'0.005',{builderFee:'0.1'});
 const second=fill(11,'0.01',{px:'51000',fee:'0.51',closedPnl:'4.5',time:1100,startPosition:'0.005'});
 const r=run([first,second]);
 assert.equal(r.fillCount,2);
 assert.equal(r.observedFilledSize,'0.015');
 assert.equal(r.remainingUnverifiedSize,'0.005');
 assert.equal(r.observedGrossNotionalUsd,'760');
 assert.equal(r.observedFeeUsd,'0.76');
 assert.equal(r.observedClosedPnlUsd,'2.5');
 assert.equal(r.observedBuilderFeeUsdSeparate,'0.1');
 assert.equal(r.builderFeeIncludedInFeeTotal,'YES_PER_HYPERLIQUID_API_DOCS');
 assert.equal(r.feeIncludesBuilderFee,true);
 assert.equal(r.observedClosedPnlNetOfFillFeesUsd,'1.74');
 assert.equal(r.historyComplete,false);
 assert.equal(r.commitAuthorized,false);
 assert.equal(r.executeAuthorized,false);
 assert.equal(r.safeToResubmit,false);
});
test('micro sizes and prices never lose precision through JS floating point',()=>{
 const r=run([fill('12','0.00000001',{px:'0.000001',fee:'0.000001',closedPnl:'-0.000001'})]);
 assert.equal(r.observedGrossNotionalUsd,'0.00000000000001');
 assert.equal(r.observedFeeUsd,'0.000001');
 assert.equal(r.observedFilledSize,'0.00000001');
});
test('replayed tid with identical economics is counted once, even when IDs are number versus string',()=>{
 const a=fill(10,'0.005'),b=fill('10','0.005',{oid:'321'});
 const r=run([a,b]);
 assert.equal(r.fillCount,1);
 assert.equal(r.observedFilledSize,'0.005');
});
test('any changed fill price, fee, PnL, time, builder fee or pre-position under one tid fails closed',()=>{
 const base=fill(10,'0.005');
 for(const change of [
  {px:'51000'},{fee:'0.26'},{closedPnl:'-1'},{time:1001},
  {builderFee:'0.1'},{startPosition:'0.005'},{sz:'0.006'},
  {crossed:false}
 ]){
  assert.throws(()=>run([base,fill('10','0.005',change)]),/Conflicting economic fields/);
 }
});
test('negative maker rebates and realized losses are preserved as signed exact values',()=>{
 const r=run([fill(10,'0.01',{fee:'-0.3',closedPnl:'-10.25'})]);
 assert.equal(r.observedFeeUsd,'-0.3');
 assert.equal(r.observedClosedPnlUsd,'-10.25');
});
test('overfills and malformed exact decimals are never silently rounded',()=>{
 assert.throws(()=>run([fill(1,'0.021')]),/exceed intended/);
 for(const bad of [{sz:'0.000000001'},{px:'0.0000001'},
  {fee:'0.0000001'},{closedPnl:'1e2'},{fee:0.1}]){
  assert.throws(()=>run([fill(1,'0.005',bad)]));
 }
});
test('foreign fee token and incomplete economic fields cannot be summed as USDC costs',()=>{
 for(const bad of [
  {feeToken:'HYPE'},{feeToken:undefined},{fee:undefined},
  {closedPnl:undefined},{px:undefined},{time:undefined}
 ])assert.throws(()=>run([fill(1,'0.005',bad)]));
 assert.throws(()=>run([fill(1,'0.005')],{feeToken:'HYPE'}),/USDC/);
});
test('unrelated exchange orders are excluded; unsafe order or trade IDs are rejected',()=>{
 const r=run([fill(1,'0.005'),fill(2,'100',{oid:555})]);
 assert.equal(r.observedFilledSize,'0.005');
 assert.throws(()=>run([fill(Number.MAX_SAFE_INTEGER+3,'0.005')]),/Unsafe/);
 assert.throws(()=>run([fill(1,'0.005',{oid:Number.MAX_SAFE_INTEGER+3})]),/Unsafe/);
});
test('wrong market, side, malformed optional fields and broken history container fail closed',()=>{
 for(const bad of [
  {coin:'ETH'},{side:'A'},{crossed:'true'},{dir:7},
  {hash:'bad'},{startPosition:'bad'}
 ])assert.throws(()=>run([fill(1,'0.005',bad)]));
 assert.throws(()=>run(null),/history array/);
 assert.throws(()=>run([], {intent:{coin:'',side:'buy',size:'1'}}),/intent/);
});
test('no observed fills means no proof of execution or safe retransmission',()=>{
 const r=run([]);
 assert.equal(r.observedFilledSize,'0');
 assert.equal(r.remainingUnverifiedSize,'0.02');
 assert.equal(r.historyComplete,false);
 assert.equal(r.requiresOperatorReview,true);
});

test('Hyperliquid inclusive builderFee is not added again to observed total fees',()=>{
 const r=run([fill('42','0.01',{fee:'0.5',builderFee:'0.2',closedPnl:'2'})]);
 assert.equal(r.observedFeeUsd,'0.5');
 assert.equal(r.observedBuilderFeeUsdSeparate,'0.2');
 assert.equal(r.observedClosedPnlNetOfFillFeesUsd,'1.5');
 assert.equal(r.feeIncludesBuilderFee,true);
});
test('exchange order IDs beyond u64 are rejected without rounding',()=>{
 assert.throws(()=>run([fill('18446744073709551616','0.005')]),/Unsafe/);
 assert.throws(()=>run([fill(1,'0.005')],{exchangeOrderId:'18446744073709551616'}),/Unsafe/);
});
