import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveShadowLaunchConfig,configFromEnvironment} from '../src/shadowLaunchConfig.mjs';
const ONE='0x'+'1'.repeat(40),TWO='0x'+'2'.repeat(40);
const now=1795160000000;
const env={DATABASE_URL:'postgresql://vault:secret@localhost:5432/vault_copy_shadow'};
const cfg={mode:'SHADOW_ONLY',network:'mainnet',fromTimeMs:now-45000,
 traders:[{enabled:true,address:ONE},{enabled:true,address:TWO}]};
const run=(x=cfg,e=env)=>resolveShadowLaunchConfig({config:x,env:e,nowMs:now});
test('two approved sources in dedicated PostgreSQL are read-only and normalized',()=>{
 const result=run();
 assert.deepEqual(result.addresses,[ONE,TWO]);
 assert.equal(result.canTrade,false);
 assert.equal(result.hasSigner,false);
 assert.equal(result.network,'mainnet');
 assert.equal(result.dbName,'vault_copy_shadow');
 assert.ok(Object.isFrozen(result));
});
test('requires explicit SHADOW_ONLY and known network',()=>{
 assert.throws(()=>run({...cfg,mode:'LIVE'}),/Shadow-only launch mode/);
 assert.throws(()=>run({...cfg,network:'other'}),/Explicit Hyperliquid network/);
 assert.throws(()=>run({...cfg,network:undefined}),/Explicit Hyperliquid network/);
});
test('rejects implicit/unsafely old or future capture baseline',()=>{
 for(const invalid of [undefined,0,NaN,'1795159955000',now+1000,now-2000]){
  assert.throws(()=>run({...cfg,fromTimeMs:invalid}),/Recent integer shadow baseline/);
 }
});
test('source allowlist must contain 1 to 5 unique proper addresses',()=>{
 assert.throws(()=>run({...cfg,traders:[]}),/1–5/);
 assert.throws(()=>run({...cfg,traders:[{enabled:true,address:'BTC'}]}),/address/i);
 assert.throws(()=>run({...cfg,traders:[{enabled:true,address:ONE},{enabled:true,address:ONE}]}),/Duplicate/);
 assert.throws(()=>run({...cfg,traders:Array.from({length:6},(_,i)=>({enabled:true,address:'0x'+String(i+1).repeat(40)}))}),/1–5/);
});
test('signing keys in worker env are forbidden even if the worker never calls ExchangeClient',()=>{
 for(const name of ['FOLLOWER_PRIVATE_KEY','HL_SECRET_KEY','EXCHANGE_PRIVATE_KEY','API_PRIVATE_KEY']){
  assert.throws(()=>run(cfg,{...env,[name]:'0x'+'f'.repeat(64)}),/Refuse private signing keys/);
 }
});
test('never connect to production or default DB with an unsafe database identifier',()=>{
 for(const url of [
  'postgresql://vault:secret@localhost/postgres',
  'postgresql://vault:secret@localhost/corefraction',
  'postgresql://vault:secret@localhost/',
  'https://example.com/vault_copy_shadow',
  'postgresql://vault:secret@localhost/other'
 ]){
  assert.throws(()=>run(cfg,{DATABASE_URL:url}),/database|PostgreSQL/);
 }
 assert.throws(()=>run(cfg,{}),/DATABASE_URL/);
});
test('Render environment config requires opt-in and explicit sources',()=>{
 const e={VAULT_SHADOW_MODE:'SHADOW_ONLY',VAULT_NETWORK:'testnet',
  VAULT_SOURCE_ADDRESSES:ONE+', '+TWO,VAULT_BASELINE_MS:String(now-45000),
  ...env};
 const x=configFromEnvironment(e);
 assert.equal(x.traders.length,2);
 assert.equal(x.network,'testnet');
 assert.equal(run(x,e).network,'testnet');
 assert.throws(()=>configFromEnvironment({...e,VAULT_SHADOW_MODE:'LIVE'}),/SHADOW_ONLY/);
});
