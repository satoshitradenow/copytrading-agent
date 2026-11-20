import test from 'node:test';
import assert from 'node:assert/strict';
import {ReadOnlyFillMonitor} from '../src/readOnlyMonitor.mjs';
const A='0x1111111111111111111111111111111111111111';
const t=1_800_000_000_000;
class FakeWS {
  constructor(){this.handlers=new Map();this.sent=[];this.closed=false;}
  addEventListener(name,handler){this.handlers.set(name,handler);}
  send(raw){this.sent.push(JSON.parse(raw));}
  emit(name,event={}){this.handlers.get(name)?.(event);}
  close(){this.closed=true;}
}
const setup=(overrides={})=>{
  const ws=new FakeWS();const calls=[];
  const monitor=new ReadOnlyFillMonitor({trader:A,clock:()=>t,
    readPage:async()=>[],capture:{captureUntil:async a=>{calls.push(a.throughTimeMs);return {mode:'READ_ONLY',accepted:0}}},
    wsFactory:()=>ws,intervalMs:600000,onReport:()=>{},...overrides});
  return {monitor,ws,calls};
};
const drain=()=>new Promise(resolve=>setImmediate(resolve));

test('monitor starts with read-only REST capture and subscribes to the intended trader',async()=>{
  const {monitor,ws,calls}=setup();
  await monitor.start();ws.emit('open');await drain();
  assert.equal(ws.sent[0].method,'subscribe');
  assert.deepEqual(ws.sent[0].subscription,{type:'userFills',user:A});
  assert.ok(calls.length>=1);
  assert.equal(calls[0],t-10000);
  monitor.stop();assert.equal(ws.closed,true);
});

test('WS leader fill is a wakeup only; raw snapshot does not produce orders',async()=>{
  const {monitor,ws,calls}=setup();await monitor.start();
  const prior=calls.length;
  ws.emit('message',{data:JSON.stringify({channel:'userFills',data:{user:A,isSnapshot:true,fills:[{tid:1}]}})});
  await drain();
  assert.ok(calls.length>prior);
  assert.equal(monitor.status().mode,'READ_ONLY');
  monitor.stop();
});

test('concurrent fill notifications never overlap a canonical capture',async()=>{
  let active=0,peak=0,calls=0;let finish;
  const blocker=new Promise(resolve=>finish=resolve);
  const {monitor,ws}=setup({capture:{captureUntil:async()=>{
    active++;peak=Math.max(peak,active);calls++;await blocker;active--;return {mode:'READ_ONLY'};
  }}});
  const start=monitor.start();await drain();
  ws.emit('message',{data:JSON.stringify({channel:'userFills',data:{user:A}})});
  ws.emit('message',{data:JSON.stringify({channel:'userFills',data:{user:A}})});
  finish();await start;await drain();
  assert.equal(peak,1);
  assert.equal(calls,2);
  monitor.stop();
});

test('REST capture error halts the monitor, rather than continuing after unknown gaps',async()=>{
  const err=new Error('HTTP 429');let notified=null;
  const {monitor,ws}=setup({capture:{captureUntil:async()=>{throw err}},onError:e=>notified=e});
  await assert.rejects(monitor.start(),/429/);
  assert.equal(monitor.status().halted,true);
  assert.equal(notified,err);
  assert.equal(ws.closed,true);
});

test('wrong WS user identity halts the monitor rather than copying another account',async()=>{
  let error;
  const {monitor,ws}=setup({onError:e=>error=e});await monitor.start();
  ws.emit('message',{data:JSON.stringify({channel:'userFills',data:{user:'0x2222222222222222222222222222222222222222'}})});
  assert.equal(monitor.status().halted,true);
  assert.match(error.message,/Unexpected source/);
});

test('monitor cannot be started twice and stop tears down its connections',async()=>{
  const {monitor,ws}=setup();await monitor.start();await assert.rejects(monitor.start(),/already started/);
  monitor.stop();assert.equal(ws.closed,true);assert.equal(monitor.status().started,false);
});

test('monitor refuses long unattended gaps instead of assuming old fills are complete',async()=>{
  const {monitor}=setup({capture:{snapshot:()=>({fromTimeMs:t-800000,throughTimeMs:null}),captureUntil:async()=>{throw Error('should not call');}}});
  await assert.rejects(monitor.start(),/Capture gap too large/);
  assert.equal(monitor.status().halted,true);
});

test('testnet WebSocket monitor never listens to mainnet',async()=>{
 const {ReadOnlyFillMonitor}=await import('../src/readOnlyMonitor.mjs');
 const trader='0x1111111111111111111111111111111111111111';
 let url=null;
 const monitor=new ReadOnlyFillMonitor({trader,network:'testnet',
  capture:{captureUntil:async()=>({}),snapshot:()=>({fromTimeMs:1800000000000})},
  readPage:async()=>[],wsFactory:u=>{url=u;return {addEventListener(){},close(){}};},
  clock:()=>1800000002000,intervalMs:1000,backfillDelayMs:1000});
 await monitor.start();monitor.stop();
 assert.equal(url,'wss://api.hyperliquid-testnet.xyz/ws');
 assert.throws(()=>new ReadOnlyFillMonitor({trader,network:'unsupported',capture:{captureUntil:()=>{}},readPage:async()=>[]}),/network/);
});