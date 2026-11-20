import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');

test('original SDK and event subscription remain in use',()=>{
 assert.match(source,/createHyperliquidClients\(config\)/);
 assert.match(source,/new SubscriptionService\(/);
 assert.match(source,/new TradeExecutor\(/);
 assert.match(source,/reconciler\.start\(\)/);
});
test('the only direct order-sync trigger is the new leader-fill callback',()=>{
 const uses=[...source.matchAll(/tradeExecutor\.syncWithLeader\(\)/g)];
 assert.equal(uses.length,1,'idle polling must NEVER generate follower orders');
 assert.match(source,/\(\) => tradeExecutor\.syncWithLeader\(\)/);
});
test('no periodic pollLoop remains with synthetic target-position correction trades',()=>{
 assert.doesNotMatch(source,/\bvoid pollLoop\(\)/);
 assert.doesNotMatch(source,/\bawait tradeExecutor\.syncWithLeader\(/);
 assert.doesNotMatch(source,/\bsetTimeout as delay\b/);
});

test('integration branch never starts a live source-to-exchange sync daemon',()=>{
 const guard=source.indexOf('throw new Error("Vault integration execution is not authorized');
 const config=source.indexOf('const config = loadConfig()');
 assert.ok(guard>0 && guard<config,
  'review-only guard must run before loading signing credentials or creating clients');
});
