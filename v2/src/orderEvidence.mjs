/**
 * Fail-closed, read-only evidence assessment for an uncertain vault order.
 * Produces human-readable evidence and NEVER resolves, resubmits, cancels, or
 * places an order. The exchange's `orderStatus` result alone cannot prove that
 * a partially filled or rejected order is harmless; actual fill reconciliation
 * and a complete account-state audit are required for any recovery decision.
 */
import {readVaultOrderStatus,validateAddress} from './hyperliquidRead.mjs';
import {sizeUnits,formatUnits} from './ledger.mjs';

const MARKETS=/^[A-Z][A-Z0-9:_-]{0,31}$/;
const CLOID=/^0x[0-9a-f]{32}$/;
const STATUS=new Set([
 'open','filled','canceled','triggered','rejected','marginCanceled',
 'vaultWithdrawalCanceled','openInterestCapCanceled','selfTradeCanceled',
 'reduceOnlyCanceled','siblingFilledCanceled','delistedCanceled',
 'liquidatedCanceled','scheduledCancel','tickRejected','minTradeNtlRejected',
 'perpMarginRejected','reduceOnlyRejected','badAloPxRejected',
 'iocCancelRejected','badTriggerPxRejected','marketOrderNoLiquidityRejected',
 'positionIncreaseAtOpenInterestCapRejected','positionFlipAtOpenInterestCapRejected',
 'tooAggressiveAtOpenInterestCapRejected','openInterestIncreaseRejected',
 'insufficientSpotBalanceRejected','oracleRejected','perpMaxPositionRejected'
]);
const TERMINAL=new Set([...STATUS].filter(x=>x!=='open'&&x!=='triggered'));

function positiveSize(value){
  const units=sizeUnits(value);
  if(units<=0n)throw Error('Positive decimal size required');
  return units;
}
/** Never trust an arbitrary returned order as evidence for a different intent. */
export function assessOrderStatusEvidence(intent,response){
  if(!intent || typeof intent!=='object')throw Error('Intent required');
  const vault=validateAddress(intent.vaultAddress);
  const cloid=intent.clientOrderId?.toLowerCase();
  if(!CLOID.test(cloid||''))throw Error('Invalid intended client order ID');
  if(!MARKETS.test(intent.coin||'') || !['buy','sell'].includes(intent.side) ||
      typeof intent.requiresReduceOnly!=='boolean')throw Error('Incomplete order intent');
  const expected=positiveSize(intent.size);
  if(!response || typeof response!=='object' || Array.isArray(response))throw Error('Malformed exchange response');
  const basic={mode:'READ_ONLY',vaultAddress:vault,clientOrderId:cloid,coin:intent.coin,
    expectedSize:formatUnits(expected),classification:null,exchangeStatus:null,
    exchangeOrderId:null,safeToResubmit:false,requiresOperatorReview:true};
  if(response.status==='unknownOid') {
    return Object.freeze({...basic,classification:'UNKNOWN_OID_NOT_PROOF_OF_NONEXECUTION',exchangeStatus:'unknownOid'});
  }
  if(response.status!=='order'||!response.order?.order||typeof response.order.status!=='string')
    throw Error('Malformed/unsupported orderStatus response; fail closed');
  const found=response.order.order;
  const status=response.order.status;
  if(!STATUS.has(status))throw Error('Unrecognized Hyperliquid order status; fail closed');
  if(typeof found.cloid!=='string' || found.cloid.toLowerCase()!==cloid ||
     found.coin!==intent.coin || found.side!==(intent.side==='buy'?'B':'A') ||
     positiveSize(found.origSz)!==expected || found.reduceOnly!==intent.requiresReduceOnly)
    throw Error('Order status does not match intended vault order; fail closed');
  const oid=found.oid;
  // A JavaScript number cannot safely represent all u64 order IDs. Refuse
  // unsafe rounded IDs rather than falsely correlating multiple orders.
  const orderId=typeof oid==='string' && /^[0-9]+$/.test(oid) ? oid :
    Number.isSafeInteger(oid)&&oid>=0 ? String(oid) : null;
  if(orderId===null)throw Error('Unsafe or missing exchange order ID; fail closed');
  return Object.freeze({...basic,classification:TERMINAL.has(status)?'REPORTED_TERMINAL_NEEDS_FILL_AUDIT':'ORDER_STILL_ACTIVE_OR_TRIGGERED',
    exchangeStatus:status,exchangeOrderId:orderId,statusTimestamp:response.order.statusTimestamp??null});
}

/**
 * Optional per-order fill corroboration. This is not a proof of completeness:
 * Hyperliquid fill history is retained only for a limited window, and records
 * may be delayed. Identical tid repeats are deduplicated; disagreement halts.
 */
export function summarizeObservedOrderFills({intent,exchangeOrderId,fills}){
  if(!Array.isArray(fills))throw Error('Array of observed vault fills required');
  const expected=positiveSize(intent?.size);
  if(typeof exchangeOrderId!=='string'||!/^\d+$/.test(exchangeOrderId))throw Error('Validated order ID required');
  const unique=new Map();
  for(const fill of fills){
    if(!fill || typeof fill!=='object')throw Error('Malformed observed order fill');
    const oid=typeof fill.oid==='string'?fill.oid:
      Number.isSafeInteger(fill.oid)&&fill.oid>=0?String(fill.oid):null;
    if(oid===null || !/^\d+$/.test(oid))throw Error('Unsafe or missing observed fill order ID');
    if(oid!==exchangeOrderId)continue; // Other orders are irrelevant
    const tid=typeof fill.tid==='string'?fill.tid:
      Number.isSafeInteger(fill.tid)&&fill.tid>=0?String(fill.tid):null;
    if(tid===null||!/^\d+$/.test(tid) || fill.coin!==intent.coin ||
      fill.side!==(intent.side==='buy'?'B':'A'))throw Error('Conflicting or unsafe observed order fill');
    const amount=positiveSize(fill.sz),previous=unique.get(tid);
    if(previous!==undefined && previous!==amount)throw Error('Conflicting exchange fill ID replay');
    unique.set(tid,amount);
  }
  const sum=[...unique.values()].reduce((a,b)=>a+b,0n);
  if(sum>expected)throw Error('Observed order fills exceed intended size');
  return Object.freeze({mode:'READ_ONLY',exchangeOrderId,fillCount:unique.size,
    observedFilledSize:formatUnits(sum),remainingUnverifiedSize:formatUnits(expected-sum),
    historyComplete:false,safeToResubmit:false,
    limitation:'Observed fills alone cannot prove complete history or safe retransmission'});
}

/** One convenient read-only inspection; DOES NOT transition intent state. */
export async function inspectVaultOrderEvidence(intent,options={}){
  const response=await readVaultOrderStatus(intent.vaultAddress,intent.clientOrderId,options);
  return assessOrderStatusEvidence(intent,response);
}