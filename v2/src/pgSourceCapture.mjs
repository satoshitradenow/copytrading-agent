/**
 * PostgreSQL-backed READ-ONLY Hyperliquid source fill capture.
 * Each bounded /info API batch commits fills + the associated cursor in one
 * transaction. Never submits orders or infers historical source equity.
 *
 * Requires the 001_shadow_ingestion.sql schema and a compatible pg Pool.
 * Concurrent workers may fetch simultaneously; baseline-row FOR UPDATE and
 * uniqueness checks serialize DB writes, and a stale checkpoint cannot rewind.
 */
import { validateAddress } from './hyperliquidRead.mjs';
import { normalizeSourceFill } from './sourceCapture.mjs';

const integer=(value,name)=>{if(!Number.isSafeInteger(value)||value<0)throw Error(`${name} must be a safe nonnegative integer`);return value;};
const eq=(a,b)=>a.trader===b.trader&&a.fillId===b.fillId&&a.timeMs===b.timeMs&&a.coin===b.coin&&a.side===b.side&&a.size===b.size&&a.priceUsd===b.priceUsd&&a.sourceStartPosition===b.sourceStartPosition;
function compare(a,b){if(a.fill.timeMs!==b.fill.timeMs)return a.fill.timeMs-b.fill.timeMs;const av=BigInt(a.fill.fillId.slice(3)),bv=BigInt(b.fill.fillId.slice(3));return av<bv?-1:av>bv?1:0;}
async function transactional(pool,fn){
 const c=await pool.connect();
 try{await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');const val=await fn(c);await c.query('COMMIT');return val;}
 catch(e){try{await c.query('ROLLBACK');}catch{}throw e;}
 finally{c.release();}
}
/** Retains proof of API completeness or refuses to return a partial interval. */
export async function fetchCompleteFillRange({trader,readPage,startTimeMs,endTimeMs,pageLimit=2000,maxRequests=1500}){
 const v=validateAddress(trader);
 integer(startTimeMs,'startTimeMs');integer(endTimeMs,'endTimeMs');
 if(endTimeMs<startTimeMs||typeof readPage!=='function')throw Error('Invalid bounded source query');
 if(!Number.isSafeInteger(pageLimit)||pageLimit<2||pageLimit>2000)throw Error('Invalid page cap');
 if(!Number.isSafeInteger(maxRequests)||maxRequests<1)throw Error('Invalid request budget');
 const ranges=[[startTimeMs,endTimeMs]],seen=new Map();let requests=0;
 while(ranges.length){
  const [start,end]=ranges.pop();if(++requests>maxRequests)throw Error('Source fill request budget exceeded; incomplete history');
  const rows=await readPage(v,start,end);
  if(!Array.isArray(rows)||rows.length>pageLimit)throw Error('Invalid or over-cap fill page; no checkpoint');
  if(rows.length===pageLimit){
   if(start===end)throw Error('Unrecoverable same-millisecond fill-page saturation; no checkpoint');
   const mid=start+Math.floor((end-start)/2);
   ranges.push([mid+1,end],[start,mid]);continue;
  }
  for(const raw of rows){
   const fill=normalizeSourceFill(v,raw);
   if(fill.timeMs<start||fill.timeMs>end)throw Error('Source fill outside bounded interval');
   const prev=seen.get(fill.fillId);
   if(prev){if(!eq(prev.fill,fill))throw Error('Conflicting same-ID source fills');continue;}
   seen.set(fill.fillId,{fill,raw});
  }
 }
 return {trader:v,fromTimeMs:startTimeMs,throughTimeMs:endTimeMs,requests,rows:[...seen.values()].sort(compare)};
}

export class PgCapturedSource {
 constructor({pool,trader,fromTimeMs,network='mainnet',overlapMs=120_000,maxBackfillGapMs=570_000}){
  if(!pool||typeof pool.connect!=='function'||typeof pool.query!=='function')throw Error('PostgreSQL pool required');
  this.pool=pool;this.trader=validateAddress(trader);this.fromTimeMs=integer(fromTimeMs,'baseline timestamp');
  if(this.fromTimeMs===0)throw Error('Invalid zero baseline');
  if(!['mainnet','testnet'].includes(network))throw Error('Invalid network');
  this.network=network;this.overlapMs=integer(overlapMs,'overlapMs');this.maxBackfillGapMs=integer(maxBackfillGapMs,'maxBackfillGapMs');
  if(overlapMs>86_400_000||maxBackfillGapMs<60_000)throw Error('Unsafe capture windows');
  this.throughTimeMs=null;this.initialized=false;this.inCapture=false;
 }
 async initialize(){
  if(this.initialized)return;
  await transactional(this.pool,async c=>{
   await c.query(`INSERT INTO v2_source_baselines (trader_address,start_time_ms,network)
     VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[this.trader,this.fromTimeMs,this.network]);
   const b=await c.query(`SELECT start_time_ms,network FROM v2_source_baselines
     WHERE trader_address=$1 FOR UPDATE`,[this.trader]);
   if(b.rows.length!==1||Number(b.rows[0].start_time_ms)!==this.fromTimeMs||b.rows[0].network!==this.network)
     throw Error('Existing source baseline or network mismatch; fail closed');
   const cur=await c.query(`SELECT through_time_ms FROM v2_source_cursors WHERE trader_address=$1`,[this.trader]);
   this.throughTimeMs=cur.rows.length?Number(cur.rows[0].through_time_ms):null;
  });
  this.initialized=true;
 }
 snapshot(){return{mode:'READ_ONLY_PG',trader:this.trader,fromTimeMs:this.fromTimeMs,throughTimeMs:this.throughTimeMs};}
 async captureUntil({readPage,throughTimeMs,pageLimit=2000,maxRequests=1500}){
  if(this.inCapture)throw Error('Concurrent capture blocked for this source');
  this.inCapture=true;
  try{
   await this.initialize();integer(throughTimeMs,'capture endpoint');
   if(throughTimeMs<this.fromTimeMs||this.throughTimeMs!==null&&throughTimeMs<this.throughTimeMs)
     throw Error('Capture would move cursor backward');
   const previous=this.throughTimeMs??this.fromTimeMs;
   if(throughTimeMs-previous>this.maxBackfillGapMs)throw Error('Unverified long source history gap; fail closed');
   const start=Math.max(this.fromTimeMs,previous-this.overlapMs);
   const batch=await fetchCompleteFillRange({trader:this.trader,readPage,startTimeMs:start,endTimeMs:throughTimeMs,pageLimit,maxRequests});
   // All DB writes, including cursor progress, happen in the same transaction.
   // Locking the baseline row serializes concurrent commits for this trader.
   const saved=await transactional(this.pool,async c=>{
    const baseline=await c.query(`SELECT start_time_ms,network FROM v2_source_baselines
      WHERE trader_address=$1 FOR UPDATE`,[this.trader]);
    if(baseline.rows.length!==1||Number(baseline.rows[0].start_time_ms)!==this.fromTimeMs||baseline.rows[0].network!==this.network)
      throw Error('Source baseline changed during capture; fail closed');
    const cr=await c.query(`SELECT through_time_ms FROM v2_source_cursors WHERE trader_address=$1 FOR UPDATE`,[this.trader]);
    const cursor=cr.rows.length?Number(cr.rows[0].through_time_ms):null;
    if(cursor!==null && cursor>throughTimeMs)throw Error('Concurrent worker already advanced beyond this batch; re-read before retry');
    if(cursor!==null && cursor<this.fromTimeMs)throw Error('Corrupt saved source cursor');
    let inserted=0,duplicates=0;
    for(const {fill,raw} of batch.rows){
     const key=fill.fillId.slice(3);
     const ins=await c.query(`INSERT INTO v2_source_fills
       (trader_address,fill_tid,fill_time_ms,coin,side,size_text,price_text,raw_fill)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT (trader_address,fill_tid) DO NOTHING`,[
        this.trader,key,fill.timeMs,fill.coin,raw.side,fill.size,fill.priceUsd,JSON.stringify(raw)]);
     if(ins.rowCount===1){inserted++;continue;}
     const old=await c.query(`SELECT fill_time_ms,coin,side,size_text,price_text,raw_fill
       FROM v2_source_fills WHERE trader_address=$1 AND fill_tid=$2`,[this.trader,key]);
     if(old.rows.length!==1)throw Error('Source fill uniqueness conflict without stored row');
     const r=old.rows[0];
     const prev=normalizeSourceFill(this.trader,r.raw_fill);
     if(!eq(prev,fill)||Number(r.fill_time_ms)!==fill.timeMs||r.coin!==fill.coin||r.side!==raw.side||r.size_text!==fill.size||r.price_text!==fill.priceUsd)
       throw Error('Conflicting source transaction ID in Postgres; rollback entire batch');
     duplicates++;
    }
    if(cr.rows.length){
     const up=await c.query(`UPDATE v2_source_cursors SET through_time_ms=$2,updated_at=now()
       WHERE trader_address=$1`,[this.trader,throughTimeMs]);
     if(up.rowCount!==1)throw Error('Lost cursor during update');
    }else{
     const up=await c.query(`INSERT INTO v2_source_cursors(trader_address,through_time_ms)
       VALUES ($1,$2)`,[this.trader,throughTimeMs]);
     if(up.rowCount!==1)throw Error('Cannot persist new checkpoint');
    }
    return{inserted,duplicates};
   });
   this.throughTimeMs=throughTimeMs;
   return{mode:'READ_ONLY_PG',trader:this.trader,startTimeMs:start,throughTimeMs,requests:batch.requests,accepted:saved.inserted,duplicates:saved.duplicates};
  }finally{this.inCapture=false;}
 }
}