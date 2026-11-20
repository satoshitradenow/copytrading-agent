import test from 'node:test';
import assert from 'node:assert/strict';
import {previewCurrentVaultIntent} from '../src/shadowPreflight.mjs';
const V='0x1111111111111111111111111111111111111111',L='0x2222222222222222222222222222222222222222';
const t=1800000000000;
const intent={mode:'SHADOW_ONLY',vaultAddress:V,fillKey:'source:1000',coin:'BTC',side:'buy',size:'0.001',netBefore:'0',netAfter:'0.001'};
const riskPolicy={maxGrossLeverageBps:20000,maxMarketNotionalBps:10000,maxOrderNotionalUsd:'2000',maxSnapshotAgeMs:3000};
const executionPolicy={network:'mainnet',maxSlippageBps:50,maxSnapshotAgeMs:3000,expectedLeverage:2,minNotionalUsd:'10'};
const readers=()=>({
 readVaultPublicState:async()=>({mode:'READ_ONLY',vaultAddress:V,leader:L,name:'TEST VAULT',accountValueUsd:'10000',positions:[]}),
 readVaultRiskInputs:async()=>({mode:'READ_ONLY',network:'mainnet',vaultAddress:V,accountValueUsd:'10000',asOfMs:t,positions:{BTC:'0'},marks:{BTC:'50000'}}),
 readMainPerpMetadata:async()=>({mode:'READ_ONLY',network:'mainnet',observedAtMs:t,meta:{universe:[{name:'BTC',szDecimals:5,maxLeverage:40}]}}),
 readVaultAssetLeverage:async()=>({mode:'cross',network:'mainnet',vaultAddress:V,coin:'BTC',value:2,asOfMs:t,source:'activeAssetData',signingAuthorityVerified:false})
});
const start=(changes={})=>previewCurrentVaultIntent({intent,riskPolicy,executionPolicy,clock:()=>t+1000,
 expectedLeader:L,expectedName:'TEST VAULT',readers:readers(),...changes});

test('read-only preflight combines identity, current risk, metadata and leverage into unsigned IOC',async()=>{
 const r=await start();
 assert.equal(r.mode,'SHADOW_ONLY');assert.equal(r.tradingEnabled,false);assert.equal(r.signingAuthorityVerified,false);
 assert.equal(r.preview.wireOrderPreview.a,0);assert.equal(r.preview.wireOrderPreview.p,'50250');
 assert.equal(r.preview.wireOrderPreview.s,'0.001');assert.equal(r.preview.sendAllowed,false);
});
test('wrong leader pin stops before risk observations',async()=>{
 const rs=readers();let riskReads=0;
 rs.readVaultRiskInputs=async()=>{riskReads++;throw Error('must never be queried')};
 await assert.rejects(start({expectedLeader:'0x'+'3'.repeat(40),readers:rs}),/leader mismatch/);
 assert.equal(riskReads,0);
});
test('risk gate rejects vault position drift even with an otherwise valid intent',async()=>{
 const rs=readers();rs.readVaultRiskInputs=async()=>({...await readers().readVaultRiskInputs(),positions:{BTC:'0.002'}});
 await assert.rejects(start({readers:rs}),/Risk policy blocked/);
});
test('source metadata and target network cannot silently disagree',async()=>{
 const rs=readers();rs.readMainPerpMetadata=async()=>({...await readers().readMainPerpMetadata(),network:'testnet'});
 await assert.rejects(start({readers:rs}),/Mismatched network/);
});
test('current vault leverage drift blocks unsigned preflight',async()=>{
 const rs=readers();rs.readVaultAssetLeverage=async()=>({...await readers().readVaultAssetLeverage(),value:5});
 await assert.rejects(start({readers:rs}),/leverage/);
});
test('stale market metadata fails closed before any signature can exist',async()=>{
 const rs=readers();rs.readMainPerpMetadata=async()=>({...await readers().readMainPerpMetadata(),observedAtMs:t-10000});
 await assert.rejects(start({readers:rs}),/metadata too old/);
});
test('unsigned preflight rejects missing explicit policies and unsupported networks',async()=>{
 await assert.rejects(start({riskPolicy:undefined,executionPolicy:{...executionPolicy,network:'chain42'}}),/policies and network/);
});