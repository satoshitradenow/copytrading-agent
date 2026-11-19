/**
 * Read-only Hyperliquid fill capture with durable, append-only checkpoints.
 *
 * NO signer, no /exchange endpoint, no order intents. Capture only.
 * This is a SINGLE-PROCESS prototype; production must use a transactional
 * database plus a per-vault fencing lease. Never attach it to legacy Render.
 */
import { validateAddress } from './hyperliquidRead.mjs';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const SIGNED_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const COIN = /^[a-zA-Z0-9:_@.-]{1,64}$/;

function positiveDecimal(x, field) {
  if (typeof x !== 'string' || !DECIMAL.test(x) || Number(x) <= 0 || !Number.isFinite(Number(x))) {
    throw new Error(`Invalid ${field}; expected positive decimal string`);
  }
  return x;
}
function integer(x, field) {
  if (!Number.isSafeInteger(x) || x < 0 || x > MAX_SAFE) throw new Error(`Invalid ${field}; safe nonnegative integer required`);
  return x;
}
function fillTid(tid) {
  if (typeof tid === 'number') {
    if (!Number.isSafeInteger(tid) || tid < 0) throw new Error('Unsafe or missing Hyperliquid fill tid');
    return String(tid);
  }
  if (typeof tid === 'string' && /^(?:0|[1-9]\d*)$/.test(tid)) return tid;
  throw new Error('Missing Hyperliquid fill tid');
}

/** Normalize without fabricating source equity or assuming perp vs spot. */
export function normalizeSourceFill(trader, raw) {
  const address = validateAddress(trader);
  if (!raw || typeof raw !== 'object') throw new Error('Malformed fill object');
  const fillId = fillTid(raw.tid);
  const timeMs = integer(raw.time, 'fill time');
  if (timeMs === 0) throw new Error('Zero fill timestamp');
  if (typeof raw.coin !== 'string' || !COIN.test(raw.coin)) throw new Error('Malformed market identifier');
  if (raw.side !== 'B' && raw.side !== 'A') throw new Error('Unexpected Hyperliquid side');
  const size = positiveDecimal(raw.sz, 'fill size');
  const priceUsd = positiveDecimal(raw.px, 'fill price');
  const before = raw.startPosition;
  if (before !== undefined && (typeof before !== 'string' || !SIGNED_DECIMAL.test(before))) {
    throw new Error('Malformed source start position');
  }
  return Object.freeze({
    trader: address,
    fillId: `HL:${fillId}`,
    timeMs,
    coin: raw.coin,
    side: raw.side === 'B' ? 'buy' : 'sell',
    size,
    priceUsd,
    ...(before === undefined ? {} : { sourceStartPosition: before }),
    // The normalized data may be audited, but it is not sufficient to trade.
    // In particular, no sourceEquityUsd is synthesized from current equity.
  });
}

function validateSource(source) {
  if (!source || typeof source !== 'object') throw new Error('Source configuration required');
  return { trader: validateAddress(source.trader), fromTimeMs: integer(source.fromTimeMs, 'baseline start time') };
}

function compareFillOrder(a,b){
  if (a.timeMs !== b.timeMs) return a.timeMs-b.timeMs;
  const aa=BigInt(a.fillId.slice(3)),bb=BigInt(b.fillId.slice(3));
  return aa<bb?-1:aa>bb?1:0;
}
function sameFill(a,b){
  return a.trader===b.trader && a.fillId===b.fillId && a.timeMs===b.timeMs &&
    a.coin===b.coin && a.side===b.side && a.size===b.size &&
    a.priceUsd===b.priceUsd && a.sourceStartPosition===b.sourceStartPosition;
}
function decimalAsUnits(value){
  if(!SIGNED_DECIMAL.test(value))throw new Error('Invalid source position decimal');
  const negative=value.startsWith('-');
  const [whole,fraction='']=(negative?value.slice(1):value).split('.');
  if(fraction.length>8)throw new Error('Source position exceeds eight decimals');
  const units=BigInt(whole)*100000000n + BigInt(fraction.padEnd(8,'0')||'0');
  return negative?-units:units;
}
function unitsAsDecimal(units){
  let neg=units<0n;let x=neg?-units:units;
  let fraction=String(x%100000000n).padStart(8,'0').replace(/0+$/,'');
  return `${neg?'-':''}${x/100000000n}${fraction?'.'+fraction:''}`;
}

/**
 * Strict append-only state. Journal records:
 *   {version:1,kind:'baseline',trader,fromTimeMs}
 *   {version:1,kind:'fill',trader,fillId,timeMs,data}
 *   {version:1,kind:'checkpoint',trader,throughTimeMs}
 * Checkpoints are appended *after* every fill in their scanned range.
 */
export class CapturedSource {
  constructor({ source, journal }) {
    const validated = validateSource(source);
    this.trader = validated.trader;
    this.fromTimeMs = validated.fromTimeMs;
    this.journal = journal;
    this.fills = new Map();
    this.throughTimeMs = null;
    this.inCapture = false;
    this.#restore(journal.readAll());
  }
  #restore(records) {
    if (!Array.isArray(records)) throw new Error('Journal must return an array');
    if (!records.length) {
      this.journal.append({version:1,kind:'baseline',trader:this.trader,fromTimeMs:this.fromTimeMs});
      return;
    }
    const base = records[0];
    if (base?.version !== 1 || base.kind !== 'baseline' || base.trader !== this.trader || base.fromTimeMs !== this.fromTimeMs) {
      throw new Error('Incompatible capture baseline or source; fail closed');
    }
    for (const [idx,record] of records.entries()) {
      if (idx === 0) continue;
      if (!record || record.version !== 1 || record.trader !== this.trader) throw new Error('Invalid capture journal record');
      if (record.kind === 'fill') {
        const data = normalizeSourceFill(this.trader, record.data);
        // Raw capture stored the full original row to permit normalization updates.
        if (data.fillId !== record.fillId || data.timeMs !== record.timeMs || data.timeMs < this.fromTimeMs) {
          throw new Error('Journal fill identity/timestamp mismatch');
        }
        if (this.fills.has(record.fillId)) throw new Error('Duplicate capture journal fill; fail closed');
        this.fills.set(record.fillId, data);
      } else if (record.kind === 'checkpoint') {
        integer(record.throughTimeMs, 'checkpoint');
        if (record.throughTimeMs < this.fromTimeMs ||
          (this.throughTimeMs !== null && record.throughTimeMs < this.throughTimeMs)) {
          throw new Error('Nonmonotonic capture checkpoint');
        }
        this.throughTimeMs = record.throughTimeMs;
      } else throw new Error('Unrecognized capture journal record');
    }
  }

  /** Call from exactly one worker. Concurrent calls fail closed. */
  async captureUntil({ readPage, throughTimeMs, pageLimit = 500, overlapMs = 120000, maxRequests = 1500 }) {
    if (this.inCapture) throw new Error('Concurrent capture blocked; single writer required');
    this.inCapture = true;
    try {
    if (typeof readPage !== 'function') throw new Error('Read-only fill query function required');
    integer(throughTimeMs, 'throughTimeMs');
    if (throughTimeMs < this.fromTimeMs) throw new Error('End precedes baseline');
    if (!Number.isSafeInteger(pageLimit) || pageLimit < 2 || pageLimit > 2000) throw new Error('Invalid page limit');
    if (!Number.isSafeInteger(overlapMs) || overlapMs < 0 || overlapMs > 86400000) throw new Error('Invalid overlap');
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error('Invalid maxRequests');
    if (this.throughTimeMs !== null && throughTimeMs < this.throughTimeMs) {
      throw new Error('Cannot move capture checkpoint backward');
    }
    const startTimeMs = this.throughTimeMs === null ? this.fromTimeMs : Math.max(this.fromTimeMs, this.throughTimeMs - overlapMs);
    const ranges = [[startTimeMs, throughTimeMs]];
    let requests = 0, accepted = 0, duplicates = 0;
    while (ranges.length) {
      const [start, end] = ranges.pop();
      if (++requests > maxRequests) throw new Error('Capture request budget exceeded; no checkpoint advanced');
      const rows = await readPage(this.trader, start, end);
      if (!Array.isArray(rows)) throw new Error('Invalid fill page; no checkpoint advanced');
      // This threshold is deliberately conservative because API pagination may
      // be capped by distinct blocks as well as number of fills. Oversized
      // responses require recursive splitting, not a completeness claim.
      if (!Array.isArray(rows)) throw new Error('Malformed fill page');
      // A full page may be truncated; split until each page is guaranteed sub-cap.
      // A single saturated millisecond cannot be split without alternate API/history.
      if (rows.length >= pageLimit) {
        if (start === end) throw new Error('Saturated fills at one timestamp; fail closed, require alternate history');
        const mid = start + Math.floor((end - start) / 2);
        ranges.push([mid + 1, end], [start, mid]);
        continue;
      }
      const normalized = rows.map(row => {
        const data = normalizeSourceFill(this.trader, row);
        if (data.timeMs < start || data.timeMs > end) throw new Error('Fill timestamp outside requested range');
        return { data, row };
      }).sort((a,b)=>compareFillOrder(a.data,b.data));
      for (const {data,row} of normalized) {
        if (this.fills.has(data.fillId)) {
          const previous = this.fills.get(data.fillId);
          if (!sameFill(previous, data)) throw new Error('Conflicting replay for existing trade ID; fail closed');
          duplicates++;
          continue;
        }
        // Persist before updating memory. A process crash can only duplicate a read.
        this.journal.append({version:1,kind:'fill',trader:this.trader,fillId:data.fillId,timeMs:data.timeMs,data:row});
        this.fills.set(data.fillId, data);
        accepted++;
      }
    }
    // Only after complete successful scanning, with no known truncation.
    this.journal.append({version:1,kind:'checkpoint',trader:this.trader,throughTimeMs});
    this.throughTimeMs = throughTimeMs;
    return { mode:'READ_ONLY', trader:this.trader, startTimeMs, throughTimeMs, requests, accepted, duplicates, total:this.fills.size };
    } finally { this.inCapture = false; }
  }

  /** Report position-history gaps. Never infer the prior position from current equity. */
  auditPositionContinuity() {
    const events=[...this.fills.values()].sort(compareFillOrder);
    const positions=new Map(), gaps=[];
    for(const event of events){
      if (event.sourceStartPosition === undefined) {
        gaps.push({fillId:event.fillId,coin:event.coin,reason:'missing startPosition'});
        continue;
      }
      const key=event.coin;
      const expected=positions.get(key) ?? '0';
      if (decimalAsUnits(event.sourceStartPosition) !== decimalAsUnits(expected)) {
        gaps.push({fillId:event.fillId,coin:key,reason:'missing baseline or continuity gap'});
      }
      const size=decimalAsUnits(event.size);
      const after=decimalAsUnits(event.sourceStartPosition)+(event.side==='buy'?size:-size);
      positions.set(key, unitsAsDecimal(after));
    }
    return {mode:'READ_ONLY',verifiedFromFlatStart:gaps.length===0,gaps};
  }

  snapshot() {
    return { mode:'READ_ONLY', trader:this.trader, fromTimeMs:this.fromTimeMs,
      throughTimeMs:this.throughTimeMs, observedFillCount:this.fills.size };
  }
}