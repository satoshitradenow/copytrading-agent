import test from 'node:test';
import assert from 'node:assert/strict';
import {readMainPerpMetadata,readVaultAssetLeverage} from '../src/hyperliquidRead.mjs';
const VAULT='0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const META={universe:[{name:'BTC',szDecimals:5,maxLeverage:40},{name:'ETH',szDecimals:4,maxLeverage:25}]};
const response=(payload)=>async(url,opts)=>{
 assert.equal(url,'https://api.hyperliquid.xyz/info');
 assert.equal(opts.method,'POST');
 return {ok:true,json:async()=>payload(JSON.parse(opts.body))};
};
test('metadata fetch uses only /info meta and returns observed timestamp',async()=>{
 let seen=false;
 const r=await readMainPerpMetadata({fetchImpl:response(q=>{assert.deepEqual(q,{type:'meta'});seen=true;return META;})});
 assert(seen);assert.equal(r.meta.universe.length,2);assert.equal(r.mode,'READ_ONLY');assert(Number.isSafeInteger(r.observedAtMs));
});
test('duplicate and invalid metadata listings stop order planning',async()=>{
 await assert.rejects(readMainPerpMetadata({fetchImpl:response(()=>({universe:[META.universe[0],META.universe[0]]}))}),/metadata/);
 await assert.rejects(readMainPerpMetadata({fetchImpl:response(()=>({universe:[{name:'BTC',szDecimals:9,maxLeverage:50}]}))}),/metadata/);
});
test('activeAssetData asks about destination vault and exact market',async()=>{
 const obs=await readVaultAssetLeverage(VAULT,'ETH',{fetchImpl:response(q=>{
   assert.deepEqual(q,{type:'activeAssetData',user:VAULT,coin:'ETH'});
   return {user:VAULT,coin:'ETH',leverage:{type:'cross',value:3}};
 })});
 assert.equal(obs.value,3);assert.equal(obs.mode,'cross');assert.equal(obs.source,'activeAssetData');
 assert.equal(obs.signingAuthorityVerified,false);assert.equal(obs.vaultAddress,VAULT);
});
test('activeAssetData identifies an isolated margin change rather than hiding it',async()=>{
 const r=await readVaultAssetLeverage(VAULT,'BTC',{fetchImpl:response(()=>({leverage:{type:'isolated',value:2,rawUsd:'100'}}))});
 assert.equal(r.mode,'isolated');
});
test('activeAssetData will not trust another vault or another market response',async()=>{
 await assert.rejects(readVaultAssetLeverage(VAULT,'BTC',{fetchImpl:response(()=>({user:'0x'+'1'.repeat(40),coin:'BTC',leverage:{type:'cross',value:2}}))}),/mismatched/);
 await assert.rejects(readVaultAssetLeverage(VAULT,'BTC',{fetchImpl:response(()=>({user:VAULT,coin:'ETH',leverage:{type:'cross',value:2}}))}),/mismatched/);
});
test('activeAssetData fails when leverage is missing, invalid or market input unsafe',async()=>{
 await assert.rejects(readVaultAssetLeverage(VAULT,'BTC',{fetchImpl:response(()=>({leverage:{type:'cross',value:0}}))}),/Malformed/);
 await assert.rejects(readVaultAssetLeverage(VAULT,'BTC',{fetchImpl:response(()=>({}))}),/Malformed/);
 await assert.rejects(readVaultAssetLeverage(VAULT,'@1',{fetchImpl:async()=>{throw Error('should not fetch')}}),/Invalid validator/);
});