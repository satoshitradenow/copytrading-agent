import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchCompleteFillRange,PgCapturedSource} from '../src/pgSourceCapture.mjs';
const A='0x1111111111111111111111111111111111111111';
const fill=(tid,time=200,more={})=>({tid,time,coin:'BTC',side:'B',sz:'0.01',px:'50000',startPosition:'0',...more});
function mockPool(){
 const db={base:new Map(),cursor:new Map(),fills:new Map(),commits:0,rollbacks:0,failAt:null};
 const copy=val=>structuredClone(val);
 const pool={db,connect:async()=>{
  let temp;
  const client={release:()=>{},query:async(sql,p=[])=>{
   const s=sql.replace(/\s+/g,' ').trim();
   if(s.startsWith('BEGIN ')){temp={base:copy(db.base),cursor:copy(db.cursor),fills:copy(db.fills)};return{rowCount:0,rows:[]};}
   if(s==='COMMIT'){db.base=temp.base;db.cursor=temp.cursor;db.fills=temp.fills;db.commits++;temp=null;return{rowCount:0,rows:[]};}
   if(s==='ROLLBACK'){db.rollbacks++;temp=null;return{rowCount:0,rows:[]};}
   if(db.failAt&&s.includes(db.failAt))throw Error('mock DB failure');
   if(s.startsWith('INSERT INTO v2_source_baselines')){
    if(temp.base.has(p[0]))return{rowCount:0,rows:[]};temp.base.set(p[0],{start_time_ms:p[1],network:p[2]});return{rowCount:1,rows:[]};
   }
   if(s.includes('FROM v2_source_baselines')){const b=temp.base.get(p[0]);return{rowCount:b?1:0,rows:b?[copy(b)]:[]};}
   if(s.includes('FROM v2_source_cursors')){const c=temp.cursor.get(p[0]);return{rowCount:c!==undefined?1:0,rows:c!==undefined?[{through_time_ms:c}]:[]};}
   if(s.startsWith('INSERT INTO v2_source_fills')){
    const key=p[0]+'|'+p[1];if(temp.fills.has(key))return{rowCount:0,rows:[]};
    temp.fills.set(key,{fill_time_ms:p[2],coin:p[3],side:p[4],size_text:p[5],price_text:p[6],raw_fill:JSON.parse(p[7])});return{rowCount:1,rows:[]};
   }
   if(s.includes('FROM v2_source_fills')){const f=temp.fills.get(p[0]+'|'+p[1]);return{rowCount:f?1:0,rows:f?[copy(f)]:[]};}
   if(s.startsWith('UPDATE v2_source_cursors')){if(!temp.cursor.has(p[0]))return{rowCount:0,rows:[]};temp.cursor.set(p[0],p[1]);return{rowCount:1,rows:[]};}
   if(s.startsWith('INSERT INTO v2_source_cursors')){if(temp.cursor.has(p[0]))throw Error('duplicate cursor');temp.cursor.set(p[0],p[1]);return{rowCount:1,rows:[]};}
   throw Error('unsupported SQL mock '+s);
  }};return client;
 },query:async(sql,p=[])=>{
  if(sql.includes('FROM v2_source_cursors')){const c=db.cursor.get(p[0]);return{rowCount:c!==undefined?1:0,rows:c!==undefined?[{through_time_ms:c}]:[]};}
  throw Error('unexpected read');
 }};
 return pool;
}
test('Postgres capture gets complete split history rather than trusting full page',async()=>{
 const calls=[];const readPage=async (_,start,end)=>{calls.push([start,end]);if(start===100&&end===200)return[fill(1,101),fill(2,199)];return [start===100?fill(1,101):fill(2,199)];};
 const batch=await fetchCompleteFillRange({trader:A,readPage,startTimeMs:100,endTimeMs:200,pageLimit:2});
 assert.equal(batch.rows.length,2);assert.equal(calls.length,3);assert.deepEqual(batch.rows.map(x=>x.fill.fillId),['HL:1','HL:2']);
});
test('oversubscribed same-millisecond range refuses silent loss of transactions',async()=>{
 await assert.rejects(fetchCompleteFillRange({trader:A,readPage:async()=>[fill(1,200),fill(2,200)],startTimeMs:200,endTimeMs:200,pageLimit:2}),/saturation/);
});
test('source fill outside queried interval cannot be committed',async()=>{
 await assert.rejects(fetchCompleteFillRange({trader:A,readPage:async()=>[fill(3,500)],startTimeMs:100,endTimeMs:200}),/outside bounded/);
});
test('new baseline and rows and cursor commit together',async()=>{
 const pool=mockPool(),store=new PgCapturedSource({pool,trader:A,fromTimeMs:100});
 await store.initialize();const result=await store.captureUntil({throughTimeMs:200,readPage:async()=>[fill(1,150)]});
 assert.equal(result.accepted,1);assert.equal(pool.db.cursor.get(A),200);assert.equal(pool.db.fills.size,1);
 assert.equal(store.snapshot().throughTimeMs,200);
});
test('overlapping page replays are deduplicated without duplicate rows',async()=>{
 const pool=mockPool(),store=new PgCapturedSource({pool,trader:A,fromTimeMs:100});
 await store.captureUntil({throughTimeMs:200,readPage:async()=>[fill(1,150)]});
 const result=await store.captureUntil({throughTimeMs:250,readPage:async()=>[fill(1,150),fill(2,240)]});
 assert.equal(result.accepted,1);assert.equal(result.duplicates,1);assert.equal(pool.db.fills.size,2);
});
test('failed insert rolls back the cursor and all rows in the capture transaction',async()=>{
 const pool=mockPool(),store=new PgCapturedSource({pool,trader:A,fromTimeMs:100});
 await store.initialize();pool.db.failAt='INSERT INTO v2_source_cursors';
 await assert.rejects(store.captureUntil({throughTimeMs:200,readPage:async()=>[fill(1,150)]}),/mock DB failure/);
 assert.equal(pool.db.cursor.size,0);assert.equal(pool.db.fills.size,0);
 assert.equal(store.snapshot().throughTimeMs,null);
});
test('conflicting fill ID on replay is a hard rollback',async()=>{
 const pool=mockPool(),store=new PgCapturedSource({pool,trader:A,fromTimeMs:100});
 await store.captureUntil({throughTimeMs:200,readPage:async()=>[fill(1,150)]});
 await assert.rejects(store.captureUntil({throughTimeMs:250,readPage:async()=>[fill(1,150,{px:'49000'})]}),/Conflicting source transaction ID/);
 assert.equal(pool.db.cursor.get(A),200);
});
test('wrong network or baseline cannot reuse a source journal',async()=>{
 const pool=mockPool(),a=new PgCapturedSource({pool,trader:A,fromTimeMs:100,network:'mainnet'});await a.initialize();
 await assert.rejects(new PgCapturedSource({pool,trader:A,fromTimeMs:101}).initialize(),/baseline or network mismatch/);
 await assert.rejects(new PgCapturedSource({pool,trader:A,fromTimeMs:100,network:'testnet'}).initialize(),/baseline or network mismatch/);
});
test('persistent cursor recovers after new process without reprocessing its baseline',async()=>{
 const pool=mockPool(),old=new PgCapturedSource({pool,trader:A,fromTimeMs:100});
 await old.captureUntil({throughTimeMs:200,readPage:async()=>[fill(1,150)]});
 const restart=new PgCapturedSource({pool,trader:A,fromTimeMs:100});await restart.initialize();
 assert.equal(restart.snapshot().throughTimeMs,200);
 const r=await restart.captureUntil({throughTimeMs:250,readPage:async()=>[fill(1,150)]});
 assert.equal(r.accepted,0);assert.equal(pool.db.cursor.get(A),250);
});
test('too-long backfill or an older end time refuses to claim completeness',async()=>{
 const pool=mockPool(),store=new PgCapturedSource({pool,trader:A,fromTimeMs:100,maxBackfillGapMs:60000});
 await assert.rejects(store.captureUntil({throughTimeMs:100000,readPage:async()=>[]}),/history gap/);
 await store.captureUntil({throughTimeMs:200,readPage:async()=>[]});
 await assert.rejects(store.captureUntil({throughTimeMs:199,readPage:async()=>[]}),/backward/);
});