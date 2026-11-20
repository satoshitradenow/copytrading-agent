import test from 'node:test';
import assert from 'node:assert/strict';
import {assessShadowTradeEconomics} from '../src/economicThrottle.mjs';
import {validateIntentSpec} from '../src/intentLedger.mjs';
const VAULT='0x'+'9'.repeat(40),NOW=2000000000000;
const closeIntent=()=>validateIntentSpec({mode:'SHADOW_ONLY',vaultAddress:VAULT,fillKey:'source:'+('b'.repeat(64))+':close',coin:'BTC',side:'sell',size:'0.01',netBefore:'0.01',netAfter:'0'});
const intent=()=>validateIntentSpec({mode:'SHADOW_ONLY',vaultAddress:VAULT,fillKey:'source:'+('a'.repeat(64))+':net',
  coin:'BTC',side:'buy',size:'0.01',netBefore:'0',netAfter:'0.01'});
function quote(spec=intent(),updates={}){return {mode:'SHADOW_ONLY',signingAllowed:false,sendAllowed:false,
  network:'mainnet',vaultAddress:VAULT,intentId:spec.intentId,coin:spec.coin,orderSize:spec.size,
  requiresReduceOnly:false,limitPx:'50000',maxSlippageBps:25,assetIndex:0,
  wireOrderPreview:{a:0,c:spec.clientOrderId,b:spec.side==='buy',r:false,s:spec.size,p:'50000',t:{limit:{tif:'Ioc'}}},...updates};}
const policy={assumedTakerFeeBps:5,assumedSlippageBps:10,maxPerOrderEstimatedCostUsd:'2',
  maxDailyEstimatedCostUsd:'10',minEconomicNotionalUsd:'100',maxOrdersPerHour:5,maxOrdersPerDay:10,marketCooldownMs:60000};
const history=(orders=[],updates={})=>({mode:'DURABLE_ATTEMPT_LOG',network:'mainnet',vaultAddress:VAULT,
  coveredFromMs:NOW-86400001,asOfMs:NOW,orders,...updates});
const prior=(id,atMs,overrides={})=>({clientOrderId:'0x'+id.toString(16).padStart(32,'0'),atMs,
  coin:'BTC',status:'FILLED',estimatedMaxCostUsd:'0.5',...overrides});
const evaluate=(opts={})=>assessShadowTradeEconomics({intent:intent(),orderPreview:quote(),
  history:history(),policy,nowMs:NOW,...opts});

test('known fee/slippage assumptions yield conservative fixed-point one-way cost',()=>{
  const r=evaluate();
  assert.equal(r.estimatedOneWayNotionalUsd,'500');
  assert.equal(r.estimatedMaxOneWayCostUsd,'0.75');
  assert.equal(r.allowed,true);assert.equal(r.sendAllowed,false);
  assert.equal(r.ordersLastHour,0);assert.equal(r.estimatedSpentLast24hUsd,'0');
});

test('excess prior order attempts block a new source entry even if old orders were canceled',()=>{
  const orders=Array.from({length:5},(_,i)=>prior(i+1,NOW-5000-i*100,{status:'CANCELED',coin:'ETH'}));
  const r=evaluate({history:history(orders)});
  assert.equal(r.ordersLastHour,5);
  assert.ok(r.reasons.includes('HOURLY_ORDER_LIMIT'));
});

test('too-small copied trades are rejected by explicit economic floor',()=>{
  const r=evaluate({policy:{...policy,minEconomicNotionalUsd:'600'}});
  assert.equal(r.allowed,false);assert.ok(r.reasons.includes('BELOW_MIN_ECONOMIC_NOTIONAL'));
});

test('daily fee budget blocks excessive churn, including rejected attempts',()=>{
  const orders=[prior(1,NOW-6000000,{coin:'ETH',estimatedMaxCostUsd:'9.5',status:'REJECTED'})];
  const r=evaluate({history:history(orders)});
  assert.equal(r.estimatedSpentLast24hUsd,'9.5');
  assert.ok(r.reasons.includes('DAILY_ESTIMATED_COST_BUDGET'));
});

test('market cooldown blocks a repeat entry within the policy interval',()=>{
  const r=evaluate({history:history([prior(1,NOW-20000)])});
  assert.ok(r.reasons.includes('MARKET_COOLDOWN'));
  assert.equal(evaluate({history:history([prior(1,NOW-60000)])}).allowed,true);
});

test('cost ceiling blocks expensive orders and does not round cost downward',()=>{
  const r=evaluate({policy:{...policy,maxPerOrderEstimatedCostUsd:'0.749999'}});
  assert.ok(r.reasons.includes('MAX_ESTIMATED_ORDER_COST'));
  const biggerSpec=intent();
  const biggerQuote=quote(biggerSpec,{limitPx:'50000.1',wireOrderPreview:{...quote(biggerSpec).wireOrderPreview,p:'50000.1'}});
  const precise=evaluate({orderPreview:biggerQuote});
  assert.equal(precise.estimatedMaxOneWayCostUsd,'0.750002');
});

test('reduce-only exits bypass fee-budget and cooldown caps but remain unsigned',()=>{
  const spec=closeIntent(),orders=Array.from({length:12},(_,i)=>prior(i+1,NOW-3000-i*100,{estimatedMaxCostUsd:'5'}));
  const result=evaluate({intent:spec,history:history(orders),orderPreview:quote(spec,{
    requiresReduceOnly:true,wireOrderPreview:{...quote(spec).wireOrderPreview,b:false,r:true}})});
  assert.equal(result.allowed,true);assert.deepEqual(result.reasons,[]);
  assert.equal(result.reductionExemptFromEconomicLimits,true);assert.equal(result.signingAllowed,false);
});

test('unknown or partially settled old orders always halt, even for reduce-only',()=>{
  const spec=closeIntent();
  for(const status of ['UNKNOWN','PARTIAL','SUBMITTED']){
    assert.throws(()=>evaluate({intent:spec,history:history([prior(1,NOW-1000,{status})]),
      orderPreview:quote(spec,{requiresReduceOnly:true,wireOrderPreview:{...quote(spec).wireOrderPreview,b:false,r:true}})}),/uncertain order/);
  }
});

test('incomplete/stale/wrong-vault history cannot be interpreted as zero attempts',()=>{
  for(const override of [{mode:'SYNTHETIC'},{orders:null},{coveredFromMs:NOW-1000},
    {asOfMs:NOW-3000},{asOfMs:NOW+1000},{network:'testnet'},{vaultAddress:'0x'+'1'.repeat(40)}]){
    assert.throws(()=>evaluate({history:history([],override)}),/durable trading-cost history/);
  }
});

test('duplicate, future, malformed and negative-cost attempt records fail closed',()=>{
  for(const values of [
    [prior(1,NOW-1000),prior(1,NOW-2000)],
    [prior(2,NOW+1)],
    [prior(3,NOW-1000,{estimatedMaxCostUsd:'-1'})],
    [prior(4,NOW-1000,{status:'IMAGINARY'})]
  ])assert.throws(()=>evaluate({history:history(values)}));
});

test('an altered preview cannot inherit the approved order economic quota',()=>{
  const spec=intent();
  for(const changed of [
    {vaultAddress:'0x'+'1'.repeat(40)}, {intentId:'f'.repeat(64)},
    {orderSize:'0.02'},{coin:'ETH'}, {signingAllowed:true},{sendAllowed:true},
    {network:'other'}, {wireOrderPreview:{...quote(spec).wireOrderPreview,c:'0x'+'0'.repeat(32)}}
  ])assert.throws(()=>evaluate({orderPreview:quote(spec,changed)}));
});

test('declared slippage assumption cannot exceed the signed-off IOC preview cap',()=>{
  assert.throws(()=>evaluate({policy:{...policy,assumedSlippageBps:30}}),/Assumed slippage exceeds/);
  assert.throws(()=>evaluate({policy:{...policy,maxOrdersPerHour:0}}),/hourly order limit/);
});


test('a new entry cannot masquerade as a reduce-only exit to bypass fee limits',()=>{
 const spec=intent();
 assert.throws(()=>evaluate({orderPreview:quote(spec,{
   requiresReduceOnly:true,wireOrderPreview:{...quote(spec).wireOrderPreview,b:true,r:true}
 })}),/Reduce-only preview disagrees/);
});


test('cost guard refuses an unsigned preview whose IOC wire order details were mutated',()=>{
 const spec=intent(),raw=quote(spec).wireOrderPreview;
 for(const changed of [
   {s:'0.02'}, {p:'49000'}, {a:123}, {t:{limit:{tif:'Gtc'}}}
 ])assert.throws(()=>evaluate({orderPreview:quote(spec,{wireOrderPreview:{...raw,...changed}})}),/Unsigned order preview/);
});