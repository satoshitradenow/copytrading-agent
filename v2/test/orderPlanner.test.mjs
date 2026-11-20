import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareShadowIocOrder,boundedPerpPrice,selectMainPerp} from '../src/orderPlanner.mjs';
import {validateIntentSpec} from '../src/intentLedger.mjs';
import {assessShadowVaultRisk} from '../src/riskGate.mjs';
const V='0x1111111111111111111111111111111111111111';
const t=1800000000000;
const meta={universe:[{name:'BTC',szDecimals:5,maxLeverage:40},{name:'ETH',szDecimals:4,maxLeverage:25}]};
const intent=(p={})=>({mode:'SHADOW_ONLY',vaultAddress:V,fillKey:'source:1000',coin:'BTC',side:'buy',size:'0.001',netBefore:'0',netAfter:'0.001',...p});
const prepare=(changes={})=>{
 const {intent:i=intent(),meta:m=meta,mark='50000',at=t,now=t+1000,leverage={mode:'cross',value:2,asOfMs:t},
   policy={network:'mainnet',maxSlippageBps:50,maxSnapshotAgeMs:3000,expectedLeverage:2,minNotionalUsd:'10'},receipt,
   vaultSnapshot:vaultState,riskPolicy:riskLimits} = changes;
 const spec=validateIntentSpec(i);
 const snapshot=vaultState??{vaultAddress:V,accountValueUsd:'10000',asOfMs:t,positions:{BTC:spec.netBefore,ETH:'0'},marks:{BTC:mark,ETH:'2000'}};
 const riskPolicy=riskLimits??{maxGrossLeverageBps:20000,maxMarketNotionalBps:10000,maxOrderNotionalUsd:'5000',maxSnapshotAgeMs:3000};
 const risk=receipt??assessShadowVaultRisk(spec,snapshot,riskPolicy,now);
 return prepareShadowIocOrder({intent:i,riskReceipt:risk,vaultSnapshot:snapshot,riskPolicy,meta:m,
   markUsd:mark,marketObservedAtMs:at,nowMs:now,observedLeverage:leverage,policy});
};

test('valid preview has exact protocol fields, deterministic cloid, no signer or network',()=>{
 const p=prepare();
 assert.deepEqual(p.wireOrderPreview,{a:0,b:true,p:'50250',s:'0.001',r:false,t:{limit:{tif:'Ioc'}},c:validateIntentSpec(intent()).clientOrderId});
 assert.equal(p.signingAllowed,false);assert.equal(p.sendAllowed,false);assert.equal('privateKey' in p,false);
});
test('metadata main validator perp asset id comes from index and lot precision',()=>{
 assert.deepEqual(selectMainPerp(meta,'ETH'),{assetIndex:1,coin:'ETH',szDecimals:4,maxLeverage:25});
});
test('dust and non-lot-aligned size fail rather than silently rounding order size',()=>{
 const i=intent({size:'0.000001',netAfter:'0.000001'});
 assert.throws(()=>prepare({intent:i}),/not exactly representable/);
 const j=intent({size:'0.00001',netAfter:'0.00001'});
 assert.throws(()=>prepare({intent:j}),/minimum notional/);
});
test('raw price follows documented five significant figures',()=>{
 assert.equal(boundedPerpPrice({markUsd:'1234.56',szDecimals:3,side:'buy',maxSlippageBps:50}),'1240.7');
 assert.equal(boundedPerpPrice({markUsd:'1234.56',szDecimals:3,side:'sell',maxSlippageBps:50}),'1228.4');
});
test('large integer prices legal and precision changes are recognized',()=>{
 assert.equal(boundedPerpPrice({markUsd:'123456',szDecimals:5,side:'buy',maxSlippageBps:50}),'124073');
});
test('integer high price remains representable without slippage',()=>{
 assert.equal(boundedPerpPrice({markUsd:'123456',szDecimals:5,side:'buy',maxSlippageBps:0}),'123456');
 assert.equal(boundedPerpPrice({markUsd:'123456',szDecimals:5,side:'sell',maxSlippageBps:0}),'123456');
});
test('small perp price tick obeys 6-szDecimals cap',()=>{
 assert.throws(()=>boundedPerpPrice({markUsd:'0.012345',szDecimals:4,side:'buy',maxSlippageBps:50}),/too narrow/);
 assert.equal(boundedPerpPrice({markUsd:'0.12',szDecimals:4,side:'buy',maxSlippageBps:50}),'0.12');
});
test('too narrow slippage band rejects rather than submit unmarketable IOC',()=>{
 assert.throws(()=>boundedPerpPrice({markUsd:'99999.1',szDecimals:5,side:'buy',maxSlippageBps:0}),/too narrow/);
});
test('deny a cross-zero flip rather than mislabeled reduceOnly false',()=>{
 const i=intent({side:'sell',size:'0.003',netBefore:'0.002',netAfter:'-0.001'});
 assert.throws(()=>prepare({intent:i}),/flip requires/);
});
test('valid full close requires reduceOnly classification in approval',()=>{
 const i=intent({side:'sell',size:'0.001',netBefore:'0.001',netAfter:'0'});
 const forged=assessShadowVaultRisk(i,{vaultAddress:V,accountValueUsd:'10000',asOfMs:t,positions:{BTC:'0.001',ETH:'0'},marks:{BTC:'50000',ETH:'2000'}},{maxGrossLeverageBps:20000,maxMarketNotionalBps:10000,maxOrderNotionalUsd:'5000',maxSnapshotAgeMs:3000},t+1000);
 assert.throws(()=>prepare({intent:i,receipt:{...forged,requiresReduceOnly:false}}),/Risk approval no longer matches/);
 const spec=validateIntentSpec(i);
 const snapshot={vaultAddress:V,accountValueUsd:'10000',asOfMs:t,positions:{BTC:spec.netBefore,ETH:'0'},marks:{BTC:'50000',ETH:'2000'}};
 const rp={maxGrossLeverageBps:20000,maxMarketNotionalBps:10000,maxOrderNotionalUsd:'5000',maxSnapshotAgeMs:3000};
 const r=assessShadowVaultRisk(spec,snapshot,rp,t+1000);
 const out=prepare({intent:i,receipt:r});assert.equal(out.requiresReduceOnly,true);assert.equal(out.wireOrderPreview.r,true);
});
test('risk cannot authorize another order with same vault and coin',()=>{
 const i=intent({size:'0.002',netAfter:'0.002'}),a=validateIntentSpec(intent());
 assert.throws(()=>prepare({intent:i,receipt:{mode:'SHADOW_ONLY',allowed:true,intentId:a.intentId,vaultAddress:V,coin:'BTC',requiresReduceOnly:false}}),/exact-intent/);
});
test('blocked approval cannot be used even if other fields match',()=>{
 const i=intent(),spec=validateIntentSpec(i);
 assert.throws(()=>prepare({receipt:{mode:'SHADOW_ONLY',allowed:false,intentId:spec.intentId,vaultAddress:V,coin:'BTC',requiresReduceOnly:false}}),/approval/);
});
test('stale and future timestamp rejected',()=>{
 assert.throws(()=>prepare({now:t+4000}),/Stale|risk approval/);
 assert.throws(()=>prepare({now:t-1}),/Stale|snapshot clock/);
 assert.throws(()=>prepare({leverage:{mode:'cross',value:2,asOfMs:t-10000}}),/[Ll]everage/);
});
test('manual change in cross leverage or margin mode prevents preview',()=>{
 assert.throws(()=>prepare({leverage:{mode:'cross',value:3,asOfMs:t}}),/[Ll]everage/);
 assert.throws(()=>prepare({leverage:{mode:'isolated',value:2,asOfMs:t}}),/[Ll]everage/);
});
test('unsupported network, absurd slippage and excessive leverage blocked',()=>{
 const policy={network:'mainnet',maxSlippageBps:50,maxSnapshotAgeMs:3000,expectedLeverage:2,minNotionalUsd:'10'};
 assert.throws(()=>prepare({policy:{...policy,network:'unknown'}}),/network/);
 assert.throws(()=>prepare({policy:{...policy,maxSlippageBps:1000}}),/[Ss]lippage/);
 assert.throws(()=>prepare({policy:{...policy,expectedLeverage:26}}),/[Ll]everage/);
});
test('delisted, isolated-only, duplicate or missing asset metadata rejected',()=>{
 assert.throws(()=>prepare({meta:{universe:[{...meta.universe[0],isDelisted:true}]}}),/Delisted/);
 assert.throws(()=>prepare({meta:{universe:[{...meta.universe[0],onlyIsolated:true}]}}),/isolated/);
 assert.throws(()=>prepare({meta:{universe:[meta.universe[0],meta.universe[0]]}}),/duplicated/);
 assert.throws(()=>prepare({meta:{universe:[meta.universe[1]]}}),/missing/);
});
test('missing or corrupt risk inputs blocked',()=>{
 assert.throws(()=>prepare({meta:{universe:[{name:'BTC',szDecimals:9,maxLeverage:40}]}}),/metadata/);
 assert.throws(()=>prepare({mark:'0'}),/Positive|Invalid required market mark/);
});
test('IOC price does not exceed configured slippage band',()=>{
 let valid=0,blocked=0;
 for(const mid of ['100','9999.1','0.012345','50000','0.500001']){
   const m=BigInt(Math.round(Number(mid)*1000000));
   for(const side of ['buy','sell']){
     let px;
     try{ px=boundedPerpPrice({markUsd:mid,szDecimals:3,side,maxSlippageBps:50}); }
     catch(e) {assert.match(e.message,/too narrow/);blocked++;continue;}
     valid++;
     const units=BigInt(Math.round(Number(px)*1000000));
     if(side==='buy')assert(units*10000n<=m*10050n);
     else assert(units*10000n>=m*9950n);
   }
 }
 assert(valid>0);assert(blocked>0);
});

test('recomputed current risk blocks a formerly approved order after vault exposure changed',()=>{
 const i=intent();
 const approvedState={vaultAddress:V,accountValueUsd:'10000',asOfMs:t,positions:{BTC:'0',ETH:'0'},marks:{BTC:'50000',ETH:'2000'}};
 const rp={maxGrossLeverageBps:20000,maxMarketNotionalBps:10000,maxOrderNotionalUsd:'5000',maxSnapshotAgeMs:3000};
 const approval=assessShadowVaultRisk(i,approvedState,rp,t+1000);
 const liveState={...approvedState,positions:{BTC:'0.001',ETH:'0'}};
 assert.throws(()=>prepare({receipt:approval,vaultSnapshot:liveState}),/Fresh vault risk check blocked/);
});
test('fresh vault mark and unsigned limit mark must agree',()=>{
 const snapshot={vaultAddress:V,accountValueUsd:'10000',asOfMs:t,positions:{BTC:'0',ETH:'0'},marks:{BTC:'49000',ETH:'2000'}};
 assert.throws(()=>prepare({vaultSnapshot:snapshot,mark:'50000'}),/mark price mismatch/);
});
test('property: 600 deterministic random legal perp prices never break tick or slippage constraints',()=>{
 let x=0x5a17n,valid=0,blocked=0;
 const next=()=>{x=(1664525n*x+1013904223n)%(2n**32n);return x;};
 const formatMoney=units=>`${units/1000000n}${units%1000000n===0n?'':'.'+String(units%1000000n).padStart(6,'0').replace(/0+$/,'')}`;
 for(let i=0;i<600;i++){
   const mid=(next()%2000000000000n)+1n;
   const szDecimals=Number(next()%7n);
   const bps=Number(next()%501n);
   const side=i%2?'sell':'buy';
   const midText=formatMoney(mid);
   let result;
   try{result=boundedPerpPrice({markUsd:midText,szDecimals,side,maxSlippageBps:bps});}
   catch(e){assert.match(e.message,/too narrow|precision boundary|positive order limit/);blocked++;continue;}
   const parts=result.split('.');
   assert((parts[1]||'').length<=6-szDecimals,`decimal ceiling: ${result}`);
   const sig=(parts[0]+(parts[1]||'')).replace(/^0+/,'').replace(/0+$/,'');
   assert((parts[1]||'').length===0||sig.length<=5,`significant figures: ${result}`);
   const px=BigInt(parts[0])*1000000n+BigInt((parts[1]||'').padEnd(6,'0')||'0');
   if(side==='buy'){
     assert(px>=mid,`buy marketability: ${result}`);
     assert(px*10000n<=mid*BigInt(10000+bps),`buy slippage: ${result}`);
   }else{
     assert(px<=mid,`sell marketability: ${result}`);
     assert(px*10000n>=mid*BigInt(10000-bps),`sell slippage: ${result}`);
   }
   valid++;
 }
 assert(valid>0 && blocked>0);
});