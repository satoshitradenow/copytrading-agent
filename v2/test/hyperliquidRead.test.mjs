import test from 'node:test';
import assert from 'node:assert/strict';
import { readVaultPublicState, readRecentSourceFills } from '../src/hyperliquidRead.mjs';
const vault='0x1111111111111111111111111111111111111111';
const leader='0x2222222222222222222222222222222222222222';

test('read-only vault inspection uses /info exclusively and checks vault/leader identities',async()=>{
  const requests=[];
  const fetchImpl=async (url,opts)=>{
    requests.push({url,opts});
    const req=JSON.parse(opts.body);
    return {ok:true,json:async()=> req.type==='vaultDetails'
      ? {vaultAddress:vault,leader,name:'Test Vault'}
      : {marginSummary:{accountValue:'1015.50'},assetPositions:[]} };
  };
  const out=await readVaultPublicState(vault,{fetchImpl});
  assert.equal(out.mode,'READ_ONLY');
  assert.equal(out.accountValueUsd,'1015.50');
  assert.equal(out.leader,leader);
  assert.equal(requests.length,2);
  for(const r of requests){assert.equal(r.url,'https://api.hyperliquid.xyz/info');assert.equal(r.opts.method,'POST');assert.ok(!r.url.includes('/exchange'));}
});

test('read-only vault inspection fails closed on mismatched vault and malformed equity',async()=>{
  const mismatch=async (url,opts)=>({ok:true,json:async()=>JSON.parse(opts.body).type==='vaultDetails'
    ? {vaultAddress:leader,leader} : {marginSummary:{accountValue:'1'},assetPositions:[]}});
  await assert.rejects(readVaultPublicState(vault,{fetchImpl:mismatch}),/mismatch/);
  const noEquity=async (url,opts)=>({ok:true,json:async()=>JSON.parse(opts.body).type==='vaultDetails'
    ? {vaultAddress:vault,leader} : {marginSummary:{},assetPositions:[]}});
  await assert.rejects(readVaultPublicState(vault,{fetchImpl:noEquity}),/equity/);
});

test('recent source fills are returned raw with no guessed historical equity',async()=>{
  const fetchImpl=async(url,opts)=>{
    assert.equal(JSON.parse(opts.body).type,'userFills');
    return {ok:true,json:async()=>[{tid:17,coin:'BTC',px:'50000',sz:'1',side:'B'}]};
  };
  const rows=await readRecentSourceFills(vault,{fetchImpl});
  assert.equal(rows[0].tid,17);
  assert.equal(rows[0].sourceEquityUsd,undefined);
});

test('bad address and failed HTTP response are not treated as empty accounts',async()=>{
  await assert.rejects(readVaultPublicState('0xBAD'),/Expected a 42/);
  const badFetch=async()=>({ok:false,status:429});
  await assert.rejects(readRecentSourceFills(vault,{fetchImpl:badFetch}),/429/);
});

test('read-only risk inputs join real vault position and mark-price responses without signing',async()=>{
 const calls=[];
 const fetchImpl=async (url,options)=>{
   assert.equal(url,'https://api.hyperliquid.xyz/info');
   const req=JSON.parse(options.body);calls.push(req.type);
   return {ok:true,json:async()=>req.type==='allMids'?{BTC:'50100.5',ETH:'2010'}:
    {marginSummary:{accountValue:'1500'},assetPositions:[{position:{coin:'BTC',szi:'0.001'}}]}};
 };
 const {readVaultRiskInputs}=await import('../src/hyperliquidRead.mjs');
 const result=await readVaultRiskInputs(vault,{fetchImpl});
 assert.equal(result.mode,'READ_ONLY');
 assert.deepEqual(result.positions,{BTC:'0.001'});
 assert.equal(result.accountValueUsd,'1500');
 assert.equal(result.marks.BTC,'50100.5');
 assert.deepEqual(calls.sort(),['allMids','clearinghouseState']);
});

test('source equity observation is labeled non-historical and never turned into fill equity',async()=>{
 const {readSourceEquityObservation}=await import('../src/hyperliquidRead.mjs');
 const A='0x1111111111111111111111111111111111111111';
 const fetchImpl=async(_url,args)=>{
  const req=JSON.parse(args.body);
  assert.equal(req.type,'clearinghouseState');
  return{ok:true,json:async()=>({marginSummary:{accountValue:'1234.5'},assetPositions:[]})};
 };
 const s=await readSourceEquityObservation(A,{fetchImpl});
 assert.equal(s.accountValueUsd,'1234.5');assert.equal(s.mode,'READ_ONLY');
 assert.equal('sourceEquityUsd' in s,false);
 assert.match(s.limitation,/not historical fill-time/);
});