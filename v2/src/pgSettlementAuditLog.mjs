/**
 * SHADOW / READ-ONLY settlement audit persistence. This records observations,
 * never settles a batch, moves the source ledger, releases a reversal, signs,
 * cancels or submits an exchange order. A hash chain detects accidental
 * corruption but is NOT an authenticated exchange data source or tamperproof
 * against a database administrator; external anchoring is a future gate.
 */
import {createHash} from 'node:crypto';
import {validateAddress} from './hyperliquidRead.mjs';
import {validateStagedPortfolioPreview} from './pgPortfolioBatchRepository.mjs';
import {auditStagedPortfolioSettlement} from './settlementEvidence.mjs';
import {auditPortfolioFillEconomics} from './portfolioFillEconomics.mjs';
import {observedFillClaims,reconcileObservedFillClaims} from './pgObservedFillRegistry.mjs';

const HASH=/^[0-9a-f]{64}$/;
const ZERO='0'.repeat(64);
const MAX_EVIDENCE_BYTES=512000;
const digest=x=>createHash('sha256').update(x).digest('hex');

function jsonShape(x,depth=0){
 if(depth>35)throw Error('Audit evidence exceeds safe JSON depth');
 if(x===null||typeof x==='string'||typeof x==='boolean')return x;
 if(typeof x==='number'&&Number.isSafeInteger(x))return x;
 if(Array.isArray(x))return x.map(v=>jsonShape(v,depth+1));
 if(x&&typeof x==='object'&&(Object.getPrototypeOf(x)===Object.prototype||Object.getPrototypeOf(x)===null)){
  const out={};
  for(const key of Object.keys(x).sort()){
   if(['__proto__','constructor','prototype'].includes(key))throw Error('Unsafe audit JSON property');
   Object.defineProperty(out,key,{value:jsonShape(x[key],depth+1),enumerable:true,writable:true,configurable:true});
  }
  return out;
 }
 throw Error('Audit evidence must contain only safe JSON primitives');
}
function stableJson(x){return JSON.stringify(jsonShape(x));}
function safeClone(x){return JSON.parse(stableJson(x));}
function evidenceDigest(evidence,report){
 return digest('hl-v2-settlement-evidence/v1:'+stableJson({evidence,report}));
}
function nextChainHash(batchId,sequence,previousHash,evidenceHash){
 return digest('hl-v2-settlement-chain/v1:'+stableJson({
  batchId,sequence:String(sequence),previousHash,evidenceHash
 }));
}
function requireBatchId(x){
 if(typeof x!=='string'||!HASH.test(x))throw Error('Valid batch hash required');
 return x;
}
function fromJson(x){return typeof x==='string'?JSON.parse(x):x;}
function persistedPreview(row,batchId,vault){
 if(!row||row.batch_id!==batchId||row.vault_address!==vault||
  !['STAGED','REVIEW_REQUIRED','SETTLED'].includes(row.status))
  throw Error('Missing, mismatched or invalid persisted portfolio batch');
 const legs=fromJson(row.planned_legs);
 if(!Array.isArray(legs))throw Error('Corrupt persisted planned legs');
 const p={mode:'SHADOW_ONLY',status:'PREVIEW_ONLY',batchId,
  vaultAddress:row.vault_address,network:row.network,sourceFillKey:row.source_fill_key,
  proposedSourceJournalRecord:fromJson(row.source_record),
  expectedNetBefore:fromJson(row.expected_net_before),
  desiredNetAfter:fromJson(row.desired_net_after),
  intents:legs,requiresSequentialSettlement:legs.length===2,
  executeAuthorized:false,commitAuthorized:false};
 if(validateStagedPortfolioPreview(p).batchId!==batchId)
  throw Error('Persisted batch hash corruption; fail closed');
 return p;
}
function verifyHistory(rows,preview,batchId,vault){
 let previous=ZERO;
 const entries=[];
 for(let i=0;i<rows.length;i++){
  const row=rows[i],sequence=String(i+1);
  if(String(row.audit_seq)!==sequence||row.batch_id!==batchId||row.vault_address!==vault||
   typeof row.evidence_digest!=='string'||!HASH.test(row.evidence_digest)||
   row.previous_chain_hash!==previous||typeof row.chain_hash!=='string'||!HASH.test(row.chain_hash))
   throw Error('Settlement audit chain sequence or identity corrupt; fail closed');
  const evidence=safeClone(fromJson(row.evidence));
  const report=safeClone(fromJson(row.audit_report));
  const variant=evidence.auditVariant??'BASE_V1';
  if(!['BASE_V1','FILL_PATH_ECONOMIC_V1'].includes(variant))
   throw Error('Unknown settlement review algorithm version');
  const expectedReport=variant==='FILL_PATH_ECONOMIC_V1'
   ?auditPortfolioFillEconomics({preview,...evidence})
   :auditStagedPortfolioSettlement({preview,...evidence});
  if(stableJson(expectedReport)!==stableJson(report))
   throw Error('Stored settlement report disagrees with its saved observations');
  if(report.commitAuthorized!==false||report.executeAuthorized!==false||
   report.safeToResubmit!==false||report.requiresOperatorReview!==true)
   throw Error('Unsafe settlement review flags');
  const hash=evidenceDigest(evidence,report);
  if(hash!==row.evidence_digest)
   throw Error('Settlement audit evidence digest mismatch');
  const expectedChain=nextChainHash(batchId,sequence,previous,hash);
  if(expectedChain!==row.chain_hash)throw Error('Settlement audit chain hash mismatch');
  previous=expectedChain;
  entries.push(Object.freeze({mode:'REVIEW_ONLY',batchId,vaultAddress:vault,
   auditSeq:sequence,evidenceDigest:hash,chainHash:previous,
   evidence,report,executeAuthorized:false,commitAuthorized:false,
   safeToResubmit:false,requiresOperatorReview:true}));
 }
 return entries;
}
const BATCH_SELECT='SELECT batch_id,vault_address,network,source_fill_key,source_record,expected_net_before,desired_net_after,planned_legs,status FROM v2_portfolio_batches WHERE batch_id=$1 AND vault_address=$2';
const LOG_SELECT='SELECT batch_id,audit_seq,vault_address,evidence_digest,previous_chain_hash,chain_hash,evidence,audit_report FROM v2_settlement_audits WHERE batch_id=$1 ORDER BY audit_seq ASC';
async function verifyRegistryHistory(client,preview,entries){
 for(const item of entries){
  if(item.evidence.auditVariant!=='FILL_PATH_ECONOMIC_V1')continue;
  const claims=observedFillClaims({preview,legReports:item.evidence.legReports,report:item.report});
  await reconcileObservedFillClaims(client,claims,{allowInsert:false});
 }
}

export class PgSettlementAuditLog {
 constructor(pool){
  if(!pool||typeof pool.connect!=='function'||typeof pool.query!=='function')
   throw Error('PostgreSQL pool required');
  this.pool=pool;
 }
 /**
  * Always recompute the report from saved, caller-provided observations.
  * An audit never constitutes exchange authorization or historical completeness.
  * The batch row lock serializes concurrent audit appends across writers.
  */
 async record(args={}){return this.#record(args,'BASE_V1');}
 /** Stores the exact economic/path review alongside legacy status audits.
  * Still grants NO source settlement, exchange authority or retry permission. */
 async recordEconomics(args={}){return this.#record(args,'FILL_PATH_ECONOMIC_V1');}
 async #record({preview,initialVaultSnapshot,legReports,nowMs,maxSnapshotAgeMs=10000}={},variant){
  const spec=validateStagedPortfolioPreview(preview);
  if(preview.batchId!==spec.batchId)throw Error('Staged batch ID mismatch');
  const evidence=safeClone({...(variant==='FILL_PATH_ECONOMIC_V1'?{auditVariant:variant}:{}),
   initialVaultSnapshot,legReports,nowMs,maxSnapshotAgeMs});
  const report=safeClone(variant==='FILL_PATH_ECONOMIC_V1'
   ?auditPortfolioFillEconomics({preview,...evidence})
   :auditStagedPortfolioSettlement({preview,...evidence}));
  const packed=stableJson({evidence,report});
  if(Buffer.byteLength(packed,'utf8')>MAX_EVIDENCE_BYTES)
   throw Error('Audit evidence exceeds storage limit');
  const fingerprint=evidenceDigest(evidence,report);
  const claims=variant==='FILL_PATH_ECONOMIC_V1'
   ?observedFillClaims({preview,legReports:evidence.legReports,report}):[];
  const client=await this.pool.connect();
  try{
   await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
   const found=await client.query(BATCH_SELECT+' FOR UPDATE',[spec.batchId,spec.vaultAddress]);
   if(found.rows.length!==1)throw Error('Persisted batch missing or ambiguous; audit refused');
   const stored=persistedPreview(found.rows[0],spec.batchId,spec.vaultAddress);
   if(found.rows[0].status==='SETTLED')throw Error('Cannot append pre-settlement audit to a settled batch');
   if(validateStagedPortfolioPreview(stored).batchId!==spec.batchId)
    throw Error('Persisted batch identity changed');
   const history=await client.query(LOG_SELECT,[spec.batchId]);
   const verified=verifyHistory(history.rows,stored,spec.batchId,spec.vaultAddress);
   await verifyRegistryHistory(client,stored,verified);
   const existing=verified.find(x=>x.evidenceDigest===fingerprint);
   if(existing){
    await reconcileObservedFillClaims(client,claims,{allowInsert:false});
    await client.query('COMMIT');
    return Object.freeze({...existing,idempotent:true});
   }
   // Trade-ID claims and the audit append are all-or-nothing. A collision
   // rolls back both, including across simultaneous writer processes.
   await reconcileObservedFillClaims(client,claims,{allowInsert:true});
   const seq=String(verified.length+1),previous=verified.length?verified.at(-1).chainHash:ZERO;
   const chain=nextChainHash(spec.batchId,seq,previous,fingerprint);
   const inserted=await client.query('INSERT INTO v2_settlement_audits (batch_id,audit_seq,vault_address,evidence_digest,previous_chain_hash,chain_hash,evidence,audit_report) VALUES ($1,$2::bigint,$3,$4,$5,$6,$7::jsonb,$8::jsonb) RETURNING audit_seq',
    [spec.batchId,seq,spec.vaultAddress,fingerprint,previous,chain,stableJson(evidence),stableJson(report)]);
   if(inserted.rowCount!==1||inserted.rows.length!==1||String(inserted.rows[0].audit_seq)!==seq)
    throw Error('Durable settlement audit insert not confirmed');
   await client.query('COMMIT');
   return Object.freeze({mode:'REVIEW_ONLY',batchId:spec.batchId,
    vaultAddress:spec.vaultAddress,auditSeq:seq,evidenceDigest:fingerprint,
    chainHash:chain,evidence,report,idempotent:false,
    executeAuthorized:false,commitAuthorized:false,safeToResubmit:false,
    requiresOperatorReview:true});
  }catch(e){
   try{await client.query('ROLLBACK');}catch{}
   throw e;
  }finally{client.release();}
 }
 /** Read the entire chain and independently recompute each stored report. */
 async listForReview({batchId,vaultAddress}={}){
  const id=requireBatchId(batchId),vault=validateAddress(vaultAddress);
  const client=await this.pool.connect();
  try{
   // Single consistent PostgreSQL snapshot for batch, hash-chain, and fill
   // identities; never combine an old batch with a new audit log snapshot.
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const found=await client.query(BATCH_SELECT,[id,vault]);
   if(found.rows.length!==1)throw Error('Persisted batch missing or ambiguous; audit refused');
   const preview=persistedPreview(found.rows[0],id,vault);
   const records=await client.query(LOG_SELECT,[id]);
   const entries=verifyHistory(records.rows,preview,id,vault);
   await verifyRegistryHistory(client,preview,entries);
   await client.query('COMMIT');
   return Object.freeze(entries);
  }catch(e){try{await client.query('ROLLBACK');}catch{}throw e;}
  finally{client.release();}
 }
}
