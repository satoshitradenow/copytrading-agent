/**
 * Operator-only recovery inspection for Vault Copier v2.
 *
 * A crash, missing writer, confirmed fill, or "healthy" PostgreSQL read does
 * not mean that a Hyperliquid HTTP request did not execute. This inspector
 * gathers a SINGLE read-only PostgreSQL snapshot for operator diagnosis.
 * It NEVER grants signing, resubmission, unhalt, portfolio settlement or
 * automatic restart permissions. An exchange reconciliation is separate.
 */
import {validateAddress} from './hyperliquidRead.mjs';

const KNOWN=new Set(['DRAFT','BLOCKED','APPROVED','CANCELED','SUBMITTING',
 'UNKNOWN','ACKED','PARTIAL','FILLED','REJECTED','REVIEW_REQUIRED']);
const IN_FLIGHT=new Set(['SUBMITTING','UNKNOWN','ACKED','PARTIAL','FILLED','REVIEW_REQUIRED']);
const HEX64=/^[0-9a-f]{64}$/;
const controlsSQL=`SELECT vault_address,halted,generation,halt_reason
 FROM v2_vault_execution_controls WHERE vault_address=$1`;
const leaseSQL=`SELECT vault_address,writer_id,fencing_token,expires_at,
  (expires_at>clock_timestamp()) AS active
 FROM v2_vault_writer_leases WHERE vault_address=$1`;
const batchSQL=`SELECT batch_id,status,source_fill_key
 FROM v2_portfolio_batches
 WHERE vault_address=$1 AND status IN ('STAGED','REVIEW_REQUIRED')
 ORDER BY created_at,batch_id LIMIT 2`;
const intentsSQL=`SELECT intent_id,(state->>'status') AS status
 FROM v2_execution_intents WHERE vault_address=$1
 ORDER BY created_at,intent_id LIMIT 201`;
const auditsSQL=`SELECT audit_seq,chain_hash
 FROM v2_settlement_audits WHERE batch_id=$1
 ORDER BY audit_seq DESC LIMIT 1`;

function one(rows,label){
 if(!Array.isArray(rows)||rows.length>1)throw Error('Ambiguous '+label+' in vault recovery inspection');
 return rows[0]??null;
}
function reasonOnce(reasons,reason){
 if(!reasons.includes(reason))reasons.push(reason);
}
export class PgVaultRecoveryInspector {
 constructor(pool){
  if(!pool||typeof pool.connect!=='function')throw Error('PostgreSQL pool required');
  this.pool=pool;
 }
 /** An observation, NOT a live-operation readiness decision. */
 async inspect({vaultAddress}={}){
  const vault=validateAddress(vaultAddress);
  const client=await this.pool.connect();
  try{
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const controls=one((await client.query(controlsSQL,[vault])).rows,'execution control');
   const lease=one((await client.query(leaseSQL,[vault])).rows,'writer lease');
   const pending=(await client.query(batchSQL,[vault])).rows;
   const intents=(await client.query(intentsSQL,[vault])).rows;
   if(!Array.isArray(pending)||pending.length>1)
    throw Error('Conflicting or multiple pending source batches; recovery denied');
   if(!Array.isArray(intents)||intents.length>200)
    throw Error('Unbounded intent history in vault recovery inspection; fail closed');
   const reasons=[];
   if(!controls){
    reasonOnce(reasons,'MISSING_EXECUTION_CONTROL_HALTED_BY_DEFAULT');
   }else if(controls.vault_address!==vault||typeof controls.halted!=='boolean'||
     !/^[1-9][0-9]*$/.test(String(controls.generation))){
    throw Error('Corrupt execution control; cannot inspect recovery safely');
   }else if(controls.halted){
    reasonOnce(reasons,'EMERGENCY_HALT_ACTIVE');
   }else reasonOnce(reasons,'CONTROL_NOT_HALTED_BUT_NO_TRADE_AUTHORITY');
   if(lease){
    if(lease.vault_address!==vault||typeof lease.active!=='boolean'||
      !/^[1-9][0-9]*$/.test(String(lease.fencing_token))||
      !(lease.expires_at instanceof Date||Number.isFinite(Date.parse(lease.expires_at))))
      throw Error('Corrupt writer lease; recovery denied');
    reasonOnce(reasons,lease.active?'WRITER_LEASE_ACTIVE_NEEDS_RECONCILIATION':
     'EXPIRED_WRITER_LEASE_NEEDS_RECONCILIATION');
   }else reasonOnce(reasons,'NO_VERIFIED_WRITER_LEASE');
   const summaries=[];
   for(const row of intents){
    if(!row||typeof row.intent_id!=='string'||!HEX64.test(row.intent_id)||
      !KNOWN.has(row.status))throw Error('Unknown or corrupt execution intent state; fail closed');
    if(IN_FLIGHT.has(row.status))reasonOnce(reasons,'UNRESOLVED_EXCHANGE_INTENT');
    else if(['DRAFT','APPROVED'].includes(row.status))
     reasonOnce(reasons,'UNPROCESSED_ORDER_INTENT');
    summaries.push(Object.freeze({intentId:row.intent_id,status:row.status}));
   }
   let staged=null;
   if(pending.length){
    const p=pending[0];
    if(!p||!HEX64.test(p.batch_id)||!['STAGED','REVIEW_REQUIRED'].includes(p.status)||
      typeof p.source_fill_key!=='string')
     throw Error('Malformed pending source batch');
    const latest=one((await client.query(auditsSQL,[p.batch_id])).rows,'latest settlement audit');
    if(latest && (!/^[1-9][0-9]*$/.test(String(latest.audit_seq))||
      !HEX64.test(latest.chain_hash)))throw Error('Malformed latest settlement audit pointer');
    staged=Object.freeze({batchId:p.batch_id,status:p.status,
      sourceFillKey:p.source_fill_key,
      lastAuditSequence:latest?String(latest.audit_seq):null,
      lastAuditChainHash:latest?.chain_hash??null,
      auditIntegrityVerified:false});
    reasonOnce(reasons,'PENDING_SOURCE_BATCH');
    if(!latest)reasonOnce(reasons,'MISSING_SETTLEMENT_EVIDENCE');
    else reasonOnce(reasons,'SETTLEMENT_EVIDENCE_REQUIRES_INDEPENDENT_CHAIN_VERIFICATION');
   }
   // Even an empty database or a non-halted row cannot establish that no
   // network request escaped before a crash or prove current agent authority.
   reasonOnce(reasons,'EXCHANGE_OUTCOME_AND_HISTORY_NOT_INDEPENDENTLY_PROVEN');
   reasonOnce(reasons,'LIVE_EXECUTION_NOT_IMPLEMENTED_OR_AUTHORIZED');
   await client.query('COMMIT');
   return Object.freeze({mode:'READ_ONLY_RECOVERY_INSPECTION',
    vaultAddress:vault,halted:controls?controls.halted:true,
    controlGeneration:controls?String(controls.generation):null,
    haltReason:controls?.halt_reason??(controls?null:'MISSING_CONTROL_ROW'),
    leasePresent:!!lease,leaseActive:lease?.active??false,
    pendingBatch:staged,executionIntents:Object.freeze(summaries),
    blockingReasons:Object.freeze(reasons),
    requiresIndependentExchangeReconciliation:true,
    readyToResumeTrading:false,settlementAuthorized:false,
    executeAuthorized:false,safeToResubmit:false,
    note:'Database snapshot only; does not verify exchange orders, API-agent scope, external funds or network completeness'});
  }catch(e){
   try{await client.query('ROLLBACK');}catch{}
   throw e;
  }finally{client.release();}
 }
}
