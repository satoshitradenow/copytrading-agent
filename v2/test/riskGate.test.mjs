import test from 'node:test';
import assert from 'node:assert/strict';
import {assessShadowVaultRisk,normalizeVaultPositions} from '../src/riskGate.mjs';
const V='0x1111111111111111111111111111111111111111';
const t=1_800_000_000_000;
const policy={maxGrossLeverageBps:20000,maxMarketNotionalBps:10000,maxOrderNotionalUsd:'2500',maxSnapshotAgeMs:10000};
const snap=(overrides={})=>({vaultAddress:V,accountValueUsd:'5000',asOfMs:t,positions:{BTC:'0',ETH:'0'},marks:{BTC:'50000',ETH:'2000'},...overrides});
const intent=(o={})=>({mode:'SHADOW_ONLY',vaultAddress:V,fillKey:'test:a1',coin:'BTC',side:'buy',size:'0.01',netBefore:'0',netAfter:'0.01',...o});
const check=(i=intent(),s=snap(),p=policy,clock=t+2000)=>assessShadowVaultRisk(i,s,p,clock);

test('approved small entry is shadow-allowed without submitting anything',()=>{
 const r=check();assert.equal(r.allowed,true);assert.equal(r.orderNotionalUsd,'500');assert.equal(r.grossAfterUsd,'500');assert.equal(r.requiresReduceOnly,false);
});
test('mismatch between ledger and actual vault position blocks execution',()=>{
 const r=check(intent(),snap({positions:{BTC:'0.002'}}));assert.deepEqual(r.failures,['VAULT_POSITION_MISMATCH']);
});
test('stale vault read blocks even otherwise acceptable entry',()=>{
 const r=check(intent(),snap(),policy,t+12000);assert.deepEqual(r.failures,['STALE_VAULT_SNAPSHOT']);
});
test('market risk limits block concentration',()=>{
 const r=check(intent({size:'0.12',netAfter:'0.12'}));assert.equal(r.allowed,false);assert.ok(r.failures.includes('MARKET_CONCENTRATION'));
});
test('order notional limit applies separately from portfolio gross risk',()=>{
 const r=check(intent({size:'0.051',netAfter:'0.051'}));assert.ok(r.failures.includes('MAX_ORDER_NOTIONAL'));
});
test('gross leverage counts all existing markets, not merely the new coin',()=>{
 const s=snap({positions:{BTC:'0',ETH:'4.9'}});
 const r=check(intent({size:'0.05',netAfter:'0.05'}),s);
 assert.ok(r.failures.includes('GROSS_LEVERAGE'));
 assert.equal(r.grossBeforeUsd,'9800');
});
test('pure reduction can lower excessive existing exposure without applying entry caps',()=>{
 const s=snap({positions:{BTC:'0.15'}});
 const i=intent({side:'sell',size:'0.1',netBefore:'0.15',netAfter:'0.05'});
 const r=check(i,s);assert.equal(r.allowed,true);assert.equal(r.requiresReduceOnly,true);
});
test('risk-increasing flip is never disguised as reduce-only',()=>{
 const s=snap({positions:{BTC:'0.15'}});
 const i=intent({side:'sell',size:'0.35',netBefore:'0.15',netAfter:'-0.2'});
 const r=check(i,s);assert.equal(r.allowed,false);assert.equal(r.requiresReduceOnly,false);
});
test('price is required for every existing open market, not just target market',()=>{
 assert.throws(()=>check(intent(),snap({positions:{BTC:'0',SOL:'1000'}})),/Unpriced/);
});
test('inconsistent order arithmetic throws and cannot be represented as approved',()=>{
 assert.throws(()=>check(intent({netAfter:'0.02'})),/inconsistent/);
 assert.throws(()=>check(intent({mode:'LIVE'})),/SHADOW_ONLY/);
});
test('malformed equity/clock/limits cannot pass',()=>{
 assert.throws(()=>check(intent(),snap({accountValueUsd:'0'})),/equity/);
 assert.throws(()=>check(intent(),snap({asOfMs:t+10000}),policy,t+1000),/clock/);
 assert.throws(()=>check(intent(),snap(),{...policy,maxGrossLeverageBps:999999}),/leverage/);
});
test('exchange position adapter maps known signed sizes, rejects duplicate malformed data',()=>{
 const m=normalizeVaultPositions([{position:{coin:'BTC',szi:'0.01'}},{position:{coin:'ETH',szi:'-0.1'}}]);
 assert.deepEqual(m,{BTC:'0.01',ETH:'-0.1'});
 assert.throws(()=>normalizeVaultPositions([{position:{coin:'BTC',szi:'0'}},{position:{coin:'BTC',szi:'0'}}]),/Duplicate/);
 assert.throws(()=>normalizeVaultPositions([{position:{coin:'BTC',szi:'1e2'}}]),/decimal/);
});

test('unrelated allMids spot and HIP-3 price symbols do not block a valid validator-perp trade',()=>{
 const s=snap({marks:{BTC:'50000',ETH:'2000','@1':'0.0000000001','xyz:XYZ100':'900.25'}});
 const r=check(intent(),s);
 assert.equal(r.allowed,true);
});


test('risk receipt cryptographically binds to exact intent and rejects wrong vault snapshots',()=>{
 const receipt=check();
 const altered=check(intent({fillKey:'test:a2'}));
 assert.notEqual(receipt.intentId,altered.intentId);
 const wrong=check(intent(),snap({vaultAddress:'0x2222222222222222222222222222222222222222'}));
 assert.equal(wrong.allowed,false);
 assert.ok(wrong.failures.includes('VAULT_ADDRESS_MISMATCH'));
});