import test from 'node:test';
import assert from 'node:assert/strict';
import {IntentLedger,MemoryEventJournal,validateIntentSpec,reduceIntent} from '../src/intentLedger.mjs';
const V='0x1111111111111111111111111111111111111111';
const T=1800000000000;
const spec=(x={})=>({mode:'SHADOW_ONLY',vaultAddress:V,fillKey:'trader:a-fill-1',coin:'BTC',side:'buy',size:'0.01',netBefore:'0',netAfter:'0.01',...x});
const ev=(type,x={})=>({type,atMs:T,...x});
const risk=(x={})=>({mode:'SHADOW_ONLY',allowed:true,vaultAddress:V,coin:'BTC',requiresReduceOnly:false,intentId:validateIntentSpec(spec()).intentId,...x});
const make=()=>{const journal=new MemoryEventJournal();const ledger=new IntentLedger(journal);const p=ledger.propose(spec());return{journal,ledger,p};};
const approve=(l,p)=>l.transition(p.intentId,ev('RISK_APPROVED',{receipt:risk()}));
const send=(l,p)=>l.transition(p.intentId,ev('SUBMISSION_STARTED',{clientOrderId:p.clientOrderId,riskRecheckedAtMs:T}));
test('deterministic client order ID is a strict 16-byte hex identifier',()=>{
 const a=validateIntentSpec(spec()),b=validateIntentSpec(spec());assert.deepEqual(a,b);
 assert.match(a.clientOrderId,/^0x[0-9a-f]{32}$/);assert.equal(a.intentId.length,64);
});
test('source trade creates one intent and repeated proposal is a no-op',()=>{
 const {ledger,p,journal}=make();assert.deepEqual(ledger.propose(spec()),p);assert.equal(journal.readAll().length,1);
});
test('conflicting same source fill cannot produce two orders',()=>{
 const {ledger}=make();assert.throws(()=>ledger.propose(spec({size:'0.02',netAfter:'0.02'})),/conflicting proposal/);
});
test('two source fills create two distinct intents',()=>{
 const {ledger,p}=make();const q=ledger.propose(spec({fillKey:'trader:a-fill-2'}));assert.notEqual(p.intentId,q.intentId);
});
test('risk-gate approval requires matching vault, coin and allowed decision',()=>{
 const {ledger,p}=make();assert.throws(()=>ledger.transition(p.intentId,ev('RISK_APPROVED',{receipt:risk({vaultAddress:'0x2222222222222222222222222222222222222222'})})),/risk receipt/);
 assert.throws(()=>ledger.transition(p.intentId,ev('RISK_APPROVED',{receipt:risk({allowed:false})})),/risk receipt/);
 assert.equal(approve(ledger,p).status,'APPROVED');
});
test('blocked risk cannot become submission',()=>{
 const {ledger,p}=make();ledger.transition(p.intentId,ev('RISK_BLOCKED',{reasons:['STALE_SNAPSHOT']}));
 assert.throws(()=>send(ledger,p),/forbidden/);
});
test('order must have fresh independent check before SUBMITTING',()=>{
 const {ledger,p}=make();approve(ledger,p);
 assert.throws(()=>ledger.transition(p.intentId,ev('SUBMISSION_STARTED',{clientOrderId:p.clientOrderId,riskRecheckedAtMs:T-10001})),/fresh risk/);
 assert.equal(send(ledger,p).status,'SUBMITTING');
});
test('unknown network result never allows a blind resend',()=>{
 const {ledger,p}=make();approve(ledger,p);send(ledger,p);
 ledger.transition(p.intentId,ev('SUBMISSION_UNCERTAIN'));
 assert.equal(ledger.get(p.intentId).status,'UNKNOWN');
 assert.throws(()=>send(ledger,p),/forbidden/);
});
test('confirmed acceptance can reconcile an unknown network result',()=>{
 const {ledger,p}=make();approve(ledger,p);send(ledger,p);
 ledger.transition(p.intentId,ev('SUBMISSION_UNCERTAIN'));
 assert.equal(ledger.transition(p.intentId,ev('EXCHANGE_ACCEPTED',{exchangeOrderId:'order1'})).status,'ACKED');
 assert.throws(()=>ledger.transition(p.intentId,ev('EXCHANGE_ACCEPTED',{exchangeOrderId:'order2'})),/conflicting/);
});
test('partial fills, duplicate fill ID and final fill are audited',()=>{
 const {ledger,p,journal}=make();approve(ledger,p);send(ledger,p);
 ledger.transition(p.intentId,ev('FILL_CONFIRMED',{fillId:'trade.1',size:'0.004'}));
 assert.equal(ledger.get(p.intentId).filledSize,'0.004');assert.equal(ledger.get(p.intentId).status,'PARTIAL');
 const n=journal.readAll().length;
 ledger.transition(p.intentId,ev('FILL_CONFIRMED',{fillId:'trade.1',size:'0.004'}));assert.equal(journal.readAll().length,n);
 const fin=ledger.transition(p.intentId,ev('FILL_CONFIRMED',{fillId:'trade.2',size:'0.006'}));
 assert.equal(fin.status,'FILLED');assert.equal(fin.filledSize,'0.01');
 assert.throws(()=>ledger.transition(p.intentId,ev('FILL_CONFIRMED',{fillId:'trade.3',size:'0.001'})),/overfill/);
});
test('conflicting replay of same exchange fill identifier fails closed',()=>{
 const {ledger,p}=make();approve(ledger,p);send(ledger,p);
 ledger.transition(p.intentId,ev('FILL_CONFIRMED',{fillId:'trade.1',size:'0.004'}));
 assert.throws(()=>ledger.transition(p.intentId,ev('FILL_CONFIRMED',{fillId:'trade.1',size:'0.006'})),/conflicting replay/);
});
test('rejecting order with confirmed fill is not permitted',()=>{
 const {ledger,p}=make();approve(ledger,p);send(ledger,p);
 ledger.transition(p.intentId,ev('FILL_CONFIRMED',{fillId:'trade.1',size:'0.001'}));
 assert.throws(()=>ledger.transition(p.intentId,ev('EXCHANGE_REJECTED',{reason:'no balance'})),/forbidden/);
});
test('manual review freezes unknown orders; it does not retry them',()=>{
 const {ledger,p}=make();approve(ledger,p);send(ledger,p);
 ledger.transition(p.intentId,ev('OPERATOR_REVIEW',{reason:'lost response'}));
 assert.equal(ledger.get(p.intentId).status,'REVIEW_REQUIRED');
 assert.throws(()=>ledger.transition(p.intentId,ev('SUBMISSION_STARTED',{clientOrderId:p.clientOrderId,riskRecheckedAtMs:T})),/forbidden/);
});
test('replay from append-only journal reproduces all transitions exactly',()=>{
 const {journal,ledger,p}=make();approve(ledger,p);send(ledger,p);
 ledger.transition(p.intentId,ev('FILL_CONFIRMED',{fillId:'trade.1',size:'0.003'}));
 const reboot=new IntentLedger(new MemoryEventJournal(journal.readAll()));
 assert.deepEqual(reboot.get(p.intentId),ledger.get(p.intentId));assert.deepEqual(reboot.counts(),{PARTIAL:1});
});
test('replay detects a corrupted journal record or missing event',()=>{
 const {journal,ledger,p}=make();approve(ledger,p);send(ledger,p);
 const changed=journal.readAll();changed[1].payload.receipt.allowed=false;
 assert.throws(()=>new IntentLedger(new MemoryEventJournal(changed)),/event hash/);
 const missing=journal.readAll().slice(1);
 assert.throws(()=>new IntentLedger(new MemoryEventJournal(missing)),/broken event chain/);
});
test('failed append leaves in-memory state unchanged',()=>{
 const {journal,ledger,p}=make();const old=journal.append;journal.append=()=>{throw Error('disk failure');};
 assert.throws(()=>ledger.transition(p.intentId,ev('RISK_BLOCKED',{reasons:['NO_TRADING']})),/disk failure/);
 assert.equal(ledger.get(p.intentId).status,'DRAFT');journal.append=old;
});
test('untrusted inputs cannot change transition lifecycle',()=>{
 const {ledger,p}=make();
 assert.throws(()=>reduceIntent(ledger.get(p.intentId),ev('UNRECOGNIZED')),/unknown event/);
 assert.throws(()=>ledger.propose(spec({side:'buy',netAfter:'2'})),/inconsistent delta/);
});

test('late order acknowledgment cannot undo a partially or fully filled order',()=>{
 const {ledger,p,journal}=make();approve(ledger,p);send(ledger,p);
 ledger.transition(p.intentId,ev('FILL_CONFIRMED',{fillId:'partial-first',size:'0.004'}));
 const partial=ledger.transition(p.intentId,ev('EXCHANGE_ACCEPTED',{exchangeOrderId:'ack-delayed'}));
 assert.equal(partial.status,'PARTIAL');assert.equal(partial.filledSize,'0.004');
 const n=journal.readAll().length;ledger.transition(p.intentId,ev('EXCHANGE_ACCEPTED',{exchangeOrderId:'ack-delayed'}));
 assert.equal(journal.readAll().length,n);
 ledger.transition(p.intentId,ev('FILL_CONFIRMED',{fillId:'fill-last',size:'0.006'}));
 assert.equal(ledger.get(p.intentId).status,'FILLED');
});
test('duplicate unknown reports cannot create a retry action',()=>{
 const {ledger,p,journal}=make();approve(ledger,p);send(ledger,p);
 ledger.transition(p.intentId,ev('SUBMISSION_UNCERTAIN'));const n=journal.readAll().length;
 assert.equal(ledger.transition(p.intentId,ev('SUBMISSION_UNCERTAIN')).status,'UNKNOWN');
 assert.equal(journal.readAll().length,n);
});


test('risk receipt for different intent cannot authorize same-vault same-market order',()=>{
 const {ledger,p}=make();
 const other=validateIntentSpec(spec({fillKey:'trader:a-fill-2',size:'0.1',netAfter:'0.1'}));
 assert.throws(()=>ledger.transition(p.intentId,ev('RISK_APPROVED',{receipt:risk({intentId:other.intentId})})),/risk receipt/);
 assert.equal(ledger.get(p.intentId).status,'DRAFT');
});