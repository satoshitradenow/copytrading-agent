import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonlJournal} from '../src/jsonlJournal.mjs';
import {CapturedSource,normalizeSourceFill} from '../src/sourceCapture.mjs';
import {readSourceFillsByTime} from '../src/hyperliquidRead.mjs';
const A='0x1111111111111111111111111111111111111111';
const B='0x2222222222222222222222222222222222222222';
const base=1_800_000_000_000;
const source={trader:A,fromTimeMs:base};
const raw=(n,time=base+n,overrides={})=>({tid:n, time, coin:'BTC',px:'50000.1',sz:'0.01',side:'B',startPosition:'0',oid:48,...overrides});
const mem=()=>{let rows=[];return {readAll:()=>structuredClone(rows),append:(r)=>rows.push(structuredClone(r)),get records(){return rows;}};};
const mk=()=>({source,journal:mem()});

const apiFrom=(rows,requests)=>async (trader,start,end)=>{
  requests.push({trader,start,end});
  return rows.filter(r=>r.time>=start&&r.time<=end);
};

test('normalize preserves exchange tid, direction, positions, and never invents historical equity',()=>{
  const r=normalizeSourceFill(A,raw(17,base+17,{side:'A',startPosition:'-1.5'}));
  assert.deepEqual({id:r.fillId,side:r.side,before:r.sourceStartPosition,coin:r.coin},{id:'HL:17',side:'sell',before:'-1.5',coin:'BTC'});
  assert.equal(r.sourceEquityUsd,undefined);
  assert.throws(()=>normalizeSourceFill(A,raw(1,base+1,{tid:1.4})),/tid/);
  assert.throws(()=>normalizeSourceFill(A,raw(1,base+1,{side:'SELL'})),/side/);
  assert.throws(()=>normalizeSourceFill(A,raw(1,base+1,{px:'NaN'})),/fill price/);
});

test('captures a complete interval, writes checkpoint last, and dedupes inclusive overlap',async()=>{
  const opts=mk();const calls=[];
  const x=new CapturedSource(opts);
  let r=await x.captureUntil({readPage:apiFrom([raw(1),raw(2)],calls),throughTimeMs:base+5});
  assert.equal(r.accepted,2);
  assert.equal(r.duplicates,0);
  assert.equal(opts.journal.records[0].kind,'baseline');
  assert.equal(opts.journal.records.at(-1).kind,'checkpoint');
  r=await x.captureUntil({readPage:apiFrom([raw(1),raw(2),raw(3,base+6)],calls),throughTimeMs:base+10});
  assert.equal(r.accepted,1);
  assert.equal(r.duplicates,2);
  assert.equal(x.snapshot().observedFillCount,3);
  assert.equal(calls[1].start,base);
  assert.equal(opts.journal.records.filter(a=>a.kind==='fill').length,3);
});

test('at the response cap it splits timestamp ranges rather than silently losing fills',async()=>{
  const opts=mk();const calls=[];const x=new CapturedSource(opts);
  const rows=Array.from({length:9},(_,i)=>raw(i+1,base+Math.floor(i/2)));
  const r=await x.captureUntil({
    readPage:async(a,s,e)=>{calls.push([s,e]);return rows.filter(v=>v.time>=s&&v.time<=e).slice(0,3);},
    throughTimeMs:base+10,pageLimit:3,maxRequests:40
  });
  assert.equal(r.accepted,9);
  assert.ok(r.requests>3);
  assert.equal(x.snapshot().observedFillCount,9);
  assert.equal(x.snapshot().throughTimeMs,base+10);
});

test('too many fills in the same millisecond fails closed without advancing checkpoint',async()=>{
  const opts=mk();const x=new CapturedSource(opts);
  const rows=[raw(1,base+1),raw(2,base+1),raw(3,base+1),raw(4,base+1)];
  await assert.rejects(x.captureUntil({readPage:async(a,s,e)=>rows.filter(v=>v.time>=s&&v.time<=e).slice(0,2),throughTimeMs:base+2,pageLimit:2}),/timestamp/);
  assert.equal(x.snapshot().throughTimeMs,null);
  assert.equal(opts.journal.records.some(r=>r.kind==='checkpoint'),false);
});

test('source HTTP error after partial journal writing leaves no checkpoint; restart safely replays',async()=>{
  const path=join(mkdtempSync(join(tmpdir(),'hl-cap-')),'raw.jsonl');
  const make=()=>new CapturedSource({source,journal:new JsonlJournal(path)});
  const first=make();
  let count=0;
  const rows=[raw(1,base+1),raw(2,base+4)];
  await assert.rejects(first.captureUntil({pageLimit:2,throughTimeMs:base+8,readPage:async(a,s,e)=>{
    if(++count>2)throw new Error('transient HTTP failure');
    return rows.filter(r=>r.time>=s&&r.time<=e).slice(0,2);
  }}),/HTTP failure/);
  assert.equal(first.snapshot().throughTimeMs,null);
  const second=make();
  const result=await second.captureUntil({pageLimit:2,throughTimeMs:base+8,readPage:async(a,s,e)=>rows.filter(r=>r.time>=s&&r.time<=e).slice(0,2)});
  assert.equal(result.total,2);
  assert.equal(second.snapshot().throughTimeMs,base+8);
  assert.equal(readFileSync(path,'utf8').trim().split('\n').filter(x=>JSON.parse(x).kind==='fill').length,2);
});

test('wrong source or different baseline cannot reuse journal',()=>{
  const opts=mk();new CapturedSource(opts);
  assert.throws(()=>new CapturedSource({source:{trader:B,fromTimeMs:base},journal:opts.journal}),/Incompatible/);
  assert.throws(()=>new CapturedSource({source:{trader:A,fromTimeMs:base+1},journal:opts.journal}),/Incompatible/);
});

test('unexpected fill fields, times, unsafe trade IDs fail without checkpoint',async()=>{
  const opts=mk();const x=new CapturedSource(opts);
  await assert.rejects(x.captureUntil({throughTimeMs:base+5,readPage:async()=>[raw(1,base-1)]}),/outside requested range/);
  await assert.rejects(x.captureUntil({throughTimeMs:base+5,readPage:async()=>[raw(1,base+1,{tid:Number.MAX_SAFE_INTEGER+3})]}),/Unsafe/);
  assert.equal(x.snapshot().throughTimeMs,null);
});

test('a failing journal append never marks a captured fill as saved',async()=>{
  let rows=[];
  const journal={readAll:()=>[...rows],append:r=>{if(r.kind==='fill')throw new Error('disk failure');rows.push(r)}};
  const x=new CapturedSource({source,journal});
  await assert.rejects(x.captureUntil({throughTimeMs:base+5,readPage:async()=>[raw(1)]}),/disk failure/);
  assert.equal(x.snapshot().observedFillCount,0);
  assert.equal(x.snapshot().throughTimeMs,null);
});

test('corrupted/truncated raw journal fails closed',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'hl-cap-')),'raw.jsonl');
  writeFileSync(path,'{"kind":"fill"');
  assert.throws(()=>new CapturedSource({source,journal:new JsonlJournal(path)}),/Truncated/);
});

test('read-only time query uses Hyperliquid info body and never /exchange',async()=>{
  const calls=[];
  const fetchImpl=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>[]}};
  assert.deepEqual(await readSourceFillsByTime(A,base,base+100,{fetchImpl}),[]);
  assert.equal(calls[0].url,'https://api.hyperliquid.xyz/info');
  assert.deepEqual(calls[0].body,{type:'userFillsByTime',user:A,startTime:base,endTime:base+100,aggregateByTime:false});
  await assert.rejects(readSourceFillsByTime(A,base+100,base,{fetchImpl}),/time range/);
});

test('same fill ID returning different economics fails closed, not silent deduplication',async()=>{
  const c=new CapturedSource(mk());
  await c.captureUntil({throughTimeMs:base+5,readPage:async()=>[raw(1)]});
  await assert.rejects(c.captureUntil({throughTimeMs:base+6,readPage:async()=>[raw(1,base+1,{sz:'99'})]}),/Conflicting replay/);
  assert.equal(c.snapshot().throughTimeMs,base+5);
});

test('read-only position audit exposes pre-existing source positions',async()=>{
  const a=new CapturedSource(mk());
  await a.captureUntil({throughTimeMs:base+4,readPage:async()=>[
    raw(1,base+1,{startPosition:'2',side:'A',sz:'1'}),
    raw(2,base+2,{startPosition:'1',side:'A',sz:'1'}),
  ]});
  const audit=a.auditPositionContinuity();
  assert.equal(audit.verifiedFromFlatStart,false);
  assert.equal(audit.gaps[0].reason,'missing baseline or continuity gap');
});

test('read-only position audit verifies contiguous flat-start fills',async()=>{
  const a=new CapturedSource(mk());
  await a.captureUntil({throughTimeMs:base+4,readPage:async()=>[
    raw(1,base+1,{startPosition:'0',sz:'1'}),
    raw(2,base+2,{startPosition:'1',side:'A',sz:'0.5'}),
    raw(3,base+3,{startPosition:'0.5',side:'A',sz:'0.5'}),
  ]});
  assert.equal(a.auditPositionContinuity().verifiedFromFlatStart,true);
});

test('simultaneous capture attempts for a single writer fail',async()=>{
  const a=new CapturedSource(mk());
  let resume;const wait=new Promise(resolve=>resume=resolve);
  const pending=a.captureUntil({throughTimeMs:base+4,readPage:()=>wait});
  await assert.rejects(a.captureUntil({throughTimeMs:base+4,readPage:async()=>[]}),/Concurrent/);
  resume([]);
  await pending;
});

test('fills sharing one millisecond follow numeric transaction IDs, not lexicographic strings',async()=>{
  const c=new CapturedSource(mk());
  await c.captureUntil({throughTimeMs:base+2,readPage:async()=>[
    raw(10,base+1,{startPosition:'1',side:'A',sz:'1'}),
    raw(2,base+1,{startPosition:'0',side:'B',sz:'1'}),
  ]});
  assert.equal(c.auditPositionContinuity().verifiedFromFlatStart,true);
});