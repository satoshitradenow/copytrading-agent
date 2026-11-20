/**
 * PostgreSQL lease and monotonically increasing fencing-token adapter.
 *
 * SHADOW / READ-ONLY DEVELOPMENT ONLY. This module provides durable ownership
 * coordination, NOT exchange-side fencing or authorization to place orders.
 * A stale worker can still have an HTTP order in flight after its lease expires.
 * Any eventual live writer MUST durably record SUBMISSION_STARTED, enforce its
 * own freeze/reconciliation process, and never automatically resubmit an
 * uncertain exchange result. An active DB lease alone is NOT sufficient.
 *
 * Requires v2_vault_writer_leases and v2_execution_intents from
 * sql/002_execution_ledger.sql and v2_portfolio_batches from sql/003_portfolio_batches.sql. All expiry decisions use PostgreSQL's clock.
 */
import {validateAddress} from './hyperliquidRead.mjs';

const WRITER_ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const FENCE=/^[1-9][0-9]{0,18}$/;
const MAX_BIGINT=(1n<<63n)-1n;
const UNRESOLVED=['SUBMITTING','UNKNOWN','ACKED','PARTIAL','FILLED','REVIEW_REQUIRED'];

function checkWriter(writerId){
  if(typeof writerId!=='string'||!WRITER_ID.test(writerId))throw Error('Unique per-process UUID writerId required');
  return writerId.toLowerCase();
}
function checkTtl(ttlMs){
  if(!Number.isSafeInteger(ttlMs)||ttlMs<5000||ttlMs>120000)throw Error('Invalid writer lease TTL (5000–120000 ms)');
  return ttlMs;
}
function checkToken(fencingToken){
  const s=String(fencingToken);
  if(!FENCE.test(s)||BigInt(s)>MAX_BIGINT)throw Error('Invalid writer fencing token');
  return s;
}
function asLease(row){
  if(!row||row.fencing_token===null||!row.writer_id||!row.expires_at)throw Error('Corrupt DB lease row');
  const time=row.expires_at instanceof Date?row.expires_at:new Date(row.expires_at);
  if(!Number.isFinite(time.getTime()))throw Error('Invalid DB lease expiration');
  return Object.freeze({vaultAddress:validateAddress(row.vault_address),writerId:checkWriter(row.writer_id),
    fencingToken:checkToken(row.fencing_token),expiresAt:time.toISOString()});
}
async function withSerializable(pool,work){
  const client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const outcome=await work(client);
    await client.query('COMMIT');
    return outcome;
  }catch(e){
    try{await client.query('ROLLBACK');}catch{}
    throw e;
  }finally{client.release();}
}

export class PgVaultWriterLease {
  constructor(pool){
    if(!pool||typeof pool.connect!=='function')throw Error('PostgreSQL pool required');
    this.pool=pool;
  }

  /**
   * Acquire an unexpired exclusive lease. It is intentionally not reentrant:
   * two processes reusing one writerId cannot both acquire while active.
   * When an expired lease is taken over, its generation strictly increases.
   * Outstanding/uncertain orders forbid takeover, even after expiry.
   */
  async acquire({vaultAddress,writerId,ttlMs=15000}){
    const vault=validateAddress(vaultAddress),writer=checkWriter(writerId),ttl=checkTtl(ttlMs);
    return withSerializable(this.pool,async client=>{
      const selected=await client.query(`
        SELECT vault_address,writer_id,fencing_token,expires_at,
               (expires_at<=clock_timestamp()) AS expired
        FROM v2_vault_writer_leases WHERE vault_address=$1 FOR UPDATE`,[vault]);
      if(selected.rows.length>1)throw Error('Multiple lease records for one vault');
      if(selected.rows.length===1&&!selected.rows[0].expired)
        throw Error('Vault already has an unexpired writer; fail closed');
      // Do not transfer writer ownership until every in-flight/UNKNOWN result
      // has been separately reconciled, including from a crashed predecessor.
      const unresolved=await client.query(`
        SELECT intent_id FROM v2_execution_intents
        WHERE vault_address=$1 AND (state->>'status')=ANY($2::text[])
        LIMIT 1`,[vault,UNRESOLVED]);
      if(unresolved.rows.length)throw Error('Unresolved exchange intent blocks writer takeover');
      // A fully FILLED order can still be financially un-settled. A staged
      // source event is a durable freeze, even if no execution intent exists.
      // This lookup is intentionally inside the same SERIALIZABLE transaction.
      const pending=await client.query(`
        SELECT batch_id FROM v2_portfolio_batches
        WHERE vault_address=$1 AND status IN ('STAGED','REVIEW_REQUIRED')
        LIMIT 1`,[vault]);
      if(pending.rows.length)throw Error('Pending source batch blocks writer takeover until independent settlement');
      if(selected.rows.length===0){
        const inserted=await client.query(`
          INSERT INTO v2_vault_writer_leases
            (vault_address,writer_id,fencing_token,expires_at)
          VALUES ($1,$2,1,clock_timestamp()+($3::bigint*interval '1 millisecond'))
          ON CONFLICT DO NOTHING
          RETURNING vault_address,writer_id,fencing_token,expires_at`,[vault,writer,ttl]);
        if(inserted.rowCount!==1)throw Error('Concurrent writer lease acquisition detected');
        return asLease(inserted.rows[0]);
      }
      const prev=checkToken(selected.rows[0].fencing_token);
      if(BigInt(prev)===MAX_BIGINT)throw Error('Writer fencing token overflow');
      const updated=await client.query(`
        UPDATE v2_vault_writer_leases
        SET writer_id=$2,fencing_token=fencing_token+1,
            expires_at=clock_timestamp()+($3::bigint*interval '1 millisecond'),
            updated_at=clock_timestamp()
        WHERE vault_address=$1 AND fencing_token=$4::bigint
        RETURNING vault_address,writer_id,fencing_token,expires_at`,[vault,writer,ttl,prev]);
      if(updated.rowCount!==1)throw Error('Concurrent writer lease takeover detected');
      return asLease(updated.rows[0]);
    });
  }

  /** One atomic, DB-clock-validated renewal. A stale token cannot renew. */
  async renew({vaultAddress,writerId,fencingToken,ttlMs=15000}){
    const vault=validateAddress(vaultAddress),writer=checkWriter(writerId),token=checkToken(fencingToken),ttl=checkTtl(ttlMs);
    return withSerializable(this.pool,async client=>{
      const updated=await client.query(`
        UPDATE v2_vault_writer_leases
        SET expires_at=clock_timestamp()+($4::bigint*interval '1 millisecond'),
            updated_at=clock_timestamp()
        WHERE vault_address=$1 AND writer_id=$2 AND fencing_token=$3::bigint
          AND expires_at>clock_timestamp()
        RETURNING vault_address,writer_id,fencing_token,expires_at`,[vault,writer,token,ttl]);
      if(updated.rowCount!==1)throw Error('Writer lease expired or lost; stop operations');
      return asLease(updated.rows[0]);
    });
  }

  /** Checks current owner/generation; call with every shadow action. */
  async assertActive({vaultAddress,writerId,fencingToken}){
    const vault=validateAddress(vaultAddress),writer=checkWriter(writerId),token=checkToken(fencingToken);
    return withSerializable(this.pool,async client=>{
      const selected=await client.query(`
        SELECT vault_address,writer_id,fencing_token,expires_at
        FROM v2_vault_writer_leases
        WHERE vault_address=$1 AND writer_id=$2 AND fencing_token=$3::bigint
          AND expires_at>clock_timestamp() FOR UPDATE`,[vault,writer,token]);
      if(selected.rows.length!==1)throw Error('Stale writer or expired lease; fail closed');
      return asLease(selected.rows[0]);
    });
  }

  /** Releases only the exact current owner/token. Token is never reset. */
  async release({vaultAddress,writerId,fencingToken}){
    const vault=validateAddress(vaultAddress),writer=checkWriter(writerId),token=checkToken(fencingToken);
    return withSerializable(this.pool,async client=>{
      const updated=await client.query(`
        UPDATE v2_vault_writer_leases
        SET expires_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE vault_address=$1 AND writer_id=$2 AND fencing_token=$3::bigint
          AND expires_at>clock_timestamp() RETURNING vault_address`,[vault,writer,token]);
      if(updated.rowCount!==1)throw Error('Stale writer cannot release someone else’s lease');
      return true;
    });
  }
}