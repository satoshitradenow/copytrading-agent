import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ShadowPortfolioNetting} from '../src/portfolioNetting.mjs';
import {ShadowLedger,MemoryJournal} from '../src/ledger.mjs';
import {PgPortfolioBatchRepository,validateStagedPortfolioPreview} from '../src/pgPortfolioBatchRepository.mjs';

const VAULT='0x'+'9'.repeat(40),A='0x'+'1'.repeat(40),B='0x'+'2'.repeat(40);
const traders=[A,B].map(address=>({address,allocationUsd:'1000',maxVirtualLeverage:5,enabled:true}));
const allowedCoins=['BTC','ETH'];
const source={trader:A,fillId:'HL:1',coin:'BTC',side:'buy',size:'1',priceUsd:'50000',sourceStartPosition:'0',timeMs:10000};
const owner={writerId:'17fa2a6a-c4c5-47f4-b232-a11234567890',fencingToken:'7'};
function draft(fill=source,ledgerJournal=new MemoryJournal(),netPositions={BTC:'0'}){
  const p=new ShadowPortfolioNetting({vaultAddress:VAULT,traders,allowedCoins,journal:ledgerJournal});
  const signed=fill.side==='buy'?Number(fill.size):-Number(fill.size);
  return p.preview({fill,sourceObservation:{mode:'READ_ONLY',trader:fill.trader,network:'mainnet',accountValueUsd:'100000',
    observedAtStartMs:fill.timeMs,observedAtEndMs:fill.timeMs+10,
    positions:[{position:{coin:fill.coin,szi:String(Number(fill.sourceStartPosition)+signed)}}]},
    vaultSnapshot:{mode:'READ_ONLY',network:'mainnet',vaultAddress:VAULT,positions:netPositions,asOfMs:fill.timeMs+15},
    unresolvedIntents:[],nowMs:fill.timeMs+20});
}
function mockPool(){
  const db={batches:new Map(),unresolved:false,leaseOwner:owner.writerId,fencingToken:owner.fencingToken,
    commits:0,rollbacks:0,failOn:null};
  return {db,connect:async()=>{
    let staged=null;
    return {release(){},async query(query,args=[]){
      const q=query.replace(/\s+/g,' ').trim();
      if(q.startsWith('BEGIN ')){staged=new Map([...db.batches].map(([k,v])=>[k,structuredClone(v)]));return{rows:[],rowCount:0};}
      if(q==='COMMIT'){db.batches=staged;db.commits++;staged=null;return{rows:[],rowCount:0};}
      if(q==='ROLLBACK'){staged=null;db.rollbacks++;return{rows:[],rowCount:0};}
      if(!staged)throw Error('Unexpected query outside a transaction');
      if(db.failOn && q.includes(db.failOn))throw Error('Simulated database failure');
      if(q.startsWith('SELECT vault_address FROM v2_vault_writer_leases')){
        const ok=args[0]===VAULT&&args[1]===db.leaseOwner&&args[2]===db.fencingToken;
        return {rowCount:ok?1:0,rows:ok?[{vault_address:VAULT}]:[]};
      }
      if(q.startsWith('SELECT intent_id FROM v2_execution_intents'))return{rows:db.unresolved?[{intent_id:'pending'}]:[],rowCount:db.unresolved?1:0};
      if(q.startsWith('SELECT batch_id,status FROM v2_portfolio_batches')){
        const v=[...staged.values()].filter(x=>x.vault_address===args[0]&&x.source_fill_key===args[1]);
        return{rows:v.map(x=>({batch_id:x.batch_id,status:x.status})),rowCount:v.length};
      }
      if(q.startsWith('SELECT batch_id FROM v2_portfolio_batches')){
        const v=[...staged.values()].filter(x=>x.vault_address===args[0]&&['STAGED','REVIEW_REQUIRED'].includes(x.status));
        return{rows:v.map(x=>({batch_id:x.batch_id})),rowCount:v.length};
      }
      if(q.startsWith('INSERT INTO v2_portfolio_batches')){
        const [batch_id,vault_address,network,source_fill_key,source_record,expected_net_before,desired_net_after,planned_legs]=args;
        if([...staged.values()].some(x=>x.vault_address===vault_address && (x.source_fill_key===source_fill_key||['STAGED','REVIEW_REQUIRED'].includes(x.status))))return{rows:[],rowCount:0};
        staged.set(batch_id,{batch_id,vault_address,network,source_fill_key,source_record:JSON.parse(source_record),
          expected_net_before:JSON.parse(expected_net_before),desired_net_after:JSON.parse(desired_net_after),
          planned_legs:JSON.parse(planned_legs),status:'STAGED',created_at:'2026-11-20T00:00:00Z'});
        return{rows:[{batch_id,status:'STAGED'}],rowCount:1};
      }
      throw Error('Unexpected SQL '+q.slice(0,120));
    }};
  },async query(query,args=[]){
    if(!query.includes('SELECT batch_id,source_fill_key,status,created_at'))throw Error('Unexpected direct SQL');
    const active=[...db.batches.values()].filter(x=>x.vault_address===args[0]&&['STAGED','REVIEW_REQUIRED'].includes(x.status));
    return {rows:active.map(x=>({batch_id:x.batch_id,source_fill_key:x.source_fill_key,status:x.status,created_at:x.created_at}))};
  }};
}

test('staging stores one immutable pending source batch, without moving virtual portfolio',async()=>{
 const journal=new MemoryJournal(),plan=draft(source,journal),pool=mockPool();
 const result=await new PgPortfolioBatchRepository(pool).stage(plan,owner);
 assert.equal(result.status,'STAGED');assert.equal(result.mode,'SHADOW_ONLY');
 assert.equal(result.executeAuthorized,false);assert.equal(pool.db.commits,1);
 assert.equal(journal.readAll().length,0);
 assert.equal(pool.db.batches.size,1);
 assert.equal((await new PgPortfolioBatchRepository(pool).pendingForVault(VAULT)).length,1);
});

test('identical repeated stage is idempotent and cannot create a second batch',async()=>{
 const pool=mockPool(),p=new PgPortfolioBatchRepository(pool),plan=draft();
 const a=await p.stage(plan,owner),b=await p.stage(plan,owner);
 assert.equal(a.batchId,b.batchId);assert.equal(b.idempotent,true);assert.equal(pool.db.batches.size,1);
});

test('conflicting same-source fill evidence cannot be staged under same key',async()=>{
 const pool=mockPool(),p=new PgPortfolioBatchRepository(pool),plan=draft();await p.stage(plan,owner);
 const forged={...plan,proposedSourceJournalRecord:{...plan.proposedSourceJournalRecord,fillDigest:'a'.repeat(64)}};
 await assert.rejects(p.stage(forged,owner),/Conflicting portfolio batch/);
});

test('second source fill blocks until existing batch is independently settled',async()=>{
 const pool=mockPool(),p=new PgPortfolioBatchRepository(pool),plan=draft();await p.stage(plan,owner);
 const next={...source,trader:B,fillId:'HL:2',timeMs:11000};
 const nextDraft=draft(next);
 await assert.rejects(p.stage(nextDraft,owner),/Previous source event has not been settled/);
 // Test fixture-only state update. Public repo exposes NO settlement action.
 for(const batch of pool.db.batches.values())batch.status='SETTLED';
 const staged=await p.stage(nextDraft,owner);
 assert.equal(staged.status,'STAGED');assert.equal(pool.db.batches.size,2);
});

test('unresolved exchange order blocks batch staging even with a valid writer',async()=>{
 const pool=mockPool();pool.db.unresolved=true;
 await assert.rejects(new PgPortfolioBatchRepository(pool).stage(draft(),owner),/Unresolved exchange order/);
 assert.equal(pool.db.batches.size,0);
});

test('missing, stale, or conflicting writer ownership cannot stage a batch',async()=>{
 const pool=mockPool(),repo=new PgPortfolioBatchRepository(pool),plan=draft();
 for(const bad of [{writerId:randomUUID(),fencingToken:'7'},
   {writerId:owner.writerId,fencingToken:'6'},
   {writerId:'invalid',fencingToken:'7'}]){
   await assert.rejects(repo.stage(plan,bad));
 }
 assert.equal(pool.db.batches.size,0);
});

test('malformed net changes and forged order identifiers are not accepted as preview evidence',()=>{
 const plan=draft();
 assert.throws(()=>validateStagedPortfolioPreview({...plan,executeAuthorized:true}),/non-executing/);
 assert.throws(()=>validateStagedPortfolioPreview({...plan,desiredNetAfter:{BTC:'999'}}),/Last portfolio leg/);
 assert.throws(()=>validateStagedPortfolioPreview({...plan,intents:plan.intents.map(x=>({...x,clientOrderId:'0x'+'0'.repeat(32)}))}),/identity/);
 assert.throws(()=>validateStagedPortfolioPreview({...plan,network:'invalid'}),/network/);
 assert.throws(()=>validateStagedPortfolioPreview({...plan,proposedSourceJournalRecord:{...plan.proposedSourceJournalRecord,fillDigest:'BAD'}}),/journal record/);
});

test('position-flip staging stores two sequential legs with unique client order IDs',async()=>{
 const journal=new MemoryJournal();new ShadowLedger({traders,allowedCoins,journal}).applyFill({...source,sourceEquityUsd:'100000'});
 const flip={...source,fillId:'HL:2',side:'sell',size:'2',sourceStartPosition:'1',timeMs:11000};
 const plan=draft(flip,journal,{BTC:'0.01'});
 assert.equal(plan.intents.length,2);
 const pool=mockPool();const out=await new PgPortfolioBatchRepository(pool).stage(plan,owner);
 const staged=pool.db.batches.get(out.batchId);
 assert.deepEqual(staged.planned_legs.map(x=>x.phase),['close-first','open-after-close']);
 assert.equal(staged.planned_legs[1].requiresPriorLegConfirmation,true);
 assert.notEqual(staged.planned_legs[0].clientOrderId,staged.planned_legs[1].clientOrderId);
});

test('data loss during stage triggers rollback with no partial batch',async()=>{
 const pool=mockPool();pool.db.failOn='INSERT INTO v2_portfolio_batches';
 await assert.rejects(new PgPortfolioBatchRepository(pool).stage(draft(),owner),/Simulated database failure/);
 assert.equal(pool.db.rollbacks,1);assert.equal(pool.db.batches.size,0);
});

test('a pending review-required batch also blocks new source events',async()=>{
 const pool=mockPool(),repo=new PgPortfolioBatchRepository(pool);await repo.stage(draft(),owner);
 for(const batch of pool.db.batches.values())batch.status='REVIEW_REQUIRED';
 const fill={...source,fillId:'HL:3',timeMs:12000};
 await assert.rejects(repo.stage(draft(fill),owner),/Previous source event has not been settled/);
});