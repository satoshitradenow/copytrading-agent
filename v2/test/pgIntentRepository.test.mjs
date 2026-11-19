import test from 'node:test';
import assert from 'node:assert/strict';
import {PgIntentRepository} from '../src/pgIntentRepository.mjs';
const VAULT='0x1111111111111111111111111111111111111111';
const T=1800000000000;
const source=(x={})=>({mode:'SHADOW_ONLY',vaultAddress:VAULT,fillKey:'t:42',coin:'BTC',side:'buy',size:'0.02',netBefore:'0',netAfter:'0.02',...x});
const evt=(type,rest={})=>({type,atMs:T,...rest});
function makePool(){
 const db={intents:new Map(),events:[],commits:0,rollbacks:0,failOn:null};
 const rows=x=>JSON.parse(JSON.stringify(x));
 const pool={db,connect:async()=>{
  let stage=null;
  const client={release:()=>{},query:async(text,params=[])=>{
   const sql=text.replace(/\s+/g,' ').trim();
   if(sql.startsWith('BEGIN ')){stage={intents:new Map([...db.intents].map(([k,v])=>[k,rows(v)])),events:rows(db.events)};return{rowCount:0,rows:[]};}
   if(sql==='COMMIT'){db.intents=stage.intents;db.events=stage.events;db.commits++;stage=null;return{rowCount:0,rows:[]};}
   if(sql==='ROLLBACK'){stage=null;db.rollbacks++;return{rowCount:0,rows:[]};}
   if(!stage)throw Error('SQL outside transaction');
   if(db.failOn && sql.includes(db.failOn))throw Error('simulated PostgreSQL failure');
   if(sql.startsWith('INSERT INTO v2_execution_intents')){
    const [id,vault,fillKey,clid,raw]=params;
    for(const other of stage.intents.values())if(other.vault_address===vault&&other.fill_key===fillKey)return{rowCount:0,rows:[]};
    const r={intent_id:id,vault_address:vault,fill_key:fillKey,client_order_id:clid,state:JSON.parse(raw),version:0,last_event_hash:'0'.repeat(64)};
    stage.intents.set(id,r);return{rowCount:1,rows:[{intent_id:id}]};
   }
   if(sql.startsWith('SELECT ')&&sql.includes('WHERE vault_address=$1 AND fill_key=$2')){
    const [vault,fillKey]=params;const matches=[...stage.intents.values()].filter(x=>x.vault_address===vault&&x.fill_key===fillKey);
    return{rowCount:matches.length,rows:rows(matches)};
   }
   if(sql.startsWith('SELECT ')&&sql.includes('WHERE intent_id=$1 FOR UPDATE')){
    const match=stage.intents.get(params[0]);return{rowCount:match?1:0,rows:match?[rows(match)]:[]};
   }
   if(sql.startsWith('UPDATE v2_execution_intents')){
    if(sql.includes('SET version=1')){
     const [id,h]=params,r=stage.intents.get(id);
     if(!r||r.version!==0)return{rowCount:0,rows:[]};r.version=1;r.last_event_hash=h;return{rowCount:1,rows:[]};
    }
    const [id,state,version,digest,expected]=params,r=stage.intents.get(id);
    if(!r||r.version!==Number(expected))return{rowCount:0,rows:[]};
    r.state=JSON.parse(state);r.version=version;r.last_event_hash=digest;return{rowCount:1,rows:[]};
   }
   if(sql.startsWith('INSERT INTO v2_execution_events')){
    if(params.length===4){const [intentId,previousHash,digest,data]=params;
     stage.events.push({intentId,version:1,previousHash,digest,event:JSON.parse(data)});}
    else{const [intentId,version,previousHash,digest,type,data]=params;
     stage.events.push({intentId,version,previousHash,digest,type,event:JSON.parse(data)});}
    return{rowCount:1,rows:[]};
   }
   throw Error('Mock does not recognize SQL: '+sql.slice(0,100));
  }};return client;
 },query:async(sql,params)=>{
  if(!sql.includes('FROM v2_execution_intents'))throw Error('unrecognized read SQL');
  const matches=[...db.intents.values()].filter(x=>
   sql.includes('WHERE intent_id') ? x.intent_id===params[0] : x.vault_address===params[0] &&
   ['SUBMITTING','UNKNOWN','ACKED','PARTIAL','REVIEW_REQUIRED'].includes(x.state.status));
  return{rowCount:matches.length,rows:rows(matches)};
 }};
 return pool;
}
test('PostgreSQL repository persists a unique fill proposal transactionally',async()=>{
 const pool=makePool(),repo=new PgIntentRepository(pool);
 const a=await repo.propose(source()),b=await repo.propose(source());
 assert.deepEqual(b,a);assert.equal(pool.db.intents.size,1);
 assert.equal(pool.db.events.length,1);assert.equal(pool.db.commits,2);
 assert.equal(pool.db.intents.get(a.intentId).version,1);
});
test('PostgreSQL rejects conflicting same source fill under its unique key',async()=>{
 const pool=makePool(),repo=new PgIntentRepository(pool);
 await repo.propose(source());
 await assert.rejects(repo.propose(source({size:'0.01',netAfter:'0.01'})),/Existing source fill maps/);
 assert.equal(pool.db.intents.size,1);assert.equal(pool.db.rollbacks,1);
});
test('transition state and its audit event commit together',async()=>{
 const pool=makePool(),repo=new PgIntentRepository(pool),p=await repo.propose(source());
 const x=await repo.transition(p.intentId,evt('RISK_APPROVED',{receipt:{mode:'SHADOW_ONLY',allowed:true,vaultAddress:VAULT,coin:'BTC',requiresReduceOnly:false}}));
 assert.equal(x.status,'APPROVED');assert.equal(pool.db.events.length,2);
 assert.equal((await repo.get(p.intentId)).status,'APPROVED');
});
test('failed event insert rolls back associated intent status update',async()=>{
 const pool=makePool(),repo=new PgIntentRepository(pool),p=await repo.propose(source());
 pool.db.failOn='INSERT INTO v2_execution_events';
 await assert.rejects(repo.transition(p.intentId,evt('RISK_BLOCKED',{reasons:['RISK']})),/simulated/);
 assert.equal((await repo.get(p.intentId)).status,'DRAFT');assert.equal(pool.db.events.length,1);
 assert.equal(pool.db.rollbacks,1);
});
test('unknown submission status survives restart and blocks repeat submission',async()=>{
 const pool=makePool(),repo=new PgIntentRepository(pool),p=await repo.propose(source());
 await repo.transition(p.intentId,evt('RISK_APPROVED',{receipt:{mode:'SHADOW_ONLY',allowed:true,vaultAddress:VAULT,coin:'BTC',requiresReduceOnly:false}}));
 await repo.transition(p.intentId,evt('SUBMISSION_STARTED',{clientOrderId:p.clientOrderId,riskRecheckedAtMs:T}));
 await repo.transition(p.intentId,evt('SUBMISSION_UNCERTAIN'));
 const afterRestart=new PgIntentRepository(pool);
 assert.equal((await afterRestart.get(p.intentId)).status,'UNKNOWN');
 assert.equal((await afterRestart.unresolvedForVault(VAULT)).length,1);
 await assert.rejects(afterRestart.transition(p.intentId,evt('SUBMISSION_STARTED',{clientOrderId:p.clientOrderId,riskRecheckedAtMs:T})),/forbidden/);
});
test('PostgreSQL repository does not append event twice for duplicate fill',async()=>{
 const pool=makePool(),repo=new PgIntentRepository(pool),p=await repo.propose(source());
 await repo.transition(p.intentId,evt('RISK_APPROVED',{receipt:{mode:'SHADOW_ONLY',allowed:true,vaultAddress:VAULT,coin:'BTC',requiresReduceOnly:false}}));
 await repo.transition(p.intentId,evt('SUBMISSION_STARTED',{clientOrderId:p.clientOrderId,riskRecheckedAtMs:T}));
 await repo.transition(p.intentId,evt('FILL_CONFIRMED',{fillId:'tid1',size:'0.01'}));
 const before=pool.db.events.length;
 await repo.transition(p.intentId,evt('FILL_CONFIRMED',{fillId:'tid1',size:'0.01'}));
 assert.equal(pool.db.events.length,before);assert.equal((await repo.get(p.intentId)).filledSize,'0.01');
});