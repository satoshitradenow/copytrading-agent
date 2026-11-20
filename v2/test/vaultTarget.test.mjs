import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeVaultIdentifier, verifyVaultDestination} from '../src/vaultTarget.mjs';
const A='0x1111111111111111111111111111111111111111';
const B='0x2222222222222222222222222222222222222222';
const C='0x3333333333333333333333333333333333333333';
const good={mode:'READ_ONLY',vaultAddress:A,leader:B,name:'Example Vault',accountValueUsd:'100.25',positions:[]};

test('accepts HL: address labels and normalizes address without storing prefix',()=>{
 assert.equal(normalizeVaultIdentifier(' HL:'+A.toUpperCase().replace('0X','0x')+' '),A);
 assert.equal(normalizeVaultIdentifier(A),A);
});
test('rejects malformed vault display labels rather than guessing an address',()=>{
 for(const label of ['HL:', 'HL:ABC', 'HL:HL:'+A, 'HL:  '+A, '',null,42]){
  assert.throws(()=>normalizeVaultIdentifier(label),/address|string/);
 }
});
test('verifies read-only vault response with exact name and leader pins',async()=>{
 let got=null;
 const result=await verifyVaultDestination({identifier:'HL:'+A,expectedLeader:B,expectedName:'Example Vault',
   readState:async address=>{got=address;return good;}});
 assert.equal(got,A);assert.equal(result.verified,true);
 assert.equal(result.signingAuthorityVerified,false);
 assert.equal(result.accountValueUsd,'100.25');assert.equal(result.positionCount,0);
 assert.ok(Object.isFrozen(result));
});
test('vault identity mismatch, leader mismatch and name mismatch fail closed',async()=>{
 await assert.rejects(verifyVaultDestination({identifier:A,readState:async()=>({...good,vaultAddress:C})}),/address mismatch/);
 await assert.rejects(verifyVaultDestination({identifier:A,expectedLeader:C,readState:async()=>good}),/leader mismatch/);
 await assert.rejects(verifyVaultDestination({identifier:A,expectedName:'Another vault',readState:async()=>good}),/name mismatch/);
});
test('missing positions, invalid equity and non-read-only responses fail closed',async()=>{
 for(const state of [{...good,mode:'LIVE'}, {...good,positions:null}, {...good,accountValueUsd:'NaN'}, null]){
  await assert.rejects(verifyVaultDestination({identifier:A,readState:async()=>state}));
 }
});
test('invalid pin rejected before public reader is invoked',async()=>{
 let calls=0;
 await assert.rejects(verifyVaultDestination({identifier:A,expectedLeader:'HL:'+B,
   readState:async()=>{calls++;return good;}}),/address/);
 assert.equal(calls,0);
});