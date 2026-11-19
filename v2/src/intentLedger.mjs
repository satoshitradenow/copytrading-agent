/**
 * Crash-replayable, append-only order-intent model for Hyperliquid vault v2.
 * IMPORTANT: no exchange client or signer is imported in this file.
 * 
 * An accepted intent is NOT an executed order. A persisted SUBMISSION_STARTED
 * always means an interrupted caller must reconcile with the exchange before
 * attempting *any* new submission. No automatic retry path exists here.
 * 
 * MemoryEventJournal is a test/shadow adapter, NOT durable production storage.
 */
import { createHash } from 'node:crypto';
import { sizeUnits, formatUnits } from './ledger.mjs';
import { validateAddress } from './hyperliquidRead.mjs';

const MARKET = /^[A-Z][A-Z0-9:_-]{0,31}$/;
const FILLKEY = /^[a-zA-Z0-9:_.\/-]{1,160}$/;
const HEXID = /^0x[0-9a-f]{32}$/;
const abs = x => x < 0n ? -x : x;
function hash(data) { return createHash('sha256').update(data).digest('hex'); }
function canonical(v) { return JSON.stringify(v); }
function fail(message) { throw new Error(`Intent journal fail-closed: ${message}`); }
function validateIntentSpec(input) {
  if (!input || input.mode !== 'SHADOW_ONLY') fail('SHADOW_ONLY source intent required');
  const vaultAddress = validateAddress(input.vaultAddress);
  if (typeof input.fillKey !== 'string' || !FILLKEY.test(input.fillKey)) fail('invalid fillKey');
  if (typeof input.coin !== 'string' || !MARKET.test(input.coin)) fail('invalid market');
  if (!['buy', 'sell'].includes(input.side)) fail('invalid trade side');
  const size = sizeUnits(input.size), before = sizeUnits(input.netBefore), after = sizeUnits(input.netAfter);
  if (size <= 0n || after - before !== (input.side === 'buy' ? size : -size)) fail('inconsistent delta');
  const spec = Object.freeze({mode:'SHADOW_ONLY',vaultAddress,fillKey:input.fillKey,
    coin:input.coin,side:input.side,size:formatUnits(size),netBefore:formatUnits(before),netAfter:formatUnits(after)});
  const digest = hash(`hl-vault-copy-v2\n${canonical(spec)}`);
  return Object.freeze({...spec,intentId:digest,clientOrderId:`0x${digest.slice(0,32)}`});
}
export { validateIntentSpec };

function blankState(spec) {return { ...spec,status:'DRAFT',filledSize:'0', exchangeOrderId:null,
  exchangeFills:{},requiresReduceOnly:null,reviewReason:null,approvedAtMs:null,lastTransition:null };}
function assertTimestamp(ms) {if(!Number.isSafeInteger(ms)||ms<=0)fail('invalid event time');}
function validateEvent(event){
  if(!event || typeof event.type!=='string')fail('invalid event');
  assertTimestamp(event.atMs);
}
/** Pure validated state transition. All strings and records are safe to serialize. */
export function reduceIntent(state,event){
  validateEvent(event);
  const st=structuredClone(state);
  const from=st.status;
  const allow=(...states)=>{if(!states.includes(from))fail(`transition ${event.type} forbidden from ${from}`);};
  switch(event.type){
    case 'RISK_BLOCKED':
      allow('DRAFT');
      if(!Array.isArray(event.reasons)||!event.reasons.length||event.reasons.some(x=>typeof x!=='string'||!x))fail('block reasons required');
      st.status='BLOCKED';st.reviewReason=event.reasons.join(',');break;
    case 'RISK_APPROVED':
      allow('DRAFT');
      if(event.receipt?.mode!=='SHADOW_ONLY'||event.receipt?.allowed!==true||
         validateAddress(event.receipt.vaultAddress)!==st.vaultAddress||event.receipt.coin!==st.coin||
         typeof event.receipt.requiresReduceOnly!=='boolean')fail('risk receipt disagrees with intent');
      st.status='APPROVED';st.requiresReduceOnly=event.receipt.requiresReduceOnly;st.approvedAtMs=event.atMs;break;
    case 'MANUAL_CANCEL':
      allow('DRAFT','BLOCKED','APPROVED');
      st.status='CANCELED';break;
    case 'SUBMISSION_STARTED':
      allow('APPROVED');
      // Future submit adapter must atomically durably write this transition
      // BEFORE submitting an order, and revalidate all risk controls first.
      if(event.clientOrderId!==st.clientOrderId||!HEXID.test(event.clientOrderId))fail('order ID mismatch');
      if(typeof event.riskRecheckedAtMs!=='number'||event.riskRecheckedAtMs>event.atMs||
         event.riskRecheckedAtMs<=0 || event.atMs-event.riskRecheckedAtMs>1000)fail('fresh risk check required');
      st.status='SUBMITTING';break;
    case 'SUBMISSION_UNCERTAIN':
      allow('SUBMITTING','UNKNOWN');
      if(from==='UNKNOWN')return state; // idempotent reconnect reporting
      st.status='UNKNOWN';st.reviewReason='EXCHANGE_RESULT_UNKNOWN';break;
    case 'EXCHANGE_ACCEPTED':
      allow('SUBMITTING','UNKNOWN','ACKED','PARTIAL','FILLED');
      if(typeof event.exchangeOrderId!=='string'||event.exchangeOrderId.length<1||event.exchangeOrderId.length>128)fail('invalid exchange order ID');
      if(st.exchangeOrderId!==null && st.exchangeOrderId!==event.exchangeOrderId)fail('conflicting exchange order ID');
      if(st.exchangeOrderId===event.exchangeOrderId)return state; // idempotent acknowledgment
      st.exchangeOrderId=event.exchangeOrderId;
      // Exchange fills can arrive before the acceptance response. An ACK may
      // attach the exchange order ID, but it must NOT regress PARTIAL/FILLED.
      if(from!=='PARTIAL'&&from!=='FILLED')st.status='ACKED';
      st.reviewReason=null;break;
    case 'FILL_CONFIRMED':{
      allow('SUBMITTING','UNKNOWN','ACKED','PARTIAL','FILLED');
      if(typeof event.fillId!=='string'||!FILLKEY.test(event.fillId))fail('invalid exchange fill ID');
      const units=sizeUnits(event.size);
      if(units<=0n)fail('nonpositive exchange fill');
      if(st.exchangeFills[event.fillId]!==undefined){
        if(st.exchangeFills[event.fillId]!==formatUnits(units))fail('conflicting replayed exchange fill');
        return state; // same fill id is idempotent
      }
      const next=sizeUnits(st.filledSize)+units;
      if(next>sizeUnits(st.size))fail('order overfill requires investigation');
      st.exchangeFills[event.fillId]=formatUnits(units);
      st.filledSize=formatUnits(next);
      st.status=next===sizeUnits(st.size)?'FILLED':'PARTIAL';
      st.reviewReason=null;break;
    }
    case 'EXCHANGE_REJECTED':
      allow('SUBMITTING','UNKNOWN','ACKED');
      if(sizeUnits(st.filledSize)!==0n)fail('cannot reject partially filled order');
      if(typeof event.reason!=='string'||!event.reason)fail('rejection reason required');
      st.status='REJECTED';st.reviewReason=event.reason;break;
    case 'OPERATOR_REVIEW':
      allow('SUBMITTING','UNKNOWN','ACKED','PARTIAL');
      if(typeof event.reason!=='string'||!event.reason)fail('review reason required');
      st.status='REVIEW_REQUIRED';st.reviewReason=event.reason;break;
    default:fail(`unknown event type ${event.type}`);
  }
  st.lastTransition={type:event.type,atMs:event.atMs};
  return Object.freeze(st);
}

export class MemoryEventJournal {
  constructor(records=[]){this.records=structuredClone(records);}
  readAll(){return structuredClone(this.records);}
  append(record){this.records.push(structuredClone(record));}
}

/** Replay detects corrupted, missing, or conflicting event records. */
export class IntentLedger {
  constructor(journal=new MemoryEventJournal()) {
    this.journal=journal;this.states=new Map();this.fillKeys=new Map();this.headHash='0'.repeat(64);this.seq=0;
    for(const row of journal.readAll())this.#replayRow(row);
  }
  #replayRow(row) {
    if(!row||row.version!==1||row.seq!==this.seq+1||row.previousHash!==this.headHash)fail('broken event chain');
    const {chainHash,...unsigned}=row;
    if(chainHash!==hash(canonical(unsigned)))fail('event hash mismatch');
    let state;
    if(row.kind==='PROPOSE'){
      const spec=validateIntentSpec(row.payload);
      if(spec.intentId!==row.intentId||this.states.has(row.intentId))fail('invalid or duplicate proposal');
      const fk=`${spec.vaultAddress}/${spec.fillKey}`;
      if(this.fillKeys.has(fk))fail('source fill already proposed to vault');
      this.fillKeys.set(fk,row.intentId);
      state=blankState(spec);
    }else if(row.kind==='TRANSITION'){
      const prev=this.states.get(row.intentId);
      if(!prev)fail('transition before proposal');
      state=reduceIntent(prev,row.payload);
    }else fail('unknown record kind');
    this.states.set(row.intentId,state);this.seq=row.seq;this.headHash=chainHash;
  }
  #append(kind,intentId,payload){
    const unsigned={version:1,seq:this.seq+1,previousHash:this.headHash,kind,intentId,payload};
    const row={...unsigned,chainHash:hash(canonical(unsigned))};
    // Journal write occurs FIRST; failed append does not change this process state.
    this.journal.append(row);
    this.#replayRow(row);
    return this.states.get(intentId);
  }
  propose(spec){
    const validated=validateIntentSpec(spec);
    const key=`${validated.vaultAddress}/${validated.fillKey}`;
    const existing=this.fillKeys.get(key);
    if(existing){
      if(existing!==validated.intentId)fail('conflicting proposal for same source fill');
      return this.get(validated.intentId); // exact duplicate event, no duplicate proposal
    }
    return structuredClone(this.#append('PROPOSE',validated.intentId,validated));
  }
  transition(intentId,event){
    const current=this.states.get(intentId);
    if(!current)fail('unknown intent');
    const next=reduceIntent(current,event); // preflight validation before durable append
    if(next===current) return structuredClone(current); // duplicate fill, no extra event
    return structuredClone(this.#append('TRANSITION',intentId,event));
  }
  get(id){const state=this.states.get(id);return state?structuredClone(state):null;}
  getAll(){return [...this.states.values()].map(x=>structuredClone(x));}
  counts(){const counts={};for(const st of this.states.values())counts[st.status]=(counts[st.status]||0)+1;return counts;}
}