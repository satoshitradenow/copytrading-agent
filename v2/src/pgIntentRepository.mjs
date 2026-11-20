/**
 * PostgreSQL persistence for SHADOW-ONLY intent preparation and audit.
 * This module NEVER submits orders; it deliberately accepts a compatible
 * node-postgres Pool rather than opening a connection or reading credentials.
 *
 * DB transactions + unique fill key + SELECT FOR UPDATE prevent two workers
 * from proposing or transitioning the same intent concurrently. They do NOT
 * provide per-vault execution fencing: live placement remains unsupported.
 */
import { createHash } from 'node:crypto';
import { validateIntentSpec, reduceIntent } from './intentLedger.mjs';
import { validateAddress } from './hyperliquidRead.mjs';

const hash = x => createHash('sha256').update(x).digest('hex');
const clone=x=>structuredClone(x);
const WRITER_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN = /^[1-9][0-9]{0,18}$/;
const MAX_TOKEN = (1n<<63n)-1n;
const IN_FLIGHT = ['SUBMITTING','UNKNOWN','ACKED','PARTIAL','FILLED','REVIEW_REQUIRED'];
const MAX_RISK_CHECK_AGE_MS=1000;
const MAX_APPROVAL_AGE_MS=10000;
function assertOwner({writerId,fencingToken}={}){
  if(typeof writerId!=='string'||!WRITER_ID.test(writerId))throw Error('Valid per-process writer UUID required');
  const token=String(fencingToken);
  if(!TOKEN.test(token)||BigInt(token)>MAX_TOKEN)throw Error('Valid positive fencing token required');
  return {writerId:writerId.toLowerCase(),fencingToken:token};
}
function assertId(id){if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid intent ID');}
function asState(row){
  if(!row || typeof row!=='object' || !row.state)throw Error('Corrupt persisted intent row');
  const state=typeof row.state==='string'?JSON.parse(row.state):row.state;
  if(!state || row.intent_id!==state.intentId || row.client_order_id!==state.clientOrderId ||
     Number(row.version)<0 || !Number.isSafeInteger(Number(row.version)) ||
     typeof state.status!=='string')throw Error('Persisted intent mismatch; fail closed');
  return clone(state);
}
async function transaction(pool,body){
  if(!pool||typeof pool.connect!=='function')throw Error('PostgreSQL connection pool required');
  const client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const result=await body(client);
    await client.query('COMMIT');
    return result;
  }catch(error){
    try{await client.query('ROLLBACK');}catch{ /* preserve original failure */ }
    throw error;
  }finally{client.release();}
}
function eventHash(previousHash, intentId, version, event){
  return hash(JSON.stringify({previousHash,intentId,version,event}));
}
export class PgIntentRepository {
  constructor(pool){if(!pool||typeof pool.connect!=='function')throw Error('PostgreSQL connection pool required');this.pool=pool;}
  async propose(input){
    const spec=validateIntentSpec(input);
    return transaction(this.pool,async client=>{
      const state={...spec,status:'DRAFT',filledSize:'0',exchangeOrderId:null,
        exchangeFills:{},requiresReduceOnly:null,reviewReason:null,approvedAtMs:null,lastTransition:null};
      const inserted=await client.query(`
        INSERT INTO v2_execution_intents
          (intent_id,vault_address,fill_key,client_order_id,state)
        VALUES ($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT DO NOTHING
        RETURNING intent_id`,[
          spec.intentId,spec.vaultAddress,spec.fillKey,spec.clientOrderId,JSON.stringify(state)
        ]);
      const selected=await client.query(`
        SELECT intent_id,vault_address,fill_key,client_order_id,state,version,last_event_hash
        FROM v2_execution_intents
        WHERE vault_address=$1 AND fill_key=$2 FOR UPDATE`,[spec.vaultAddress,spec.fillKey]);
      if(selected.rows.length!==1)throw Error('Intent proposal missing after insert; abort');
      const row=selected.rows[0];
      if(row.intent_id!==spec.intentId || row.client_order_id!==spec.clientOrderId)
        throw Error('Existing source fill maps to different order; fail closed');
      const restored=asState(row);
      if(inserted.rowCount===1){
        const firstEvent={type:'PROPOSE',atMs:Date.now(),spec};
        const nextHash=eventHash('0'.repeat(64),spec.intentId,1,firstEvent);
        const eventInserted=await client.query(`
          INSERT INTO v2_execution_events
            (intent_id,version,previous_hash,event_hash,event_type,event_data)
          VALUES ($1,1,$2,$3,'PROPOSE',$4::jsonb)`,[
            spec.intentId,'0'.repeat(64),nextHash,JSON.stringify(firstEvent)
          ]);
        if(eventInserted.rowCount!==1)throw Error('Unable to record proposal event; abort');
        const updated=await client.query(`
          UPDATE v2_execution_intents
          SET version=1,last_event_hash=$2,updated_at=now()
          WHERE intent_id=$1 AND version=0`,[spec.intentId,nextHash]);
        if(updated.rowCount!==1)throw Error('Proposal version conflict; abort');
      }
      return restored;
    });
  }
  /**
   * Non-submission updates: these are journal transitions only. A caller cannot
   * bypass vault writer fencing by inserting SUBMISSION_STARTED here.
   */
  async transition(intentId,event){
    assertId(intentId);
    if(event?.type==='SUBMISSION_STARTED')
      throw Error('Submission requires beginSubmission with fenced vault lease');
    return transaction(this.pool,client=>this.#transitionLocked(client,intentId,event));
  }

  /**
   * SHADOW-ONLY atomic submission *preparation*. This does NOT send an order.
   * Both the lease and the intent are row-locked inside one SERIALIZABLE
   * transaction. PostgreSQL clock, not application clock, proves freshness.
   * The lease may be lost AFTER commit, before an HTTP request: a future live
   * adapter MUST recheck the lease before sending, confirm unknown orders, and
   * never blindly resubmit an interrupted request.
   */
  async beginSubmission(intentId,event,{vaultAddress,...owner}={}){
    assertId(intentId);
    if(event?.type!=='SUBMISSION_STARTED')throw Error('Submission-start event required');
    const vault=validateAddress(vaultAddress);
    const {writerId,fencingToken}=assertOwner(owner);
    return transaction(this.pool,async client=>{
      const lease=await client.query(`
        SELECT vault_address,writer_id,fencing_token,expires_at,
               (extract(epoch from clock_timestamp())*1000)::bigint AS db_now_ms
        FROM v2_vault_writer_leases
        WHERE vault_address=$1 AND writer_id=$2 AND fencing_token=$3::bigint
          AND expires_at>clock_timestamp() FOR UPDATE`,[vault,writerId,fencingToken]);
      if(lease.rows.length!==1)throw Error('Lease lost or expired; submission forbidden');
      // Fail-closed emergency stop, locked in the SAME serializable
      // transaction as the lease and order-intent transition. A missing row,
      // absent table or any DB error can never imply permission to trade.
      const controls=await client.query(`
        SELECT halted,generation FROM v2_vault_execution_controls
        WHERE vault_address=$1 FOR UPDATE`,[vault]);
      if(controls.rows.length!==1 || controls.rows[0].halted!==false)
        throw Error('Emergency HALT active or missing; submission forbidden');
      const dbNow=Number(lease.rows[0].db_now_ms);
      if(!Number.isSafeInteger(dbNow)||dbNow<=0)throw Error('Invalid PostgreSQL clock');
      if(!Number.isSafeInteger(event.atMs)||
         Math.abs(dbNow-event.atMs)>MAX_RISK_CHECK_AGE_MS ||
         !Number.isSafeInteger(event.riskRecheckedAtMs)||
         event.riskRecheckedAtMs>dbNow||
         dbNow-event.riskRecheckedAtMs>MAX_RISK_CHECK_AGE_MS)
        throw Error('Risk check or submission event stale against PostgreSQL clock');

      // A single vault must not start a new intent while an older submission
      // might still be resting, partially filled, or unconfirmed.
      const active=await client.query(`
        SELECT intent_id FROM v2_execution_intents
        WHERE vault_address=$1 AND intent_id<>$2
          AND (state->>'status')=ANY($3::text[])
        LIMIT 1 FOR UPDATE`,[vault,intentId,IN_FLIGHT]);
      if(active.rows.length)throw Error('Another unresolved vault order blocks submission');

      return this.#transitionLocked(client,intentId,event,{vault,dbNow});
    });
  }

  /** Shared durable transition; caller must already be inside transaction. */
  async #transitionLocked(client,intentId,event,guard=null){
    const selected=await client.query(`
      SELECT intent_id,vault_address,client_order_id,state,version,last_event_hash
      FROM v2_execution_intents WHERE intent_id=$1 FOR UPDATE`,[intentId]);
    if(selected.rows.length!==1)throw Error('Unknown intent; abort');
    const row=selected.rows[0],before=asState(row);
    if(guard){
      if(row.vault_address!==guard.vault||before.vaultAddress!==guard.vault)
        throw Error('Intent vault differs from fenced lease; abort');
      if(!Number.isSafeInteger(before.approvedAtMs)||
         guard.dbNow-before.approvedAtMs<0||
         guard.dbNow-before.approvedAtMs>MAX_APPROVAL_AGE_MS)
        throw Error('Risk approval expired; new independent approval required');
    }
    const after=reduceIntent(before,event);
    if(after===before)return before;
    const nextVersion=Number(row.version)+1;
    if(!Number.isSafeInteger(nextVersion))throw Error('Intent version overflow');
    const digest=eventHash(row.last_event_hash,intentId,nextVersion,event);
    const changed=await client.query(`
      UPDATE v2_execution_intents
      SET state=$2::jsonb,version=$3,last_event_hash=$4,updated_at=now()
      WHERE intent_id=$1 AND version=$5`,[
        intentId,JSON.stringify(after),nextVersion,digest,row.version
      ]);
    if(changed.rowCount!==1)throw Error('Intent CAS failed; abort');
    const appended=await client.query(`
      INSERT INTO v2_execution_events
        (intent_id,version,previous_hash,event_hash,event_type,event_data)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,[
        intentId,nextVersion,row.last_event_hash,digest,event.type,JSON.stringify(event)
      ]);
    if(appended.rowCount!==1)throw Error('Intent event append failed; abort');
    return after;
  }
  async get(intentId){
    assertId(intentId);
    const result=await this.pool.query(`
      SELECT intent_id,client_order_id,state,version,last_event_hash
      FROM v2_execution_intents WHERE intent_id=$1`,[intentId]);
    return result.rows.length?asState(result.rows[0]):null;
  }
  /** An unknown outcome remains a stop signal until a human/exchange reconciliation. */
  async unresolvedForVault(vaultAddress){
    const v=validateAddress(vaultAddress);
    const result=await this.pool.query(`
      SELECT intent_id,client_order_id,state,version,last_event_hash
      FROM v2_execution_intents
      WHERE vault_address=$1
        AND (state->>'status') IN ('SUBMITTING','UNKNOWN','ACKED','PARTIAL','FILLED','REVIEW_REQUIRED')
      ORDER BY created_at`,[v]);
    return result.rows.map(asState);
  }
}