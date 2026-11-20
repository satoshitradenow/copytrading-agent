import test from 'node:test';
import assert from 'node:assert/strict';
import {PgEmergencyStop} from '../src/pgEmergencyStop.mjs';
const V='0x'+'a'.repeat(40);
function fake(){
 const db={rows:new Map(),queries:0,fail:false};
 const pool={db,async query(sql,params=[]){db.queries++;if(db.fail)throw Error('DB offline');
  if(sql.includes('INSERT INTO v2_vault_execution_controls')){
    const [vault,why,who]=params,old=db.rows.get(vault);
    const row={vault_address:vault,halted:true,generation:String(old?BigInt(old.generation)+1n:1n),halt_reason:why,halted_by:who};
    db.rows.set(vault,row);return{rowCount:1,rows:[{...row}]};
  }
  if(sql.includes('SELECT vault_address,halted,generation,halt_reason,halted_by')){
    const row=db.rows.get(params[0]);return{rowCount:row?1:0,rows:row?[{...row}]:[]};
  }
  throw Error('Unexpected SQL');
 }};
 return pool;
}
test('missing vault control row fails closed instead of enabling trading',async()=>{
 const p=fake(),c=new PgEmergencyStop(p),s=await c.status(V);
 assert.equal(s.halted,true);assert.equal(s.tradingEnabled,false);assert.equal(s.reason,'MISSING_CONTROL_ROW');
});
test('emergency halt can be requested without owner lease and is persisted',async()=>{
 const p=fake(),c=new PgEmergencyStop(p);
 const s=await c.halt({vaultAddress:V,reason:'Operator noticed unexpected follower orders',requestedBy:'operator-1'});
 assert.equal(s.halted,true);assert.equal(s.generation,'1');assert.equal(s.tradingEnabled,false);
 assert.equal((await c.status(V)).reason,'Operator noticed unexpected follower orders');
});
test('repeated HALT increments generation without ever arming',async()=>{
 const p=fake(),c=new PgEmergencyStop(p);
 await c.halt({vaultAddress:V,reason:'Stop before investigating pending fills',requestedBy:'operator-1'});
 const s=await c.halt({vaultAddress:V,reason:'Stop still required while reviewing fills',requestedBy:'operator-2'});
 assert.equal(s.generation,'2');assert.equal((await c.status(V)).halted,true);
 assert.equal(typeof c.arm,'undefined');assert.equal(typeof c.resume,'undefined');
});
test('malformed vault address, operator and reason cannot mutate control state',async()=>{
 const p=fake(),c=new PgEmergencyStop(p);
 await assert.rejects(c.halt({vaultAddress:'bad',reason:'Real emergency',requestedBy:'operator-1'}),/address/);
 await assert.rejects(c.halt({vaultAddress:V,reason:'short',requestedBy:'operator-1'}),/reason/);
 await assert.rejects(c.halt({vaultAddress:V,reason:'Real emergency',requestedBy:'bad actor!'}),/operator/);
 assert.equal(p.db.queries,0);
});
test('offline database never reports a successful HALT',async()=>{
 const p=fake(),c=new PgEmergencyStop(p);p.db.fail=true;
 await assert.rejects(c.halt({vaultAddress:V,reason:'Stop because exchange state is uncertain',requestedBy:'operator-1'}),/DB offline/);
});
test('an explicitly armed test-fixture control is still reported as no live trading permission',async()=>{
 const p=fake(),c=new PgEmergencyStop(p);
 p.db.rows.set(V,{vault_address:V,halted:false,generation:'5',halt_reason:'test-only',halted_by:'ci'});
 const s=await c.status(V);assert.equal(s.halted,false);assert.equal(s.tradingEnabled,false);
});