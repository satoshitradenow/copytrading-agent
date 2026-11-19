import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShadowLedger, MemoryJournal, formatUnits, moneyUnits, sizeUnits } from '../src/ledger.mjs';
import { JsonlJournal } from '../src/jsonlJournal.mjs';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
const T = [A,B,C].map(address => ({ address, allocationUsd: '1000', maxVirtualLeverage: 3, enabled: true }));
const setup = (extra={}) => new ShadowLedger({ traders: T, allowedCoins: ['BTC','ETH'], ...extra });
const fill = (overrides={}) => ({trader:A, fillId:'1', coin:'BTC', side:'buy', size:'1', priceUsd:'50000', sourceEquityUsd:'100000',...overrides});

test('fixed point decimal representations reject scientific notation and excess precision', () => {
  assert.equal(formatUnits(sizeUnits('0.00123456')), '0.00123456');
  assert.equal(formatUnits(moneyUnits('12.25'), 1_000_000n), '12.25');
  assert.throws(() => sizeUnits('1e-8'));
  assert.throws(() => sizeUnits('0.000000001'));
});

test('scale one source fill into an allocated shadow delta; no equity-driven churn', () => {
  const l = setup();
  const r = l.applyFill(fill());
  assert.equal(r.status, 'accepted');
  assert.equal(r.intent.size, '0.01');
  assert.equal(r.intent.netAfter, '0.01');
  assert.equal(l.snapshot().net.BTC, '0.01');
  // Mere price or equity changes are not API entry points and cannot create intents.
  const again = l.snapshot();
  assert.deepEqual(l.snapshot(), again);
  assert.equal(l.lastIntents.length, 1);
});

test('repeat of exact fill is deduplicated before any order intent', () => {
  const l = setup();
  l.applyFill(fill());
  assert.deepEqual(l.applyFill(fill()), {status:'duplicate',fillKey:`${A}:1`,intent:null});
  assert.equal(l.snapshot().journaledFills, 1);
  assert.equal(l.lastIntents.length, 1);
});

test('add, partial reduction, close, and reversal copy as discrete deltas', () => {
  const l = setup();
  l.applyFill(fill());
  l.applyFill(fill({fillId:'2',size:'0.5'}));
  assert.equal(l.snapshot().net.BTC,'0.015');
  l.applyFill(fill({fillId:'3',side:'sell',size:'0.25'}));
  assert.equal(l.snapshot().net.BTC,'0.0125');
  l.applyFill(fill({fillId:'4',side:'sell',size:'1.25'}));
  assert.equal(l.snapshot().net.BTC,'0');
  l.applyFill(fill({fillId:'5',side:'sell',size:'0.2'}));
  assert.equal(l.snapshot().net.BTC,'-0.002');
  assert.equal(l.lastIntents.length,5);
});

test('five-strategy netting: opposite trader fills offset and closing one restores exposure', () => {
  const l = setup();
  l.applyFill(fill({trader:A,fillId:'a'}));
  l.applyFill(fill({trader:B,fillId:'b',side:'sell'}));
  assert.equal(l.snapshot().net.BTC, '0');
  assert.equal(l.lastIntents[1].netAfter, '0');
  l.applyFill(fill({trader:B,fillId:'b-close',side:'buy'}));
  assert.equal(l.snapshot().net.BTC,'0.01');
  assert.equal(l.snapshot().virtual[`${B}|BTC`],'0');
});

test('unapproved trader or disallowed market is rejected before recording', () => {
  const l=setup();
  assert.throws(()=>l.applyFill(fill({trader:'0x4444444444444444444444444444444444444444'})),/Unapproved/);
  assert.throws(()=>l.applyFill(fill({coin:'xyz:PRIVATE'})),/Market not approved/);
  assert.equal(l.snapshot().journaledFills,0);
});

test('fail closed on missing equity and invalid source amount', () => {
  const l=setup();
  assert.throws(()=>l.applyFill(fill({sourceEquityUsd:undefined})),/sourceEquityUsd/);
  assert.throws(()=>l.applyFill(fill({sourceEquityUsd:'0'})),/positive/);
  assert.throws(()=>l.applyFill(fill({size:'-2'})),/positive/);
  assert.throws(()=>l.applyFill(fill({fillId:''})),/identifier/);
  assert.equal(l.snapshot().journaledFills,0);
});

test('virtual per-trader notional cap blocks excessive increases, preserves data integrity', () => {
  const l=setup();
  assert.throws(()=>l.applyFill(fill({size:'10'})),/cap exceeded/);
  assert.equal(l.snapshot().journaledFills,0);
  assert.deepEqual(l.snapshot().net,{});
});

test('reductions remain possible even after virtual position exceeds current price-based limit', () => {
  const l=setup();
  l.applyFill(fill({size:'1',priceUsd:'100000'}));
  const r=l.applyFill(fill({fillId:'reduce',side:'sell',size:'0.1',priceUsd:'300000'}));
  assert.equal(r.status,'accepted');
  assert.equal(l.snapshot().net.BTC,'0.009');
});

test('a failed journal write does not apply a fill', () => {
  const journal={readAll:()=>[],append:()=>{throw new Error('disk write failed')}};
  const l=setup({journal});
  assert.throws(()=>l.applyFill(fill()),/disk write failed/);
  assert.equal(l.snapshot().journaledFills,0);
  assert.equal(l.lastIntents.length,0);
});

test('restart replay preserves virtual positions and deduplication', () => {
  const path=join(mkdtempSync(join(tmpdir(),'hl-vault-v2-')),'journal.jsonl');
  const a=setup({journal:new JsonlJournal(path)});
  a.applyFill(fill());
  a.applyFill(fill({fillId:'2',size:'0.5',side:'sell'}));
  const b=setup({journal:new JsonlJournal(path)});
  assert.equal(b.snapshot().net.BTC,'0.005');
  assert.equal(b.applyFill(fill()).status,'duplicate');
  assert.equal(b.snapshot().journaledFills,2);
  assert.equal(readFileSync(path,'utf8').trim().split('\n').length,2);
});

test('truncated journal fails closed rather than losing the last fill', () => {
  const path=join(mkdtempSync(join(tmpdir(),'hl-vault-v2-')),'journal.jsonl');
  const journal=new JsonlJournal(path);
  writeFileSync(path,'{"version":1');
  assert.throws(()=>setup({journal}),/Truncated journal/);
});


test('journal replay with unknown configured strategy fails closed',()=>{
  const journal=new MemoryJournal([{version:1,fillKey:`${A}:id`,trader:'0x5555555555555555555555555555555555555555',coin:'BTC',sourceDeltaUnits:'100',deltaUnits:'100'}]);
  assert.throws(()=>setup({journal}),/invalid record/);
});

test('sub-precision follower fills are recorded once with no intent', () => {
  const l=setup();
  const r=l.applyFill(fill({size:'0.00000001',sourceEquityUsd:'999999999'}));
  assert.equal(r.status,'below_precision');
  assert.equal(r.intent,null);
  assert.equal(l.applyFill(fill({size:'0.00000001',sourceEquityUsd:'999999999'})).status,'duplicate');
});


test('full close removes the entire virtual position even after leader equity changes',()=>{
  const l=setup();
  l.applyFill(fill({size:'1',sourceEquityUsd:'100000'}));
  const result=l.applyFill(fill({fillId:'exit',side:'sell',size:'1',sourceEquityUsd:'200000'}));
  assert.equal(result.intent.size,'0.01');
  assert.equal(l.snapshot().net.BTC,'0');
  assert.equal(l.snapshot().sourcePositions[`${A}|BTC`],'0');
});

test('partial reduction and flip remain proportional after changing source equity',()=>{
  const l=setup();
  l.applyFill(fill({size:'1',sourceEquityUsd:'100000'}));
  l.applyFill(fill({fillId:'partial',side:'sell',size:'0.5',sourceEquityUsd:'200000'}));
  assert.equal(l.snapshot().net.BTC,'0.005');
  l.applyFill(fill({fillId:'flip',side:'sell',size:'1',sourceEquityUsd:'200000'}));
  assert.equal(l.snapshot().net.BTC,'-0.0025');
  assert.equal(l.snapshot().sourcePositions[`${A}|BTC`],'-0.5');
});