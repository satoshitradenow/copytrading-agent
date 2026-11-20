/**
 * Read-only, cross-batch observed Hyperliquid trade ID collision registry.
 *
 * Exchange TIDs are only observations: this NEVER proves the completeness
 * of exchange history, settles source exposure, submits/cancels an order, or
 * authorizes retry. The unique (network,vault,tid) key prevents a validated
 * observed fill from being re-attributed to another source batch or
 * silently changing fees, size, price or PnL after its first recording.
 *
 * Inserts run inside the caller's SERIALIZABLE settlement-audit transaction.
 * Do not call with unsigned arbitrary rows: derive only from recomputed
 * auditPortfolioFillEconomics() reports and validated persisted previews.
 */
import {createHash} from 'node:crypto';
import {validateStagedPortfolioPreview} from './pgPortfolioBatchRepository.mjs';
import {listValidatedPerpOrderFills} from './fillAccounting.mjs';

const digest=x=>createHash('sha256').update(x).digest('hex');
function sortedJson(x){
 if(Array.isArray(x))return x.map(sortedJson);
 if(x&&typeof x==='object'){
  const out={};
  for(const key of Object.keys(x).sort())out[key]=sortedJson(x[key]);
  return out;
 }
 return x;
}
const canonical=x=>JSON.stringify(sortedJson(x));
const economicDigest=x=>digest('hl-v2-observed-fill/v1:'+canonical(x));
const normalizeClientId=s=>{
 if(typeof s!=='string'||!/^0x[0-9a-fA-F]{32}$/.test(s))
  throw Error('Invalid client order ID in observed fill registry');
 return s.toLowerCase();
};

export function observedFillClaims({preview,legReports,report}={}){
 const spec=validateStagedPortfolioPreview(preview);
 if(preview.batchId!==spec.batchId)throw Error('Observed fill batch identity mismatch');
 if(report?.mode!=='READ_ONLY_PORTFOLIO_FILL_ECONOMICS' ||
   report.batchId!==spec.batchId||report.vaultAddress!==spec.vaultAddress||
   report.network!==spec.network||!Array.isArray(report.economicLegAudits)||
   report.economicLegAudits.length!==spec.legs.length||
   report.commitAuthorized!==false||report.executeAuthorized!==false)
  throw Error('Recomputed economic review required for exchange fill claims');
 const claimed=new Map();
 for(let i=0;i<spec.legs.length;i++){
  const leg=spec.legs[i],audit=report.economicLegAudits[i];
  if(!audit.path)continue; // Unknown/uncorroborated order cannot claim a TID
  if(!Array.isArray(legReports)||!Array.isArray(legReports[i]?.observedFills))
   throw Error('Missing raw fills for an observed economic path');
  if(audit.path.exchangeOrderId!==audit.path.economics?.exchangeOrderId ||
    !Array.isArray(audit.path.fills)||audit.path.fills.length!==audit.path.economics?.fillCount)
   throw Error('Economic path and fill count disagree');
  const records=listValidatedPerpOrderFills({
   intent:leg,exchangeOrderId:audit.path.exchangeOrderId,
   observedFills:legReports[i].observedFills
  });
  if(records.length!==audit.path.fills.length)
   throw Error('Economic review fill registry count mismatch');
  const seenPath=new Set(audit.path.fills.map(x=>x.tradeId));
  if(seenPath.size!==records.length||
    records.some(x=>!seenPath.has(x.tradeId)))
   throw Error('Economic path and registered exchange trade IDs differ');
  for(const record of records){
   if(record.exchangeOrderId!==audit.path.exchangeOrderId)
    throw Error('Economic registry order identity mismatch');
   const claim=Object.freeze({
    network:spec.network,vaultAddress:spec.vaultAddress,
    batchId:spec.batchId,clientOrderId:normalizeClientId(leg.clientOrderId),
    exchangeOrderId:record.exchangeOrderId,tradeId:record.tradeId,
    economicRecord:record,economicDigest:economicDigest(record)
   });
   if(claimed.has(claim.tradeId))
    throw Error('One exchange fill TID assigned twice in same portfolio batch');
   claimed.set(claim.tradeId,claim);
  }
 }
 if(claimed.size>2048)throw Error('Too many observed trade claims for one review');
 return Object.freeze([...claimed.values()].sort((a,b)=>
  BigInt(a.tradeId)<BigInt(b.tradeId)?-1:BigInt(a.tradeId)>BigInt(b.tradeId)?1:0));
}
const FIND=`SELECT network,vault_address,trade_id,batch_id,client_order_id,
 exchange_order_id,economic_digest,economic_record
 FROM v2_observed_exchange_fills
 WHERE network=$1 AND vault_address=$2 AND trade_id=$3 FOR UPDATE`;
const INSERT=`INSERT INTO v2_observed_exchange_fills
 (network,vault_address,trade_id,batch_id,client_order_id,exchange_order_id,
  economic_digest,economic_record)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
 ON CONFLICT DO NOTHING RETURNING trade_id`;
function comparePersisted(row,claim){
 const parse=x=>typeof x==='string'?JSON.parse(x):x;
 return row&&row.network===claim.network&&
  row.vault_address===claim.vaultAddress&&String(row.trade_id)===claim.tradeId&&
  row.batch_id===claim.batchId&&row.client_order_id===claim.clientOrderId&&
  String(row.exchange_order_id)===claim.exchangeOrderId&&
  row.economic_digest===claim.economicDigest&&
  canonical(parse(row.economic_record))===canonical(claim.economicRecord)&&
  economicDigest(parse(row.economic_record))===claim.economicDigest;
}
/** All reads/writes use the caller's transaction. Missing rows fail closed on replay. */
export async function reconcileObservedFillClaims(client,claims,{allowInsert=false}={}){
 if(!client||typeof client.query!=='function'||!Array.isArray(claims))
  throw Error('Transactional PostgreSQL review required for observed fill claims');
 let inserted=0;
 for(const claim of claims){
  const key=[claim.network,claim.vaultAddress,claim.tradeId];
  if(allowInsert){
   const result=await client.query(INSERT,[
    ...key,claim.batchId,claim.clientOrderId,claim.exchangeOrderId,
    claim.economicDigest,canonical(claim.economicRecord)]);
   if(result.rowCount===1){
    if(result.rows.length!==1||String(result.rows[0].trade_id)!==claim.tradeId)
     throw Error('Observed fill insert did not confirm the exact trade ID');
    inserted++;
   }else if(result.rowCount!==0)throw Error('Unexpected exchange fill registry insert');
  }
  const found=await client.query(FIND,key);
  if(found.rows.length!==1||!comparePersisted(found.rows[0],claim))
   throw Error('Observed exchange TID collision, changed economic fields, or missing registry record');
 }
 return Object.freeze({mode:'REVIEW_ONLY_OBSERVED_FILLS',claims:claims.length,inserted,
  settlementAuthorized:false,executeAuthorized:false,safeToResubmit:false});
}
