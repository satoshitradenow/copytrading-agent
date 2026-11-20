/**
 * One-way, operator-requested DB emergency HALT for a Hyperliquid vault.
 * SHADOW-ONLY at present: no exchange execution endpoint exists in v2.
 * Intentionally contains NO arm/unhalt API. Real activation requires a separate
 * independently approved and audited operator workflow; do not automate it.
 *
 * A halt cannot undo an HTTP order already transmitted to the exchange.
 */
import {validateAddress} from './hyperliquidRead.mjs';
const ACTOR=/^[a-zA-Z0-9._:-]{1,64}$/;
function checkedReason(reason){
 if(typeof reason!=='string'||reason.trim()!==reason||reason.length<8||reason.length>256)
   throw Error('Emergency halt requires an 8–256 character reason');
 return reason;
}
function checkedActor(actor){
 if(typeof actor!=='string'||!ACTOR.test(actor))throw Error('Emergency stop requires an operator identifier');
 return actor;
}
function normalized(row,vault){
 if(!row||row.vault_address!==vault||row.halted!==true||
    !/^[1-9]\d*$/.test(String(row.generation)))throw Error('Invalid emergency stop database result');
 return Object.freeze({mode:'SHADOW_ONLY',vaultAddress:vault,halted:true,
   generation:String(row.generation),reason:row.halt_reason??null,requestedBy:row.halted_by??null,
   tradingEnabled:false});
}
export class PgEmergencyStop {
 constructor(pool){if(!pool||typeof pool.query!=='function')throw Error('PostgreSQL pool required');this.pool=pool;}
 /** No lease or trader signing key is required to STOP; stop must be independently callable. */
 async halt({vaultAddress,reason,requestedBy}){
  const vault=validateAddress(vaultAddress),why=checkedReason(reason),who=checkedActor(requestedBy);
  const r=await this.pool.query(`
    INSERT INTO v2_vault_execution_controls
      (vault_address,halted,generation,halt_reason,halted_by,updated_at)
    VALUES ($1,TRUE,1,$2,$3,clock_timestamp())
    ON CONFLICT (vault_address) DO UPDATE SET
      halted=TRUE,generation=v2_vault_execution_controls.generation+1,
      halt_reason=EXCLUDED.halt_reason,halted_by=EXCLUDED.halted_by,
      updated_at=clock_timestamp()
    RETURNING vault_address,halted,generation,halt_reason,halted_by`,[vault,why,who]);
  if(r.rowCount!==1||r.rows.length!==1)throw Error('Emergency halt was not confirmed by PostgreSQL');
  return normalized(r.rows[0],vault);
 }
 /** Missing row means HALTED, not permission to trade. */
 async status(vaultAddress){
  const vault=validateAddress(vaultAddress);
  const result=await this.pool.query(`SELECT vault_address,halted,generation,halt_reason,halted_by
    FROM v2_vault_execution_controls WHERE vault_address=$1`,[vault]);
  if(result.rows.length>1)throw Error('Ambiguous emergency stop state; fail closed');
  if(!result.rows.length)return Object.freeze({mode:'SHADOW_ONLY',vaultAddress:vault,
    halted:true,generation:null,reason:'MISSING_CONTROL_ROW',tradingEnabled:false});
  const row=result.rows[0];
  if(row.vault_address!==vault||typeof row.halted!=='boolean'||
     !/^[1-9]\d*$/.test(String(row.generation)))throw Error('Invalid emergency stop database row');
  return Object.freeze({mode:'SHADOW_ONLY',vaultAddress:vault,halted:row.halted,
    generation:String(row.generation),reason:row.halt_reason??null,
    requestedBy:row.halted_by??null,tradingEnabled:false});
 }
}