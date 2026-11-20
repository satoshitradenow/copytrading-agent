import test from 'node:test';
import assert from 'node:assert/strict';
import {PgVaultWriterLease} from '../src/pgVaultWriterLease.mjs';

const VAULT='0x1234567890abcdef1234567890abcdef12345678';
const A='17fa2a6a-c4c5-47f4-b232-a11234567890';
const B='5c221fa9-1e4e-4af8-8c16-b11234567890';
const clone=x=>structuredClone(x);

/** Scoped deterministic SQL fake: does NOT claim real-Postgres integration. */
function mockPool(){
 const db={leases:new Map(),unresolved:new Set(),pendingBatches:new Set(),time:Date.parse('2026-11-19T10:00:00.000Z'),commits:0,rollbacks:0,failOn:null};
 function leaseRow(row){return row?{...clone(row),expires_at:new Date(row.expires_at),expired:row.expires_at<=db.time}:null;}
 const pool={db,connect:async()=>{
   let stage=null;
   const c={release:()=>{},query:async(query,args=[])=>{
     const q=query.replace(/\s+/g,' ').trim();
     if(q.startsWith('BEGIN ')) {stage=new Map([...db.leases].map(([k,v])=>[k,clone(v)]));return {rowCount:0,rows:[]};}
     if(q==='COMMIT'){db.leases=stage;db.commits++;stage=null;return{rowCount:0,rows:[]};}
     if(q==='ROLLBACK'){stage=null;db.rollbacks++;return{rowCount:0,rows:[]};}
     if(!stage)throw Error('Query outside transaction');
     if(db.failOn&&q.includes(db.failOn))throw Error('Simulated PostgreSQL failure');
     if(q.startsWith('SELECT vault_address')&&q.includes('AS expired')){
       const row=leaseRow(stage.get(args[0]));return{rowCount:row?1:0,rows:row?[row]:[]};
     }
     if(q.startsWith('SELECT intent_id FROM v2_execution_intents')){
       return{rowCount:db.unresolved.has(args[0])?1:0,rows:db.unresolved.has(args[0])?[{intent_id:'pending'}]:[]};
     }
     if(q.startsWith('SELECT batch_id FROM v2_portfolio_batches')){
       return{rowCount:db.pendingBatches.has(args[0])?1:0,
        rows:db.pendingBatches.has(args[0])?[{batch_id:'f'.repeat(64)}]:[]};
     }
     if(q.startsWith('INSERT INTO v2_vault_writer_leases')){
       const [vault_address,writer_id,ttl]=args;
       if(stage.has(vault_address))return{rowCount:0,rows:[]};
       const row={vault_address,writer_id,fencing_token:'1',expires_at:db.time+ttl};
       stage.set(vault_address,row);return{rowCount:1,rows:[leaseRow(row)]};
     }
     if(q.startsWith('UPDATE v2_vault_writer_leases')&&q.includes('fencing_token=fencing_token+1')){
       const [vault_address,writer_id,ttl,prev]=args;
       const row=stage.get(vault_address);
       if(!row||row.fencing_token!==String(prev))return{rowCount:0,rows:[]};
       const next={...row,writer_id,fencing_token:String(BigInt(prev)+1n),expires_at:db.time+ttl};
       stage.set(vault_address,next);return{rowCount:1,rows:[leaseRow(next)]};
     }
     if(q.startsWith('UPDATE v2_vault_writer_leases')&&q.includes('SET expires_at=clock_timestamp()+')){
       const [vault_address,writer_id,token,ttl]=args;
       const row=stage.get(vault_address);
       if(!row||row.writer_id!==writer_id||row.fencing_token!==String(token)||row.expires_at<=db.time)return{rowCount:0,rows:[]};
       const next={...row,expires_at:db.time+ttl};stage.set(vault_address,next);
       return{rowCount:1,rows:[leaseRow(next)]};
     }
     if(q.startsWith('SELECT vault_address')&&q.includes('FOR UPDATE')){
       const [vault_address,writer_id,token]=args;
       const row=stage.get(vault_address);
       const ok=row&&row.writer_id===writer_id&&row.fencing_token===String(token)&&row.expires_at>db.time;
       return{rowCount:ok?1:0,rows:ok?[leaseRow(row)]:[]};
     }
     if(q.startsWith('UPDATE v2_vault_writer_leases')&&q.includes('SET expires_at=clock_timestamp(),')){
       const [vault_address,writer_id,token]=args,row=stage.get(vault_address);
       if(!row||row.writer_id!==writer_id||row.fencing_token!==String(token)||row.expires_at<=db.time)return{rowCount:0,rows:[]};
       stage.set(vault_address,{...row,expires_at:db.time});return{rowCount:1,rows:[{vault_address}]};
     }
     throw Error('Unexpected SQL: '+q.slice(0,125));
   }};return c;
 }};
 return pool;
}
function args(writerId=A){return {vaultAddress:VAULT,writerId,ttlMs:15000};}

test('first acquisition creates owner with persistent token 1 and database expiry',async()=>{
 const p=mockPool(),repo=new PgVaultWriterLease(p),r=await repo.acquire(args());
 assert.equal(r.writerId,A);assert.equal(r.vaultAddress,VAULT);assert.equal(r.fencingToken,'1');
 assert.equal(r.expiresAt,'2026-11-19T10:00:15.000Z');assert.equal(p.db.commits,1);
});
test('a second process or reused writer ID cannot re-acquire an active vault',async()=>{
 const repo=new PgVaultWriterLease(mockPool());await repo.acquire(args());
 await assert.rejects(repo.acquire(args(B)),/already has an unexpired writer/);
 await assert.rejects(repo.acquire(args(A)),/already has an unexpired writer/);
});
test('renewal uses DB time and preserves fencing token',async()=>{
 const p=mockPool(),repo=new PgVaultWriterLease(p),old=await repo.acquire(args());
 p.db.time+=8000;
 const newLease=await repo.renew({...args(),fencingToken:old.fencingToken});
 assert.equal(newLease.fencingToken,old.fencingToken);
 assert.equal(newLease.expiresAt,'2026-11-19T10:00:23.000Z');
});
test('lease expires even if caller local clock could differ',async()=>{
 const p=mockPool(),repo=new PgVaultWriterLease(p),old=await repo.acquire(args());p.db.time+=15001;
 await assert.rejects(repo.renew({...args(),fencingToken:old.fencingToken}),/expired or lost/);
 await assert.rejects(repo.assertActive({...args(),fencingToken:old.fencingToken}),/Stale writer/);
});
test('takeover after expiry increments token and invalidates stale owner',async()=>{
 const p=mockPool(),repo=new PgVaultWriterLease(p),old=await repo.acquire(args());p.db.time+=20000;
 const replacement=await repo.acquire(args(B));
 assert.equal(replacement.fencingToken,'2');
 await assert.rejects(repo.renew({...args(A),fencingToken:old.fencingToken}),/expired or lost/);
 await assert.rejects(repo.release({...args(A),fencingToken:old.fencingToken}),/Stale writer/);
 assert.equal((await repo.assertActive({...args(B),fencingToken:replacement.fencingToken})).writerId,B);
});
test('unresolved exchange intent refuses new initial writer lease',async()=>{
 const p=mockPool(),repo=new PgVaultWriterLease(p);p.db.unresolved.add(VAULT);
 await assert.rejects(repo.acquire(args()),/Unresolved exchange intent/);
 assert.equal(p.db.leases.size,0);
});
test('expired writer cannot be replaced while any exchange result is uncertain',async()=>{
 const p=mockPool(),repo=new PgVaultWriterLease(p),old=await repo.acquire(args());
 p.db.time+=22000;p.db.unresolved.add(VAULT);
 await assert.rejects(repo.acquire(args(B)),/Unresolved exchange intent/);
 assert.equal(p.db.leases.get(VAULT).fencing_token,'1');
 p.db.unresolved.delete(VAULT);
 assert.equal((await repo.acquire(args(B))).fencingToken,'2');
});
test('release expires lease but never resets fencing generation',async()=>{
 const p=mockPool(),repo=new PgVaultWriterLease(p),a=await repo.acquire(args());
 assert.equal(await repo.release({...args(),fencingToken:a.fencingToken}),true);
 const b=await repo.acquire(args(B));assert.equal(b.fencingToken,'2');
 await assert.rejects(repo.assertActive({...args(A),fencingToken:a.fencingToken}),/Stale writer/);
});
test('lease operations reject invalid IDs, token, TTL and addresses',async()=>{
 const repo=new PgVaultWriterLease(mockPool());
 await assert.rejects(repo.acquire({...args(),writerId:'old-server'}),/writerId/);
 await assert.rejects(repo.acquire({...args(),ttlMs:300000}),/TTL/);
 await assert.rejects(repo.acquire({...args(),vaultAddress:'BTC'}),/address/i);
 await assert.rejects(repo.renew({...args(),fencingToken:'0'}),/fencing token/);
 await assert.rejects(repo.assertActive({...args(),fencingToken:'18446744073709551615'}),/fencing token/);
});
test('failed DB query causes transaction rollback without partial owner change',async()=>{
 const p=mockPool(),repo=new PgVaultWriterLease(p),old=await repo.acquire(args());p.db.time+=15001;
 p.db.failOn='UPDATE v2_vault_writer_leases';
 await assert.rejects(repo.acquire(args(B)),/Simulated PostgreSQL failure/);
 assert.equal(p.db.leases.get(VAULT).fencing_token,old.fencingToken);
 assert.equal(p.db.rollbacks,1);
});
test('old owner cannot release or renew a freshly reacquired lease',async()=>{
 const p=mockPool(),repo=new PgVaultWriterLease(p),first=await repo.acquire(args());
 p.db.time+=15001;const second=await repo.acquire(args(B));
 await assert.rejects(repo.release({...args(A),fencingToken:first.fencingToken}),/Stale writer/);
 assert.equal(p.db.leases.get(VAULT).writer_id,B);
 assert.equal((await repo.renew({...args(B),fencingToken:second.fencingToken})).fencingToken,'2');
});
test('no lease is silently granted after database failure during unresolved check',async()=>{
 const p=mockPool(),repo=new PgVaultWriterLease(p);p.db.failOn='SELECT intent_id FROM v2_execution_intents';
 await assert.rejects(repo.acquire(args()),/Simulated PostgreSQL failure/);
 assert.equal(p.db.leases.size,0);assert.equal(p.db.rollbacks,1);
});
test('a STAGED source batch blocks lease takeover even with no execution intent',async()=>{
 const p=mockPool(),repo=new PgVaultWriterLease(p);
 const first=await repo.acquire(args());
 p.db.time+=20000;
 p.db.pendingBatches.add(VAULT);
 await assert.rejects(repo.acquire(args(B)),/Pending source batch blocks writer takeover/);
 assert.equal(p.db.leases.get(VAULT).fencing_token,first.fencingToken);
 p.db.pendingBatches.delete(VAULT);
 const replacement=await repo.acquire(args(B));
 assert.equal(replacement.fencingToken,'2');
});
test('initial lease acquisition is blocked by any existing staged source batch',async()=>{
 const p=mockPool(),repo=new PgVaultWriterLease(p);
 p.db.pendingBatches.add(VAULT);
 await assert.rejects(repo.acquire(args()),/Pending source batch/);
 assert.equal(p.db.leases.size,0);
});
test('a missing pending-batch table or DB outage cannot grant a new writer',async()=>{
 const p=mockPool(),repo=new PgVaultWriterLease(p);
 p.db.failOn='SELECT batch_id FROM v2_portfolio_batches';
 await assert.rejects(repo.acquire(args()),/Simulated PostgreSQL failure/);
 assert.equal(p.db.leases.size,0);
 assert.equal(p.db.rollbacks,1);
});
test('FILLED remains unresolved until portfolio reconciliation; no lease takeover',async()=>{
 const p=mockPool(),repo=new PgVaultWriterLease(p);
 const first=await repo.acquire(args());
 p.db.time+=20000;
 p.db.unresolved.add(VAULT);
 await assert.rejects(repo.acquire(args(B)),/Unresolved exchange intent/);
 assert.equal(p.db.leases.get(VAULT).fencing_token,first.fencingToken);
});
