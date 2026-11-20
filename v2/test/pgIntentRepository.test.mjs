import test from 'node:test';
import assert from 'node:assert/strict';
import {PgIntentRepository} from '../src/pgIntentRepository.mjs';
const VAULT='0x1111111111111111111111111111111111111111';
const T=1800000000000;
const WRITER='17fa2a6a-c4c5-47f4-b232-a11234567890';
const OWNER={vaultAddress:VAULT,writerId:WRITER,fencingToken:'1'};
const grantLease=pool=>{pool.db.leases.set(VAULT,{vault_address:VAULT,writer_id:WRITER,fencing_token:'1',expires_at:T+15000});pool.db.controls.set(VAULT,{halted:false,generation:'1'});};
const source=(x={})=>({mode:'SHADOW_ONLY',vaultAddress:VAULT,fillKey:'t:42',coin:'BTC',side:'buy',size:'0.02',netBefore:'0',netAfter:'0.02',...x});
const evt=(type,rest={})=>({type,atMs:T,...rest});
const receipt=p=>({mode:'SHADOW_ONLY',allowed:true,vaultAddress:VAULT,coin:'BTC',requiresReduceOnly:false,intentId:p.intentId});
function makePool(){
 const db={intents:new Map(),events:[],leases:new Map(),controls:new Map(),time:T,commits:0,rollbacks:0,failOn:null};
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
   if(sql.includes('FROM v2_vault_writer_leases')&&sql.includes('db_now_ms')){
     const [vault,writer,token]=params,r=db.leases.get(vault);
     const ok=r&&r.writer_id===writer&&r.fencing_token===String(token)&&r.expires_at>db.time;
     return {rowCount:ok?1:0,rows:ok?[{...r,db_now_ms:db.time}]:[]};
   }
   if(sql.includes('FROM v2_vault_execution_controls')&&sql.includes('FOR UPDATE')){
     const row=db.controls.get(params[0]);
     return {rowCount:row?1:0,rows:row?[{...row}]:[]};
   }
   if(sql.startsWith('SELECT intent_id FROM v2_execution_intents')&&sql.includes('intent_id<>$2')){
     const [vault,id,statuses]=params;
     const matches=[...stage.intents.values()].filter(x=>x.vault_address===vault&&x.intent_id!==id&&statuses.includes(x.state.status));
     return{rowCount:matches.length,rows:matches.slice(0,1)};
   }
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
 const x=await repo.transition(p.intentId,evt('RISK_APPROVED',{receipt:receipt(p)}));
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
 grantLease(pool);
 await repo.transition(p.intentId,evt('RISK_APPROVED',{receipt:receipt(p)}));
 await repo.beginSubmission(p.intentId,evt('SUBMISSION_STARTED',{clientOrderId:p.clientOrderId,riskRecheckedAtMs:T}),OWNER);
 await repo.transition(p.intentId,evt('SUBMISSION_UNCERTAIN'));
 const afterRestart=new PgIntentRepository(pool);
 assert.equal((await afterRestart.get(p.intentId)).status,'UNKNOWN');
 assert.equal((await afterRestart.unresolvedForVault(VAULT)).length,1);
 await assert.rejects(afterRestart.beginSubmission(p.intentId,evt('SUBMISSION_STARTED',{clientOrderId:p.clientOrderId,riskRecheckedAtMs:T}),OWNER),/forbidden/);
});
test('PostgreSQL repository does not append event twice for duplicate fill',async()=>{
 const pool=makePool(),repo=new PgIntentRepository(pool),p=await repo.propose(source());
 grantLease(pool);
 await repo.transition(p.intentId,evt('RISK_APPROVED',{receipt:receipt(p)}));
 await repo.beginSubmission(p.intentId,evt('SUBMISSION_STARTED',{clientOrderId:p.clientOrderId,riskRecheckedAtMs:T}),OWNER);
 await repo.transition(p.intentId,evt('FILL_CONFIRMED',{fillId:'tid1',size:'0.01'}));
 const before=pool.db.events.length;
 await repo.transition(p.intentId,evt('FILL_CONFIRMED',{fillId:'tid1',size:'0.01'}));
 assert.equal(pool.db.events.length,before);assert.equal((await repo.get(p.intentId)).filledSize,'0.01');
});


test('general transition cannot mark a submission started without ownership',async()=>{
 const pool=makePool(),repo=new PgIntentRepository(pool),p=await repo.propose(source());
 await repo.transition(p.intentId,evt('RISK_APPROVED',{receipt:receipt(p)}));
 await assert.rejects(repo.transition(p.intentId,evt('SUBMISSION_STARTED',{clientOrderId:p.clientOrderId,riskRecheckedAtMs:T})),/requires beginSubmission/);
 assert.equal((await repo.get(p.intentId)).status,'APPROVED');
});
test('fenced submission requires active lease and exact writer/token',async()=>{
 const pool=makePool(),repo=new PgIntentRepository(pool),p=await repo.propose(source());
 await repo.transition(p.intentId,evt('RISK_APPROVED',{receipt:receipt(p)}));
 const event=evt('SUBMISSION_STARTED',{clientOrderId:p.clientOrderId,riskRecheckedAtMs:T});
 await assert.rejects(repo.beginSubmission(p.intentId,event,OWNER),/Lease lost/);
 grantLease(pool);
 await assert.rejects(repo.beginSubmission(p.intentId,event,{...OWNER,fencingToken:'2'}),/Lease lost/);
 await assert.rejects(repo.beginSubmission(p.intentId,event,{...OWNER,writerId:'bad-writer'}),/writer UUID/);
 await assert.rejects(repo.beginSubmission(p.intentId,event,{...OWNER,vaultAddress:'0x2222222222222222222222222222222222222222'}),/Lease lost/);
 assert.equal((await repo.beginSubmission(p.intentId,event,OWNER)).status,'SUBMITTING');
});
test('expired PostgreSQL lease refuses submission even with approved intent',async()=>{
 const pool=makePool(),repo=new PgIntentRepository(pool),p=await repo.propose(source());
 grantLease(pool);pool.db.time=T+16000;
 await repo.transition(p.intentId,evt('RISK_APPROVED',{receipt:receipt(p)}));
 await assert.rejects(repo.beginSubmission(p.intentId,evt('SUBMISSION_STARTED',{clientOrderId:p.clientOrderId,riskRecheckedAtMs:T}),OWNER),/Lease lost/);
 assert.equal((await repo.get(p.intentId)).status,'APPROVED');
});
test('DB clock rejects fabricated recent timestamps and stale approvals',async()=>{
 const pool=makePool(),repo=new PgIntentRepository(pool),p=await repo.propose(source());
 grantLease(pool);await repo.transition(p.intentId,evt('RISK_APPROVED',{receipt:receipt(p)}));
 pool.db.time+=2001;
 await assert.rejects(repo.beginSubmission(p.intentId,evt('SUBMISSION_STARTED',{clientOrderId:p.clientOrderId,riskRecheckedAtMs:T+2001}),OWNER),/stale against PostgreSQL clock/);
 const valid=evt('SUBMISSION_STARTED',{atMs:T+2001,clientOrderId:p.clientOrderId,riskRecheckedAtMs:T+2001});
 assert.equal((await repo.beginSubmission(p.intentId,valid,OWNER)).status,'SUBMITTING');
});
test('a prior unresolved order for same vault prevents starting another',async()=>{
 const pool=makePool(),repo=new PgIntentRepository(pool),first=await repo.propose(source());
 grantLease(pool);
 await repo.transition(first.intentId,evt('RISK_APPROVED',{receipt:receipt(first)}));
 await repo.beginSubmission(first.intentId,evt('SUBMISSION_STARTED',{clientOrderId:first.clientOrderId,riskRecheckedAtMs:T}),OWNER);
 const second=await repo.propose(source({fillKey:'t:43',netBefore:'0.02',netAfter:'0.04'}));
 await repo.transition(second.intentId,evt('RISK_APPROVED',{receipt:receipt(second)}));
 await assert.rejects(repo.beginSubmission(second.intentId,evt('SUBMISSION_STARTED',{clientOrderId:second.clientOrderId,riskRecheckedAtMs:T}),OWNER),/Another unresolved vault order/);
 assert.equal((await repo.get(second.intentId)).status,'APPROVED');
});
test('durable submit transition rolls back if audit insert fails',async()=>{
 const pool=makePool(),repo=new PgIntentRepository(pool),p=await repo.propose(source());
 grantLease(pool);await repo.transition(p.intentId,evt('RISK_APPROVED',{receipt:receipt(p)}));
 pool.db.failOn='INSERT INTO v2_execution_events';
 await assert.rejects(repo.beginSubmission(p.intentId,evt('SUBMISSION_STARTED',{clientOrderId:p.clientOrderId,riskRecheckedAtMs:T}),OWNER),/simulated/);
 assert.equal((await repo.get(p.intentId)).status,'APPROVED');
});
test('missing emergency control row and active HALT block submission without intent transition',async()=>{
 const pool=makePool(),repo=new PgIntentRepository(pool),p=await repo.propose(source());
 grantLease(pool);
 await repo.transition(p.intentId,evt('RISK_APPROVED',{receipt:receipt(p)}));
 const event=evt('SUBMISSION_STARTED',{clientOrderId:p.clientOrderId,riskRecheckedAtMs:T});
 pool.db.controls.delete(VAULT);
 await assert.rejects(repo.beginSubmission(p.intentId,event,OWNER),/Emergency HALT/);
 pool.db.controls.set(VAULT,{halted:true,generation:'2'});
 await assert.rejects(repo.beginSubmission(p.intentId,event,OWNER),/Emergency HALT/);
 assert.equal((await repo.get(p.intentId)).status,'APPROVED');
 pool.db.controls.set(VAULT,{halted:false,generation:'3'});
 assert.equal((await repo.beginSubmission(p.intentId,event,OWNER)).status,'SUBMITTING');
});
test('a database error reading emergency control rolls back and cannot imply permission',async()=>{
 const pool=makePool(),repo=new PgIntentRepository(pool),p=await repo.propose(source());
 grantLease(pool);
 await repo.transition(p.intentId,evt('RISK_APPROVED',{receipt:receipt(p)}));
 pool.db.failOn='FROM v2_vault_execution_controls';
 await assert.rejects(repo.beginSubmission(p.intentId,
   evt('SUBMISSION_STARTED',{clientOrderId:p.clientOrderId,riskRecheckedAtMs:T}),OWNER),/simulated PostgreSQL failure/);
 assert.equal((await repo.get(p.intentId)).status,'APPROVED');
});
