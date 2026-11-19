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
  async transition(intentId,event){
    assertId(intentId);
    return transaction(this.pool,async client=>{
      const selected=await client.query(`
        SELECT intent_id,client_order_id,state,version,last_event_hash
        FROM v2_execution_intents WHERE intent_id=$1 FOR UPDATE`,[intentId]);
      if(selected.rows.length!==1)throw Error('Unknown intent; abort');
      const row=selected.rows[0],before=asState(row);
      const after=reduceIntent(before,event);
      if(after===before)return before; // idempotent fill observation
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
    });
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
        AND (state->>'status') IN ('SUBMITTING','UNKNOWN','ACKED','PARTIAL','REVIEW_REQUIRED')
      ORDER BY created_at`,[v]);
    return result.rows.map(asState);
  }
}