import test from 'node:test';
import assert from 'node:assert/strict';
import {assessOrderStatusEvidence,inspectVaultOrderEvidence,summarizeObservedOrderFills} from '../src/orderEvidence.mjs';
import {readVaultOrderStatus} from '../src/hyperliquidRead.mjs';

const VAULT='0x1111111111111111111111111111111111111111';
const CLOID='0xabcdef1234567890abcdef1234567890';
const intent=(p={})=>({vaultAddress:VAULT,clientOrderId:CLOID,coin:'BTC',side:'buy',size:'0.02',requiresReduceOnly:false,...p});
function status(status='open',changes={}){
 return {status:'order',order:{status,statusTimestamp:1800000000000,
   order:{cloid:CLOID,coin:'BTC',side:'B',origSz:'0.02000000',reduceOnly:false,oid:112233, ...changes}}};
}
const fill=(tid,sz,props={})=>({oid:112233,coin:'BTC',side:'B',tid,sz,...props});

test('orderStatus read-only request queries the vault account, never agent signer',async()=>{
 const calls=[];
 const result=await readVaultOrderStatus(VAULT,CLOID.toUpperCase().replace('0X','0x'),{
   fetchImpl:async(url,options)=>{calls.push({url,payload:JSON.parse(options.body)});return{ok:true,json:async()=>({status:'unknownOid'})};}
 });
 assert.equal(result.status,'unknownOid');
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.hyperliquid.xyz/info');
 assert.deepEqual(calls[0].payload,{type:'orderStatus',user:VAULT,oid:CLOID});
});
test('read-only order lookup rejects malformed client IDs before network calls',async()=>{
 let calls=0;
 await assert.rejects(readVaultOrderStatus(VAULT,'secret-key',{fetchImpl:async()=>{calls++;}}),/16-byte/);
 assert.equal(calls,0);
});
test('unknownOid never means order was not executed or is safe to retry',()=>{
 const result=assessOrderStatusEvidence(intent(),{status:'unknownOid'});
 assert.equal(result.classification,'UNKNOWN_OID_NOT_PROOF_OF_NONEXECUTION');
 assert.equal(result.safeToResubmit,false);assert.equal(result.requiresOperatorReview,true);
});
test('open IOC order is not declared fully settled',()=>{
 const result=assessOrderStatusEvidence(intent(),status('open'));
 assert.equal(result.classification,'ORDER_STILL_ACTIVE_OR_TRIGGERED');
 assert.equal(result.exchangeOrderId,'112233');assert.equal(result.safeToResubmit,false);
});
test('filled, canceled and rejected statuses require separate fill audit',()=>{
 for(const name of ['filled','canceled','rejected','marginCanceled','reduceOnlyCanceled','scheduledCancel']){
   const r=assessOrderStatusEvidence(intent(),status(name));
   assert.equal(r.classification,'REPORTED_TERMINAL_NEEDS_FILL_AUDIT');
   assert.equal(r.safeToResubmit,false);
 }
});
test('order evidence rejects mismatched cloid, market, side, size and reduce-only',()=>{
 for(const mismatch of [
   {cloid:'0x00000000000000000000000000000001'}, {coin:'ETH'}, {side:'A'},
   {origSz:'0.021'}, {reduceOnly:true}, {cloid:null}
 ])assert.throws(()=>assessOrderStatusEvidence(intent(),status('open',mismatch)),/does not match/);
});
test('unknown or malformed status fails closed',()=>{
 assert.throws(()=>assessOrderStatusEvidence(intent(),status('newExchangeStatus')),/Unrecognized/);
 assert.throws(()=>assessOrderStatusEvidence(intent(),{}),/Malformed/);
 assert.throws(()=>assessOrderStatusEvidence(intent(),{status:'order'}),/Malformed/);
});
test('order identifiers larger than JS safe integer are rejected rather than rounded',()=>{
 assert.throws(()=>assessOrderStatusEvidence(intent(),status('filled',{oid:Number.MAX_SAFE_INTEGER+10})),/Unsafe/);
 const r=assessOrderStatusEvidence(intent(),status('filled',{oid:'18446744073709551615'}));
 assert.equal(r.exchangeOrderId,'18446744073709551615');
});
test('order fill history deduplicates tids and refuses to pronounce complete',()=>{
 const r=summarizeObservedOrderFills({intent:intent(),exchangeOrderId:'112233',fills:[fill(101,'0.005'),fill(101,'0.005'),fill(102,'0.01'),fill(999,'0.03',{oid:555})]});
 assert.equal(r.observedFilledSize,'0.015');assert.equal(r.remainingUnverifiedSize,'0.005');
 assert.equal(r.historyComplete,false);assert.equal(r.safeToResubmit,false);
});
test('overfill, duplicate conflict and unsafe fill IDs must block reconciliation',()=>{
 assert.throws(()=>summarizeObservedOrderFills({intent:intent(),exchangeOrderId:'112233',fills:[fill(101,'0.03')]}),/exceed/);
 assert.throws(()=>summarizeObservedOrderFills({intent:intent(),exchangeOrderId:'112233',fills:[fill(101,'0.01'),fill(101,'0.02')]}),/Conflicting/);
 assert.throws(()=>summarizeObservedOrderFills({intent:intent(),exchangeOrderId:'112233',fills:[fill(Number.MAX_SAFE_INTEGER+2,'0.01')]}),/unsafe|Conflicting/i);
 assert.throws(()=>summarizeObservedOrderFills({intent:intent(),exchangeOrderId:'112233',fills:[fill(1,'0.01',{oid:Number.MAX_SAFE_INTEGER+2})]}),/Unsafe/);
});
test('vault query error propagates without any retry or exchange submission',async()=>{
 await assert.rejects(inspectVaultOrderEvidence(intent(),{fetchImpl:async()=>{throw Error('offline');}}),/offline/);
});
test('read-only inspection returns validated evidence from mocked official info API',async()=>{
 const r=await inspectVaultOrderEvidence(intent(),{fetchImpl:async()=>({ok:true,json:async()=>status('filled')})});
 assert.equal(r.exchangeStatus,'filled');assert.equal(r.safeToResubmit,false);
});
test('baseline order evidence refuses same-tid replay with changed execution economics',()=>{
 const a=fill(101,'0.005',{px:'50000',fee:'0.25',time:1000,startPosition:'0'});
 for(const change of [{px:'50100'},{fee:'0.26'},{time:1001},
  {startPosition:'0.005'},{closedPnl:'5'},{feeToken:'HYPE'}]){
  const b={...a,...change,oid:'112233',tid:'101'};
  assert.throws(()=>summarizeObservedOrderFills({
   intent:intent(),exchangeOrderId:'112233',fills:[a,b]
  }),/Conflicting exchange fill ID economic replay/);
 }
});
test('u64 exchange order/trade ID bounds reject out-of-range strings',()=>{
 assert.throws(()=>assessOrderStatusEvidence(intent(),status('filled',{
  oid:'18446744073709551616'
 })),/Unsafe/);
 assert.throws(()=>summarizeObservedOrderFills({intent:intent(),
  exchangeOrderId:'112233',fills:[fill('18446744073709551616','0.005')]}),/Unsafe/);
});
