/**
 * Durable SHADOW-ONLY portfolio staging. Does NOT advance virtual strategy
 * ledger, authorize exchange signing or settle any trade.
 *
 * Staging and committing are separate by design. An exchange error, rejection,
 * or partial fill must not be represented as a fully realized source allocation.
 * Unresolved STAGED/REVIEW_REQUIRED batches block further source submissions.
 *
 * Requires sql/003_portfolio_batches.sql plus 002_execution_ledger.sql.
 */
import {createHash} from 'node:crypto';
import {validateAddress} from './hyperliquidRead.mjs';
import {sizeUnits,formatUnits} from './ledger.mjs';
import {validateIntentSpec} from './intentLedger.mjs';

const HEX64=/^[a-f0-9]{64}$/;
const WRITER=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const FENCE=/^[1-9][0-9]{0,18}$/;
const abs=n=>n<0n?-n:n;
function checkOwner({writerId,fencingToken}={}){
  const token=String(fencingToken);
  if(typeof writerId!=='string'||!WRITER.test(writerId)||!FENCE.test(token)||BigInt(token)>(1n<<63n)-1n)
    throw Error('Valid per-process writer UUID and fencing token required');
  return {writerId:writerId.toLowerCase(),fencingToken:token};
}
function signedLeg(leg){return sizeUnits(leg.size)*(leg.side==='buy'?1n:-1n);}
function normalizedNet(net){
  if(!net||typeof net!=='object'||Array.isArray(net))throw Error('Expected net position map');
  const out={};
  for(const key of Object.keys(net).sort()){
    if(!/^[A-Z][A-Z0-9:_-]{0,31}$/.test(key))throw Error('Invalid market in net positions');
    out[key]=formatUnits(sizeUnits(net[key]));
  }
  return out;
}
function unitsFor(net,coin){return sizeUnits(net[coin]??'0');}
/** Validate that a proposed batch has a coherent source identity and net delta.
 * A trusted public snapshot and equity check must happen independently before
 * invoking this function; arbitrary user data is not authority to execute. */
export function validateStagedPortfolioPreview(preview){
  if(!preview||preview.mode!=='SHADOW_ONLY'||preview.status!=='PREVIEW_ONLY'||
      preview.executeAuthorized!==false||preview.commitAuthorized!==false)
    throw Error('Only explicitly non-executing portfolio previews can be staged');
  const vaultAddress=validateAddress(preview.vaultAddress),network=preview.network;
  if(!['mainnet','testnet'].includes(network))throw Error('Unsupported portfolio network');
  const source=preview.proposedSourceJournalRecord;
  if(source?.version!==1||source.fillKey!==preview.sourceFillKey||
     typeof source.fillKey!=='string'||source.fillKey.length>220||
     typeof source.trader!=='string'||!source.fillKey.startsWith(validateAddress(source.trader)+':')||
     !HEX64.test(source.fillDigest??'')||! /^-?\d+$/.test(source.deltaUnits??'')||
     ! /^-?\d+$/.test(source.sourceDeltaUnits??''))
    throw Error('Invalid or unverified source economic journal record');
  const before=normalizedNet(preview.expectedNetBefore),after=normalizedNet(preview.desiredNetAfter);
  if(!Array.isArray(preview.intents)||preview.intents.length>2)throw Error('Invalid portfolio leg count');
  const legs=preview.intents.map(leg=>{
    const calculated=validateIntentSpec(leg);
    if(calculated.vaultAddress!==vaultAddress||leg.intentId!==calculated.intentId||
        leg.clientOrderId!==calculated.clientOrderId||leg.mode!=='SHADOW_ONLY')
      throw Error('Portfolio leg identity does not match its signed economic spec');
    if(!['net','close-first','open-after-close'].includes(leg.phase)||
       typeof leg.requiresPriorLegConfirmation!=='boolean')
      throw Error('Missing leg phase/confirmation requirement');
    return {...calculated,phase:leg.phase,requiresPriorLegConfirmation:leg.requiresPriorLegConfirmation};
  });
  if(preview.requiresSequentialSettlement!==(legs.length===2))throw Error('Incorrect sequential settlement flag');
  if(legs.length===0){
    for(const k of new Set([...Object.keys(before),...Object.keys(after)]))
      if(unitsFor(before,k)!==unitsFor(after,k))throw Error('Unordered portfolio target change');
  }else{
    const coin=legs[0].coin;
    if(legs.some(l=>l.coin!==coin))throw Error('One source fill cannot request two unrelated markets');
    for(const k of new Set([...Object.keys(before),...Object.keys(after)]))
      if(k!==coin&&unitsFor(before,k)!==unitsFor(after,k))throw Error('Unrelated target changed in source event');
    if(unitsFor(before,coin)!==sizeUnits(legs[0].netBefore))throw Error('First portfolio leg starts at wrong net');
    if(unitsFor(after,coin)!==sizeUnits(legs.at(-1).netAfter))throw Error('Last portfolio leg ends at wrong net');
    for(let i=0;i<legs.length;i++){
      const leg=legs[i];
      if(sizeUnits(leg.netBefore)+signedLeg(leg)!==sizeUnits(leg.netAfter))throw Error('Inconsistent leg delta');
      if(i>0&&sizeUnits(legs[i-1].netAfter)!==sizeUnits(leg.netBefore))throw Error('Broken sequential leg chain');
    }
    if(legs.length===1 && (legs[0].phase!=='net'||legs[0].requiresPriorLegConfirmation))
      throw Error('Single portfolio leg cannot claim a sequential phase');
    if(legs.length===2){
      const [close,open]=legs;
      if(close.phase!=='close-first'||open.phase!=='open-after-close'||close.requiresPriorLegConfirmation||
         !open.requiresPriorLegConfirmation||unitsFor(before,coin)===0n||unitsFor(after,coin)===0n||
         (unitsFor(before,coin)>0n)===(unitsFor(after,coin)>0n)||
         sizeUnits(close.netAfter)!==0n||sizeUnits(open.netBefore)!==0n)
        throw Error('Unsafe or malformed cross-zero portfolio reversal');
    }
  }
  const canonical={vaultAddress,network,sourceFillKey:source.fillKey,
    sourceRecord:{...source},expectedNetBefore:before,desiredNetAfter:after,
    legs};
  const batchId=createHash('sha256').update('hl-vault-v2-portfolio-batch\n'+JSON.stringify(canonical)).digest('hex');
  return Object.freeze({batchId,...canonical});
}
async function transact(pool,fn){
  const client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const out=await fn(client);
    await client.query('COMMIT');return out;
  }catch(e){try{await client.query('ROLLBACK');}catch{}throw e;}
  finally{client.release();}
}
export class PgPortfolioBatchRepository {
  constructor(pool){if(!pool||typeof pool.connect!=='function')throw Error('PostgreSQL pool required');this.pool=pool;}

  async stage(preview,owner){
    const spec=validateStagedPortfolioPreview(preview);
    const {writerId,fencingToken}=checkOwner(owner);
    return transact(this.pool,async client=>{
      const lease=await client.query(`
        SELECT vault_address FROM v2_vault_writer_leases
        WHERE vault_address=$1 AND writer_id=$2 AND fencing_token=$3::bigint
          AND expires_at>clock_timestamp() FOR UPDATE`,[spec.vaultAddress,writerId,fencingToken]);
      if(lease.rows.length!==1)throw Error('Expired or foreign vault writer lease; staging denied');
      const unresolved=await client.query(`
        SELECT intent_id FROM v2_execution_intents
        WHERE vault_address=$1 AND (state->>'status')=ANY($2::text[])
        LIMIT 1`,[spec.vaultAddress,['SUBMITTING','UNKNOWN','ACKED','PARTIAL','REVIEW_REQUIRED']]);
      if(unresolved.rows.length)throw Error('Unresolved exchange order blocks portfolio staging');
      const existing=await client.query(`
        SELECT batch_id,status FROM v2_portfolio_batches
        WHERE vault_address=$1 AND source_fill_key=$2 FOR UPDATE`,[spec.vaultAddress,spec.sourceFillKey]);
      if(existing.rows.length){
        if(existing.rows.length!==1||existing.rows[0].batch_id!==spec.batchId)
          throw Error('Conflicting portfolio batch for the same source fill');
        return Object.freeze({mode:'SHADOW_ONLY',batchId:spec.batchId,status:existing.rows[0].status,
          idempotent:true,executeAuthorized:false});
      }
      const pending=await client.query(`
        SELECT batch_id FROM v2_portfolio_batches
        WHERE vault_address=$1 AND status IN ('STAGED','REVIEW_REQUIRED')
        LIMIT 1 FOR UPDATE`,[spec.vaultAddress]);
      if(pending.rows.length)throw Error('Previous source event has not been settled; portfolio frozen');
      const inserted=await client.query(`
        INSERT INTO v2_portfolio_batches
         (batch_id,vault_address,network,source_fill_key,source_record,
          expected_net_before,desired_net_after,planned_legs,status)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,'STAGED')
        ON CONFLICT DO NOTHING RETURNING batch_id,status`,[
          spec.batchId,spec.vaultAddress,spec.network,spec.sourceFillKey,
          JSON.stringify(spec.sourceRecord),JSON.stringify(spec.expectedNetBefore),
          JSON.stringify(spec.desiredNetAfter),JSON.stringify(spec.legs)
        ]);
      if(inserted.rowCount!==1)throw Error('Concurrent or conflicting portfolio batch; retry forbidden');
      // IMPORTANT: no virtual portfolio journal writes and no trade intents
      // are created here. Real settlement integration is intentionally absent.
      return Object.freeze({mode:'SHADOW_ONLY',batchId:spec.batchId,status:'STAGED',
        idempotent:false,executeAuthorized:false});
    });
  }

  /**
   * Read an exact persisted batch and reconstruct its immutable preview for
   * operator-only exchange evidence review. NO settlement or execution action.
   * Recomputes the content-addressed batch hash to detect corrupted DB data.
   */
  async readForAudit({batchId,vaultAddress}={}){
    if(typeof batchId!=='string'||!HEX64.test(batchId))throw Error('Valid 64-character batch hash required');
    const vault=validateAddress(vaultAddress);
    const rows=await this.pool.query(`
      SELECT batch_id,vault_address,network,source_fill_key,source_record,
             expected_net_before,desired_net_after,planned_legs,status
      FROM v2_portfolio_batches
      WHERE batch_id=$1 AND vault_address=$2`,[batchId,vault]);
    if(rows.rows.length!==1)throw Error('Staged batch missing or ambiguous; fail closed');
    const row=rows.rows[0];
    const json=x=>typeof x==='string'?JSON.parse(x):x;
    const legs=json(row.planned_legs);
    if(!Array.isArray(legs)||!['STAGED','REVIEW_REQUIRED','SETTLED'].includes(row.status))
      throw Error('Malformed persisted batch state');
    const p={mode:'SHADOW_ONLY',status:'PREVIEW_ONLY',batchId:row.batch_id,
      vaultAddress:row.vault_address,network:row.network,
      sourceFillKey:row.source_fill_key,proposedSourceJournalRecord:json(row.source_record),
      expectedNetBefore:json(row.expected_net_before),desiredNetAfter:json(row.desired_net_after),
      intents:legs,requiresSequentialSettlement:legs.length===2,
      executeAuthorized:false,commitAuthorized:false};
    if(validateStagedPortfolioPreview(p).batchId!==batchId)
      throw Error('Persisted batch content hash mismatch; possible corruption');
    return Object.freeze({...p,persistedStatus:row.status});
  }

  async pendingForVault(vaultAddress){
    const vault=validateAddress(vaultAddress);
    const result=await this.pool.query(`SELECT batch_id,source_fill_key,status,created_at
      FROM v2_portfolio_batches WHERE vault_address=$1 AND status IN ('STAGED','REVIEW_REQUIRED')
      ORDER BY created_at`,[vault]);
    if(result.rows.length>1)throw Error('Multiple active vault batches; fail closed');
    return result.rows.map(x=>Object.freeze({batchId:x.batch_id,sourceFillKey:x.source_fill_key,
      status:x.status,createdAt:x.created_at}));
  }
}